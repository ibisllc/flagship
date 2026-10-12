import {
  FRAME_OUTBOUND_CREDIT,
  FRAME_OUTBOUND_OPEN,
  FRAME_OUTBOUND_RESULT,
  type Frame,
} from "./frames.js";

/**
 * Box-initiated outbound streams: the box asks the hub to open a TCP
 * connection to `host:port` and carries an opaque byte stream over it (in
 * practice a TLS session the box runs end to end with an AI provider, so the
 * hub sees only the host, timing and size). docs/ai-privacy-and-staging.md §4.
 *
 *   box → hub  OUTBOUND_OPEN   {host, port}            stream id in the box space
 *   hub → box  OUTBOUND_RESULT {ok, reason?}           once per open
 *   both       DATA            raw bytes               consumes the peer's credit
 *   both       OUTBOUND_CREDIT u32 BE byte count       grants the peer more credit
 *   box → hub  CLOSE           box is done
 *   hub → box  CLOSE_REMOTE    upstream closed (after all its data)
 *
 * Flow control: each direction starts with OUTBOUND_INITIAL_WINDOW bytes of
 * credit; a sender never has more unacknowledged DATA in flight than its
 * credit, and a receiver grants credit back only as its sink drains. That
 * bounds memory on both ends without stalling the shared WebSocket.
 *
 * Stream ids: the hub numbers the streams it opens (FRAME_OPEN) from 1 and
 * stays below OUTBOUND_STREAM_ID_BASE; the box numbers its outbound streams
 * from OUTBOUND_STREAM_ID_BASE + 1, so the two spaces never collide.
 */

export const OUTBOUND_STREAM_ID_BASE = 0x8000_0000;
export const OUTBOUND_STREAM_ID_MAX = 0xffff_ffff;
export const OUTBOUND_INITIAL_WINDOW = 256 * 1024;
/** Largest DATA payload either side sends on an outbound stream. */
export const OUTBOUND_MAX_CHUNK = 64 * 1024;

export function isOutboundStreamId(streamId: number): boolean {
  return streamId >= OUTBOUND_STREAM_ID_BASE && streamId <= OUTBOUND_STREAM_ID_MAX;
}

/**
 * Why a hub refused (or lost) an outbound open. Codes only: the hub never
 * echoes content back, and the box turns these into owner-facing wording.
 */
export type OutboundRefusal =
  | "bad-request"
  | "forbidden-port"
  | "forbidden-host"
  | "forbidden-address"
  | "dns-failed"
  | "connect-failed"
  | "too-many-streams"
  | "rate-limited"
  | "duplicate-stream"
  | "disabled";

const REFUSALS: ReadonlySet<string> = new Set<OutboundRefusal>([
  "bad-request",
  "forbidden-port",
  "forbidden-host",
  "forbidden-address",
  "dns-failed",
  "connect-failed",
  "too-many-streams",
  "rate-limited",
  "duplicate-stream",
  "disabled",
]);

export interface OutboundOpenPayload {
  host: string;
  port: number;
}

export interface OutboundResultPayload {
  ok: boolean;
  reason?: OutboundRefusal;
}

export function outboundOpenFrame(streamId: number, p: OutboundOpenPayload): Frame {
  if (!isOutboundStreamId(streamId)) throw new Error("outbound stream id outside the box space");
  return {
    streamId,
    type: FRAME_OUTBOUND_OPEN,
    payload: new TextEncoder().encode(JSON.stringify({ host: p.host, port: p.port })),
  };
}

export function parseOutboundOpen(payload: Uint8Array): OutboundOpenPayload | null {
  const o = parseJsonObject(payload);
  if (!o) return null;
  if (typeof o.host !== "string" || o.host.length === 0 || o.host.length > 253) return null;
  if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    return null;
  }
  return { host: o.host, port: o.port };
}

export function outboundResultFrame(streamId: number, p: OutboundResultPayload): Frame {
  const body: OutboundResultPayload = { ok: p.ok };
  if (!p.ok && p.reason) body.reason = p.reason;
  return {
    streamId,
    type: FRAME_OUTBOUND_RESULT,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export function parseOutboundResult(payload: Uint8Array): OutboundResultPayload | null {
  const o = parseJsonObject(payload);
  if (!o || typeof o.ok !== "boolean") return null;
  const out: OutboundResultPayload = { ok: o.ok };
  if (!o.ok) {
    out.reason = typeof o.reason === "string" && REFUSALS.has(o.reason)
      ? (o.reason as OutboundRefusal)
      : "connect-failed";
  }
  return out;
}

export function outboundCreditFrame(streamId: number, bytes: number): Frame {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 0xffff_ffff) {
    throw new Error("credit must be a positive u32");
  }
  const payload = new Uint8Array(4);
  payload[0] = (bytes >>> 24) & 0xff;
  payload[1] = (bytes >>> 16) & 0xff;
  payload[2] = (bytes >>> 8) & 0xff;
  payload[3] = bytes & 0xff;
  return { streamId, type: FRAME_OUTBOUND_CREDIT, payload };
}

/** The granted byte count, or null for a malformed credit payload. */
export function parseOutboundCredit(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null;
  const n =
    ((payload[0]! << 24) >>> 0) + (payload[1]! << 16) + (payload[2]! << 8) + payload[3]!;
  return n > 0 ? n : null;
}

function parseJsonObject(payload: Uint8Array): Record<string, unknown> | null {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}
