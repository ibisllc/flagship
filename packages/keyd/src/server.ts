import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket as NetSocket, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_RATE_LIMITS, RateLimiter } from "./policy.js";
import { KeydService, type KeyStore } from "./service.js";
import {
  FrameReader,
  KeydError,
  encodeFrame,
  parseRequest,
  type KeydErrorCode,
  type KeydResponse,
} from "./wire.js";

export interface KeydServerOptions {
  socketPath: string;
  service: KeydService;
  /** Append-only, non-secret audit log (operation, caller, result, time). */
  auditPath?: string;
  /** Rotate the audit file at this size (the previous one is kept once). */
  auditMaxBytes?: number;
  rateLimits?: Record<string, { perSecond: number; burst: number }>;
  now?: () => number;
  /** Concurrent connections allowed. */
  maxConnections?: number;
  /** Close a connection that has not said hello within this long. */
  helloTimeoutMs?: number;
}

/**
 * The AF_UNIX server. No network listener, no HTTP, no file-reading operation. A connection
 * must say hello (version negotiation) before anything else; a request is parsed strictly,
 * rate limited, answered and audited. The socket is created owner-only; the unit and the
 * installer give the daemon's group access to the directory, nobody else.
 */
export class KeydServer {
  private server: Server | null = null;
  private readonly limiter: RateLimiter;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: KeydServerOptions) {
    this.limiter = new RateLimiter(opts.rateLimits ?? DEFAULT_RATE_LIMITS, opts.now);
  }

  async start(): Promise<void> {
    const { socketPath } = this.opts;
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
    // A stale socket from a crashed run is removed; a live one means another keyd is up.
    if (existsSync(socketPath)) {
      const live = await new Promise<boolean>((resolve) => {
        const probe = new NetSocket();
        probe.once("connect", () => (probe.destroy(), resolve(true)));
        probe.once("error", () => resolve(false));
        probe.connect(socketPath);
      });
      if (live) throw new Error(`keyd is already running on ${socketPath}`);
      unlinkSync(socketPath);
    }
    const server = createServer((s) => this.onConnection(s));
    server.maxConnections = this.opts.maxConnections ?? 32;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o660);
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath);
      } catch {
        /* already gone */
      }
    }
    this.opts.service.destroy();
  }

  private audit(rec: { op: string; component: string; ok: boolean; code?: KeydErrorCode; purpose?: string }): void {
    const path = this.opts.auditPath;
    if (!path) return;
    try {
      const max = this.opts.auditMaxBytes ?? 8 * 1024 * 1024;
      if (existsSync(path) && statSync(path).size > max) renameSync(path, `${path}.1`);
      appendFileSync(path, JSON.stringify({ t: (this.opts.now ?? Date.now)(), key: this.opts.service.publicKeyHex.slice(0, 16), ...rec }) + "\n", { mode: 0o640 });
    } catch {
      /* an audit write failure never blocks a signature the box needs to stay up */
    }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    const reader = new FrameReader();
    let component: string | null = null;
    const hello = setTimeout(() => socket.destroy(), this.opts.helloTimeoutMs ?? 5000);
    hello.unref?.();
    const send = (r: KeydResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(r));
    };
    socket.on("close", () => {
      clearTimeout(hello);
      this.sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        // A malformed or oversize frame ends the connection; there is no resync.
        socket.destroy();
        return;
      }
      for (const raw of frames) {
        let id = 0;
        let op = "?";
        try {
          const req = parseRequest(raw);
          id = req.id;
          op = req.op;
          if (component === null && req.op !== "hello") throw new KeydError("not-hello", "say hello first");
          if (!this.limiter.take(req.op)) throw new KeydError("rate-limited", "too many requests");
          const out = this.opts.service.handle(req);
          if (req.op === "hello") {
            component = String(req.args.component);
            clearTimeout(hello);
          }
          this.audit({ op, component: component ?? "-", ok: true, ...(out.purpose ? { purpose: out.purpose } : {}) });
          send({ id, ok: true, result: out.result });
        } catch (e) {
          const err = e instanceof KeydError ? e : new KeydError("failed", "internal error");
          this.audit({ op, component: component ?? "-", ok: false, code: err.code });
          send({ id, ok: false, code: err.code, message: err.message });
          if (err.code === "unsupported-version") socket.end();
        }
      }
    });
  }
}

/** File-backed key store: each secret is a 0400 hex file in the keyd state directory. */
export function fileKeyStore(dir: string): KeyStore {
  return {
    save(name, bytes) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const final = join(dir, `${name}.key`);
      const tmp = `${final}.tmp`;
      writeFileSync(tmp, Buffer.from(bytes).toString("hex") + "\n", { mode: 0o400 });
      renameSync(tmp, final);
    },
  };
}

export function readKeyFile(path: string): Uint8Array | undefined {
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) throw new Error(`${path} must not be readable by group or others`);
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${path} is not a 32-byte hex key`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
