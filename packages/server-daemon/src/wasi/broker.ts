/**
 * The daemon's side of a WASI app's host calls (docs/wasi-apps.md
 * "Capability SDK"). One Unix socket per app, in that app's own folder,
 * which only that app's worker can see (wasi/unit.ts): which app is asking
 * is the socket, never anything the guest wrote.
 *
 * One JSON line in, one JSON line out:
 *   {"op":"hello"}                          → the app's start-up variables (owner env); never on disk
 *   {"op":"http_fetch","request":{...}}     → needs network.egress; the owner's access list decides
 *   {"op":"db_query","request":{...}}       → needs data.stores.postgres; runs as the app's own role
 *
 * Every refusal is `{"ok":false,"code":"denied",...}` with a sentence the
 * app (and, after the model redactor, an AI) may read.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";

export class CapabilityDenied extends Error {}

export interface CapabilityHandlers {
  hello(serviceId: string): Promise<Record<string, string>>;
  httpFetch(serviceId: string, request: unknown, deadlineMs: number): Promise<unknown>;
  dbQuery(serviceId: string, request: unknown, deadlineMs: number): Promise<unknown>;
}

const MAX_LINE = 2 * 1024 * 1024;
const CALL_DEADLINE_MS = 30_000;

export class WasiCapabilityBroker {
  private readonly servers = new Map<string, { server: Server; path: string }>();

  constructor(
    private readonly handlers: CapabilityHandlers,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Listen on `socketPath` for `serviceId`'s worker (replacing an earlier socket). */
  async open(serviceId: string, socketPath: string): Promise<void> {
    await this.close(serviceId);
    await rm(socketPath, { force: true });
    const server = createServer((sock) => this.serve(serviceId, sock));
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The worker's dynamic user connects; only its own namespace can see this folder.
    await chmod(socketPath, 0o666);
    this.servers.set(serviceId, { server, path: socketPath });
  }

  async close(serviceId: string): Promise<void> {
    const s = this.servers.get(serviceId);
    if (!s) return;
    this.servers.delete(serviceId);
    await new Promise<void>((r) => s.server.close(() => r()));
    await rm(s.path, { force: true }).catch(() => {});
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.servers.keys()]) await this.close(id);
  }

  private serve(serviceId: string, sock: Socket): void {
    let buf = Buffer.alloc(0);
    let done = false;
    sock.setTimeout(CALL_DEADLINE_MS + 5000, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_LINE) {
        done = true;
        this.reply(sock, { ok: false, code: "denied", error: "request too large" });
        return;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      done = true;
      const line = buf.subarray(0, nl).toString("utf8");
      void this.answer(serviceId, line).then((a) => this.reply(sock, a));
    });
  }

  private reply(sock: Socket, a: unknown): void {
    if (sock.destroyed) return;
    sock.end(`${JSON.stringify(a)}\n`);
  }

  /** Exposed for tests: the answer to one request line. */
  async answer(serviceId: string, line: string): Promise<{ ok: true; result: unknown } | { ok: false; code: string; error: string }> {
    let req: { op?: unknown; request?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return { ok: false, code: "failed", error: "the request is not JSON" };
    }
    try {
      switch (req.op) {
        case "hello":
          return { ok: true, result: { env: await this.handlers.hello(serviceId) } };
        case "http_fetch":
          return { ok: true, result: await this.handlers.httpFetch(serviceId, req.request, Date.now() + CALL_DEADLINE_MS) };
        case "db_query":
          return { ok: true, result: await this.handlers.dbQuery(serviceId, req.request, Date.now() + CALL_DEADLINE_MS) };
        default:
          return { ok: false, code: "denied", error: "no such host call" };
      }
    } catch (e) {
      if (e instanceof CapabilityDenied) {
        this.log(`[wasi] ${serviceId}: ${String(req.op)} refused: ${e.message}`);
        return { ok: false, code: "denied", error: e.message };
      }
      const msg = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
      return { ok: false, code: msg === "timed out" ? "timeout" : "failed", error: msg.slice(0, 500) };
    }
  }
}
