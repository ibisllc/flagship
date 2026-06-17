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
/**
 * Hub-to-tunnel broadcast: a domain has been granted (or transferred)
 * to a tunnel. Sent to ALL currently-connected tunnels — including the
 * new owner — so nothing changes silently. Apps observing this through
 * the daemon's `/api/live_siblings/poll` event stream can compare
 * `ownerServerId` against their pod's canonical FQDN to decide if
 * they're the new holder, an old holder who just lost it, or simply
 * tracking ownership in their user's zone.
 */
export const FRAME_DOMAIN_GRANTED = 0x12;
/**
 * Pod → hub: "transfer ownership of <fqdn> to me." The hub validates
 * the pod has a derivable claim (via the cert presented at HELLO)
 * and atomically reassigns. On success, the resulting snapshot is
 * broadcast to every member of the affected set via FRAME_DOMAIN_GRANTED.
 */
export const FRAME_REQUEST_TRANSFER = 0x13;
export const FRAME_OPEN = 0x01;
export const FRAME_DATA = 0x02;
export const FRAME_CLOSE = 0x03;
export const FRAME_CLOSE_REMOTE = 0x04;

/**
 * Hub → tunnel: "I'm about to go away. Reconnect now."
 *
 * Sent by the SNI router when its Fly machine receives a shutdown
 * signal (rolling deploy, scale-down). Payload is JSON
 * `{ graceMs: number }`. Daemons handle by:
 *   1. Opening a second tunnel to wss://flagship-services… (DNS
 *      round-robin lands on a different machine).
 *   2. Re-sending HELLO with the same identity + AppGrants on the
 *      new connection.
 *   3. Migrating in-flight streams via FRAME_DATA on the new tunnel
 *      (best-effort; long-lived streams that can't migrate get
 *      FRAME_CLOSE_REMOTE through the old tunnel).
 *   4. Closing the old WS once migration is acknowledged.
 *
 * Combined with min_machines_running = 2 in fly.toml and the reconnect
 * supervisor (#7), rolling deploys are invisible to traffic.
 */
export const FRAME_DRAIN_NOTICE = 0x05;

// Peer-backup frames (RFC: roadmap.md §1)
export const FRAME_PB_PUT = 0x20;
export const FRAME_PB_PUT_ACK = 0x21;
export const FRAME_PB_GET = 0x22;
export const FRAME_PB_GET_DATA = 0x23;
export const FRAME_PB_GET_END = 0x24;
export const FRAME_PB_CHALLENGE = 0x30;
export const FRAME_PB_RESPONSE = 0x31;

export type FrameType =
  | typeof FRAME_HELLO
  | typeof FRAME_HELLO_ACK
  | typeof FRAME_DOMAIN_GRANTED
  | typeof FRAME_REQUEST_TRANSFER
  | typeof FRAME_OPEN
  | typeof FRAME_DATA
  | typeof FRAME_CLOSE
  | typeof FRAME_CLOSE_REMOTE
  | typeof FRAME_DRAIN_NOTICE
  | typeof FRAME_PB_PUT
  | typeof FRAME_PB_PUT_ACK
  | typeof FRAME_PB_GET
  | typeof FRAME_PB_GET_DATA
  | typeof FRAME_PB_GET_END
  | typeof FRAME_PB_CHALLENGE
  | typeof FRAME_PB_RESPONSE;

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
    t === FRAME_DOMAIN_GRANTED ||
    t === FRAME_REQUEST_TRANSFER ||
    t === FRAME_OPEN ||
    t === FRAME_DATA ||
    t === FRAME_CLOSE ||
    t === FRAME_CLOSE_REMOTE ||
    t === FRAME_PB_PUT ||
    t === FRAME_PB_PUT_ACK ||
    t === FRAME_PB_GET ||
    t === FRAME_PB_GET_DATA ||
    t === FRAME_PB_GET_END ||
    t === FRAME_PB_CHALLENGE ||
    t === FRAME_PB_RESPONSE
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
export function helloFrame(payload: {
  serverId: string;
  controlledDomains: string[];
}): Frame {
  return {
    streamId: 0,
    type: FRAME_HELLO,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

/**
 * Optional maintainer-trust attachment carried on HELLO_ACK (relay-trust
 * wiring, docs/maintainer-trust-enforcement.md § "The relay blessing").
 *
 * The hub attaches:
 *   - `serviceBlessing` — the `.com`-CA-signed ServiceBlessing over the
 *     hub's self-generated key (opaque envelope JSON; the box verifies it
 *     against the baked maintainer pin).
 *   - `hubSig` — the hub's Ed25519 signature, made with the blessed key,
 *     over the box's HELLO nonce. Proof-of-possession: it shows the hub
 *     actually holds the blessed key, so a MITM cannot replay a blessing
 *     it merely observed.
 *
 * BACKWARD COMPATIBLE: both fields are optional. An old hub omits them and
 * an old box ignores them; a new box treats their absence as "no verdict"
 * (OBSERVE-safe — never bricks the relay).
 */
export interface HelloAckTrust {
  /** The ServiceBlessing envelope, verbatim JSON (lower-hex fields). */
  serviceBlessing?: unknown;
  /**
   * lower-hex Ed25519 signature over the box's HELLO nonce, signed with
   * the blessing's `hubKeyPub`.
   */
  hubSig?: string;
}

export function helloAckFrame(
  ok: boolean,
  reason?: string,
  trust?: HelloAckTrust,
): Frame {
  const body: {
    ok: boolean;
    reason?: string;
    serviceBlessing?: unknown;
    hubSig?: string;
  } = { ok, reason };
  if (trust?.serviceBlessing !== undefined) body.serviceBlessing = trust.serviceBlessing;
  if (trust?.hubSig !== undefined) body.hubSig = trust.hubSig;
  return {
    streamId: 0,
    type: FRAME_HELLO_ACK,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export interface ParsedHelloAck {
  ok: boolean;
  reason?: string;
  /** Present only when the hub attached one (new hubs). */
  serviceBlessing?: unknown;
  /** Present only when the hub attached one (new hubs). */
  hubSig?: string;
}

/**
 * Parse a HELLO_ACK payload. Returns `null` when the payload is not JSON.
 * The optional trust fields decode to `undefined` when absent — a box on
 * the new code talking to an old hub sees no blessing and stays in OBSERVE
 * (keep relaying).
 */
export function parseHelloAck(payload: Uint8Array): ParsedHelloAck | null {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const out: ParsedHelloAck = { ok: o.ok === true };
  if (typeof o.reason === "string") out.reason = o.reason;
  if (o.serviceBlessing !== undefined && o.serviceBlessing !== null) {
    out.serviceBlessing = o.serviceBlessing;
  }
  if (typeof o.hubSig === "string") out.hubSig = o.hubSig;
  return out;
}

export interface DomainGrantedPayload {
  fqdn: string;
  /** Canonical FQDN of the pod that now holds the route. */
  ownerServerId: string;
}

export function domainGrantedFrame(p: DomainGrantedPayload): Frame {
  return {
    streamId: 0,
    type: FRAME_DOMAIN_GRANTED,
    payload: new TextEncoder().encode(JSON.stringify(p)),
  };
}

export interface RequestTransferPayload {
  fqdn: string;
}

export function requestTransferFrame(p: RequestTransferPayload): Frame {
  return {
    streamId: 0,
    type: FRAME_REQUEST_TRANSFER,
    payload: new TextEncoder().encode(JSON.stringify(p)),
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
