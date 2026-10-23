/**
 * flagship-privd wire protocol, version 1 (SECURITY-HARDENING-PLAN.md SEC-DAEMON-001).
 *
 * The general daemon runs as an ordinary user. The few things that need root (stopping the machine,
 * restarting a named unit, talking to Docker, loading the box's own firewall table) go to this small
 * broker over an AF_UNIX socket as a CLOSED set of typed operations. There is no "run this command":
 * each operation has its own validator, and what a validator does not recognise it refuses.
 */
export const PRIVD_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

export const OPS = ["hello", "power", "systemd.restart", "docker", "nft.apply"] as const;
export type Op = (typeof OPS)[number];

export interface PrivdRequest {
  id: number;
  op: Op;
  args: Record<string, unknown>;
}

export type PrivdResponse =
  | { id: number; ok: true; result: { stdout?: string; stderr?: string } & Record<string, unknown> }
  | { id: number; ok: false; code: PrivdErrorCode; message: string };

export type PrivdErrorCode = "bad-frame" | "bad-request" | "unknown-op" | "not-hello" | "unsupported-version" | "forbidden" | "failed" | "timed-out";

export class PrivdError extends Error {
  constructor(
    readonly code: PrivdErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrivdError";
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new PrivdError("bad-frame", "frame too large");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) throw new PrivdError("bad-frame", "frame length out of range");
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new PrivdError("bad-frame", "frame is not JSON");
      }
    }
    return out;
  }
}

export function parseRequest(v: unknown): PrivdRequest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PrivdError("bad-request", "request must be an object");
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "id" && k !== "op" && k !== "args") throw new PrivdError("bad-request", `unknown field ${k}`);
  if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 0) throw new PrivdError("bad-request", "bad id");
  if (typeof r.op !== "string" || !(OPS as readonly string[]).includes(r.op)) throw new PrivdError("unknown-op", "unknown operation");
  const args = r.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new PrivdError("bad-request", "args must be an object");
  return { id: r.id, op: r.op as Op, args: args as Record<string, unknown> };
}
