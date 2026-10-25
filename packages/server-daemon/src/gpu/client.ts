/**
 * The daemon's side of flagship-gpud's socket (rust/crates/flagship-gpu, `service.rs`): privd's
 * framing (a 4-byte big-endian length, then JSON), `hello` first, one short connection per call.
 * The kernel's peer credentials, not anything sent here, decide who may call.
 */
import { Socket } from "node:net";
import { existsSync } from "node:fs";

export const GPUD_SOCKET = "/run/flagship-gpu/gpu.sock";
const MAX_FRAME = 1 << 20;

export class GpudError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GpudError";
  }
}

function frame(v: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(v), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export type GpudCall = (op: string, args?: Record<string, unknown>) => Promise<unknown>;

export function gpudClient(socketPath = GPUD_SOCKET, timeoutMs = 60_000): GpudCall {
  return (op, args = {}) =>
    new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = Buffer.alloc(0);
      const replies = new Map<number, { ok: boolean; result?: unknown; code?: string; message?: string }>();
      const t = setTimeout(() => {
        s.destroy();
        reject(new GpudError("timed-out", "the GPU service did not answer in time"));
      }, timeoutMs);
      t.unref?.();
      const done = (e: Error | null, v?: unknown) => {
        clearTimeout(t);
        s.destroy();
        if (e) reject(e);
        else resolve(v);
      };
      s.on("error", () => done(new GpudError("unavailable", "the GPU service is not running on this server")));
      s.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const n = buf.readUInt32BE(0);
          if (n === 0 || n > MAX_FRAME) return done(new GpudError("failed", "bad frame from the GPU service"));
          if (buf.length < 4 + n) break;
          const r = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
          replies.set(r.id, r);
          buf = buf.subarray(4 + n);
        }
        const hello = replies.get(1);
        if (hello && !hello.ok) return done(new GpudError(hello.code ?? "failed", hello.message ?? "hello refused"));
        const r = replies.get(2);
        if (r) return r.ok ? done(null, r.result) : done(new GpudError(r.code ?? "failed", r.message ?? `${op} refused`));
      });
      s.connect(socketPath, () => {
        s.write(frame({ id: 1, op: "hello", args: { version: 1 } }));
        s.write(frame({ id: 2, op, args }));
      });
    });
}

export function gpudInstalled(socketPath = GPUD_SOCKET): boolean {
  return existsSync(socketPath);
}
