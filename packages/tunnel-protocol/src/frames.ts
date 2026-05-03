/**
 * Binary frame protocol for multiplexing TCP streams over a single
 * WebSocket / HTTP/2 / QUIC tunnel.
 *
 * Wire format (big-endian):
 *
 *   uint32  streamId
 *   uint8   type
 *   uint32  payloadLen
 *   bytes[] payload
 *
 * StreamId 0 is reserved for control messages (HELLO / HELLO_ACK).
 * StreamIds > 0 represent individual TCP connections being multiplexed.
 */

export const FRAME_HELLO = 0x10;
export const FRAME_HELLO_ACK = 0x11;
export const FRAME_OPEN = 0x01;
export const FRAME_DATA = 0x02;
export const FRAME_CLOSE = 0x03;
export const FRAME_CLOSE_REMOTE = 0x04;

export type FrameType =
  | typeof FRAME_HELLO
  | typeof FRAME_HELLO_ACK
  | typeof FRAME_OPEN
  | typeof FRAME_DATA
  | typeof FRAME_CLOSE
  | typeof FRAME_CLOSE_REMOTE;

export interface Frame {
  streamId: number;
  type: FrameType;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 9;
export const MAX_FRAME_PAYLOAD = 1 << 20; // 1 MiB

export function encodeFrame(frame: Frame): Uint8Array {
  const len = frame.payload.length;
  if (len > MAX_FRAME_PAYLOAD) throw new Error(`frame payload exceeds ${MAX_FRAME_PAYLOAD} bytes`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + len);
  writeU32BE(out, 0, frame.streamId);
  out[4] = frame.type;
  writeU32BE(out, 5, len);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

export type DecodeResult =
  | { kind: "ok"; frame: Frame; consumed: number }
  | { kind: "incomplete"; needAtLeast: number }
  | { kind: "error"; reason: string };

export function decodeFrame(buf: Uint8Array): DecodeResult {
  if (buf.length < FRAME_HEADER_BYTES) {
    return { kind: "incomplete", needAtLeast: FRAME_HEADER_BYTES };
  }
  const streamId = readU32BE(buf, 0);
  const type = buf[4]!;
  if (!isFrameType(type)) {
    return { kind: "error", reason: `unknown frame type 0x${type.toString(16)}` };
  }
  const payloadLen = readU32BE(buf, 5);
  if (payloadLen > MAX_FRAME_PAYLOAD) {
    return { kind: "error", reason: `payload length ${payloadLen} exceeds max ${MAX_FRAME_PAYLOAD}` };
  }
  const total = FRAME_HEADER_BYTES + payloadLen;
  if (buf.length < total) {
    return { kind: "incomplete", needAtLeast: total };
  }
  return {
    kind: "ok",
    frame: {
      streamId,
      type,
      payload: buf.subarray(FRAME_HEADER_BYTES, total),
    },
    consumed: total,
  };
}

function isFrameType(t: number): t is FrameType {
  return (
    t === FRAME_HELLO ||
    t === FRAME_HELLO_ACK ||
    t === FRAME_OPEN ||
    t === FRAME_DATA ||
    t === FRAME_CLOSE ||
    t === FRAME_CLOSE_REMOTE
  );
}

function writeU32BE(buf: Uint8Array, offset: number, v: number): void {
  if (v < 0 || v > 0xffffffff) throw new Error("u32 out of range");
  buf[offset] = (v >>> 24) & 0xff;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) >>> 0) +
    (buf[offset + 1]! << 16) +
    (buf[offset + 2]! << 8) +
    buf[offset + 3]!
  );
}

/**
 * Convenience helpers for building specific frames.
 */
export function helloFrame(payload: { serverId: string; subdomains: string[] }): Frame {
  return {
    streamId: 0,
    type: FRAME_HELLO,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

export function helloAckFrame(ok: boolean, reason?: string): Frame {
  return {
    streamId: 0,
    type: FRAME_HELLO_ACK,
    payload: new TextEncoder().encode(JSON.stringify({ ok, reason })),
  };
}

export function openFrame(streamId: number, sni: string): Frame {
  return {
    streamId,
    type: FRAME_OPEN,
    payload: new TextEncoder().encode(sni),
  };
}

export function dataFrame(streamId: number, data: Uint8Array): Frame {
  return { streamId, type: FRAME_DATA, payload: data };
}

export function closeFrame(streamId: number, remote = false): Frame {
  return {
    streamId,
    type: remote ? FRAME_CLOSE_REMOTE : FRAME_CLOSE,
    payload: new Uint8Array(0),
  };
}
