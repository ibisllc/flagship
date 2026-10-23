import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { dockerExec, nftExec, powerExec, restartExec, type Exec } from "./policy.js";
import { FrameReader, PRIVD_PROTOCOL_VERSION, PrivdError, encodeFrame, parseRequest, type PrivdRequest, type PrivdResponse } from "./wire.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (e: Exec) => Promise<RunResult>;

const MAX_OUTPUT = 256 * 1024;

/** Run one validated command: fixed binary, argument vector, no shell, a clean environment, bounded time and output. */
export const realRunner: Runner = (e) =>
  new Promise((resolve) => {
    const child = spawn(e.file, e.args, { stdio: [e.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, e.timeoutMs);
    child.stdout?.on("data", (d) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (e.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(e.input);
    }
  });

export interface PrivdServerOptions {
  socketPath: string;
  run?: Runner;
  auditPath?: string;
  now?: () => number;
  /** Requests per second per connection before refusal. */
  maxPerSecond?: number;
  helloTimeoutMs?: number;
}

/**
 * The root broker. It speaks only to the daemon's group over a Unix socket, answers a closed set of
 * operations, audits each one without bodies or secrets, and rate limits a runaway caller.
 */
export class PrivdServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly run: Runner;

  constructor(private readonly o: PrivdServerOptions) {
    this.run = o.run ?? realRunner;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.o.socketPath), { recursive: true, mode: 0o750 });
    if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath);
    const server = createServer((s) => this.onConnection(s));
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.socketPath, () => resolve());
    });
    chmodSync(this.o.socketPath, 0o660);
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath);
  }

  private audit(rec: Record<string, unknown>): void {
    if (!this.o.auditPath) return;
    try {
      appendFileSync(this.o.auditPath, JSON.stringify({ t: (this.o.now ?? Date.now)(), ...rec }) + "\n", { mode: 0o640 });
    } catch {
      /* an audit failure never blocks power-off or a revocation the box needs */
    }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    const reader = new FrameReader();
    let hello = false;
    let window = { start: Date.now(), n: 0 };
    const timer = setTimeout(() => socket.destroy(), this.o.helloTimeoutMs ?? 5000);
    timer.unref?.();
    const send = (r: PrivdResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(r));
    };
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", async (chunk) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of frames) {
        let req: PrivdRequest;
        try {
          req = parseRequest(raw);
        } catch (e) {
          const id = typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : 0;
          send({ id, ok: false, code: e instanceof PrivdError ? e.code : "bad-request", message: (e as Error).message });
          continue;
        }
        const now = Date.now();
        if (now - window.start > 1000) window = { start: now, n: 0 };
        if (++window.n > (this.o.maxPerSecond ?? 20)) {
          send({ id: req.id, ok: false, code: "forbidden", message: "slow down" });
          continue;
        }
        if (req.op === "hello") {
          if (req.args.version !== PRIVD_PROTOCOL_VERSION) {
            send({ id: req.id, ok: false, code: "unsupported-version", message: "this broker speaks version 1 only" });
            socket.destroy();
            return;
          }
          hello = true;
          clearTimeout(timer);
          send({ id: req.id, ok: true, result: { version: PRIVD_PROTOCOL_VERSION } });
          continue;
        }
        if (!hello) {
          send({ id: req.id, ok: false, code: "not-hello", message: "say hello first" });
          continue;
        }
        send(await this.handle(req));
      }
    });
  }

  private async handle(req: PrivdRequest): Promise<PrivdResponse> {
    let exec: Exec;
    try {
      exec = req.op === "power" ? powerExec(req.args) : req.op === "systemd.restart" ? restartExec(req.args) : req.op === "docker" ? dockerExec(req.args) : nftExec(req.args);
    } catch (e) {
      const code = e instanceof PrivdError ? e.code : "bad-request";
      this.audit({ op: req.op, ok: false, code, what: summary(req) });
      return { id: req.id, ok: false, code, message: (e as Error).message };
    }
    const r = await this.run(exec);
    this.audit({ op: req.op, ok: r.code === 0, exit: r.code, timedOut: r.timedOut, what: summary(req) });
    if (r.timedOut) return { id: req.id, ok: false, code: "timed-out", message: "the command ran too long and was stopped" };
    if (r.code !== 0) return { id: req.id, ok: false, code: "failed", message: `exited with code ${r.code}: ${r.stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 600)}` };
    return { id: req.id, ok: true, result: { stdout: r.stdout, stderr: r.stderr } };
  }
}

/** A line for the audit log: what was asked, never the bodies or secrets that came with it. */
function summary(req: PrivdRequest): string {
  if (req.op === "docker" && Array.isArray(req.args.argv)) return (req.args.argv as string[]).slice(0, 3).join(" ");
  if (req.op === "nft.apply") return "nft script";
  return JSON.stringify(req.args).slice(0, 120);
}
