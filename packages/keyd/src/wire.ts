/**
 * flagship-keyd wire protocol, version 1 (SECURITY-HARDENING-PLAN.md 5.1).
 *
 * A request and a response are each one frame: a 4-byte big-endian length, then that many
 * bytes of UTF-8 JSON. Byte strings travel as lowercase hex. Frames are size-limited
 * before they are buffered, unknown operations and unknown fields are refused, and a
 * client that asks for a version this daemon does not speak is refused outright (it never
 * falls back to an older or broader behavior).
 */

export const KEYD_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Every operation keyd answers. Each is purpose-specific; there is no "sign these bytes" for an untagged message. */
export const OPS = [
  "hello",
  "status",
  "sign",
  "unseal",
  "swk.hkdf",
  "swk.seal",
  "swk.open",
  "swk.encryptChunk",
  "swk.decryptChunk",
  "swk.deriveServiceSecret",
  "swk.deriveTlsKey",
  "swk.deriveBackupManifestKey",
  "cgk.seal",
  "cgk.open",
  "cgk.deriveAppCopyEnvKey",
  "provision.swk",
  "provision.cgk",
] as const;
export type Op = (typeof OPS)[number];

export interface KeydRequest {
  id: number;
  op: Op;
  args: Record<string, unknown>;
}

export type KeydResponse =
  | { id: number; ok: true; result: Record<string, unknown> }
  | { id: number; ok: false; code: KeydErrorCode; message: string };

export type KeydErrorCode =
  | "bad-frame"
  | "bad-request"
  | "unknown-op"
  | "unsupported-version"
  | "not-hello"
  | "forbidden"
  | "rate-limited"
  | "not-provisioned"
  | "failed";

export class KeydError extends Error {
  constructor(
    readonly code: KeydErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeydError";
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new KeydError("bad-frame", "frame too large");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** Incremental frame reader; refuses an oversize length before buffering the body. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) throw new KeydError("bad-frame", "frame length out of range");
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new KeydError("bad-frame", "frame is not JSON");
      }
    }
    return out;
  }
}

const HEX = /^(?:[0-9a-f]{2})*$/;

export function hexArg(args: Record<string, unknown>, name: string, opts: { min?: number; max?: number; exact?: number } = {}): Uint8Array {
  const v = args[name];
  if (typeof v !== "string" || !HEX.test(v)) throw new KeydError("bad-request", `${name} must be lowercase hex`);
  const n = v.length / 2;
  if (opts.exact !== undefined && n !== opts.exact) throw new KeydError("bad-request", `${name} must be ${opts.exact} bytes`);
  if (opts.min !== undefined && n < opts.min) throw new KeydError("bad-request", `${name} is too short`);
  if (opts.max !== undefined && n > opts.max) throw new KeydError("bad-request", `${name} is too long`);
  return Uint8Array.from(Buffer.from(v, "hex"));
}

export function strArg(args: Record<string, unknown>, name: string, max = 256): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0 || v.length > max || /[\u0000-\u001f]/.test(v)) {
    throw new KeydError("bad-request", `${name} must be a short string`);
  }
  return v;
}

export function noExtraArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new KeydError("bad-request", `unknown field ${k}`);
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function parseRequest(v: unknown): KeydRequest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new KeydError("bad-request", "request must be an object");
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "id" && k !== "op" && k !== "args") throw new KeydError("bad-request", `unknown field ${k}`);
  if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 0) throw new KeydError("bad-request", "bad id");
  if (typeof r.op !== "string") throw new KeydError("bad-request", "bad op");
  if (!(OPS as readonly string[]).includes(r.op)) throw new KeydError("unknown-op", "unknown operation");
  const args = r.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new KeydError("bad-request", "args must be an object");
  return { id: r.id, op: r.op as Op, args: args as Record<string, unknown> };
}
