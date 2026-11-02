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
 * Sent when the hub's machine is shutting down (rolling deploy, scale-down), and only to a
 * box that offered `drain-v1` in its HELLO and saw it in the HELLO_ACK: it is not a v1 type,
 * so a box without the capability would treat it as a decode error. Payload is JSON
 * `{ "graceMs": number }`: the hub keeps serving the old tunnel that long, then closes it.
 * The box dials a new tunnel at once (the load balancer lands it on another machine) and
 * lets the old one's streams finish; streams are not migrated.
 */
export const FRAME_DRAIN_NOTICE = 0x05;

/**
 * Relay mesh frames (docs/architecture-v2/relay-mesh.md §9.1), on stream 0, used only on a tunnel that negotiated
 * `mesh-v1` (the box offered it in HELLO `capabilities` and the relay echoed it in HELLO_ACK): like 0x05 they are not
 * v1 types, so a decoder accepts them only with `DecodeOptions.mesh`.
 *
 *   ATTACHMENT 0x07, box → relay: `{attachment, signature}`, the box-signed `flagship/relay-attachment/v1` (§5.1).
 *   ATTACHMENT 0x07, relay → box: `{ok:true}` or `{ok:false, code}` (`clock`, `mismatch`, `not-registered`, `revoked`).
 *   MOVE_HINT  0x08, relay → box: `{hint, signature, target}`, a relay-signed `flagship/relay-move-hint/v1` and the
 *              target relay's RelayBlessing (§9.3).
 *
 * The payload records are checked by `@flagship/protocol` (relayMesh.ts: checkBoxAttachment, checkMoveHint); the
 * parsers here only check the JSON shape.
 */
export const FRAME_ATTACHMENT = 0x07;
export const FRAME_MOVE_HINT = 0x08;

// Peer-backup frames (RFC: roadmap.md §1)
export const FRAME_PB_PUT = 0x20;
export const FRAME_PB_PUT_ACK = 0x21;
export const FRAME_PB_GET = 0x22;
export const FRAME_PB_GET_DATA = 0x23;
export const FRAME_PB_GET_END = 0x24;
export const FRAME_PB_CHALLENGE = 0x30;
export const FRAME_PB_RESPONSE = 0x31;

// Box-initiated outbound streams (docs/ai-privacy-and-staging.md §4). See
// outboundFrames.ts. A box sends these ONLY to a hub whose HELLO_ACK
// advertised CAPABILITY_OUTBOUND_V1: an older hub rejects unknown types.
export const FRAME_OUTBOUND_OPEN = 0x40;
export const FRAME_OUTBOUND_RESULT = 0x41;
export const FRAME_OUTBOUND_CREDIT = 0x42;

// Peer-backup mailboxes between accounts (docs/peer-backup.md §5.3). See
// mailFrames.ts. A box sends these ONLY to a hub whose HELLO_ACK advertised
// CAPABILITY_PB_MAIL_V1, for the same reason as the outbound frames.
export const FRAME_PB_MAIL_REQ = 0x50;
export const FRAME_PB_MAIL_RESP = 0x51;
export const FRAME_PB_MAILBOX_ANNOUNCE = 0x52;

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
  | typeof FRAME_ATTACHMENT
  | typeof FRAME_MOVE_HINT
  | typeof FRAME_PB_PUT
  | typeof FRAME_PB_PUT_ACK
  | typeof FRAME_PB_GET
  | typeof FRAME_PB_GET_DATA
  | typeof FRAME_PB_GET_END
  | typeof FRAME_PB_CHALLENGE
  | typeof FRAME_PB_RESPONSE
  | typeof FRAME_OUTBOUND_OPEN
  | typeof FRAME_OUTBOUND_RESULT
  | typeof FRAME_OUTBOUND_CREDIT
  | typeof FRAME_PB_MAIL_REQ
  | typeof FRAME_PB_MAIL_RESP
  | typeof FRAME_PB_MAILBOX_ANNOUNCE;

export interface Frame {
  streamId: number;
  type: FrameType;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 9;
export const MAX_FRAME_PAYLOAD = 1 << 20; // 1 MiB

/** Frame types beyond v1 a decoder accepts because the capability was negotiated. */
export interface DecodeOptions {
  /** `drain-v1`: accept FRAME_DRAIN_NOTICE. */
  drainNotice?: boolean;
  /** `mesh-v1`: accept FRAME_ATTACHMENT and FRAME_MOVE_HINT. */
  mesh?: boolean;
}

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

export function decodeFrame(buf: Uint8Array, opts: DecodeOptions = {}): DecodeResult {
  if (buf.length < FRAME_HEADER_BYTES) {
    return { kind: "incomplete", needAtLeast: FRAME_HEADER_BYTES };
  }
  const streamId = readU32BE(buf, 0);
  const type = buf[4]!;
  if (
    !isFrameType(type) &&
    !(opts.drainNotice === true && type === FRAME_DRAIN_NOTICE) &&
    !(opts.mesh === true && (type === FRAME_ATTACHMENT || type === FRAME_MOVE_HINT))
  ) {
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
      type: type as FrameType,
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
    t === FRAME_PB_RESPONSE ||
    t === FRAME_OUTBOUND_OPEN ||
    t === FRAME_OUTBOUND_RESULT ||
    t === FRAME_OUTBOUND_CREDIT ||
    t === FRAME_PB_MAIL_REQ ||
    t === FRAME_PB_MAIL_RESP ||
    t === FRAME_PB_MAILBOX_ANNOUNCE
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
 * Serving-authority fields a box adds to its HELLO JSON (docs/architecture-v2/serving-wiring.md §2). Both optional
 * and outside the STK-signed envelope: they can only narrow what the box serves, since the relay checks every record
 * against the admin key `.com` publishes. A box that sends no `servingAdminKey` keeps its control name but serves
 * no app; a hub that predates them ignores them.
 */
export interface HelloServingFields {
  /** The account admin key the box pinned (its admin root, else IRK), 64 lowercase hex. */
  servingAdminKey?: string | null;
  /** The box's stored signed `serving-policy/v1`: `{ record, signature }` (signature 128 hex), or null. */
  servingPolicy?: { record: unknown; signature: string } | null;
  /**
   * Mesh mode (relay-mesh.md §9.5): the box's best leases, at most `MAX_HELLO_SERVING_LEASES` (the best per signer),
   * each `{record, signature, delegation?: {record, signature}}`. A mesh relay never fetches leases from `.com`.
   */
  servingLeases?: Array<{ record: unknown; signature: string; delegation?: { record: unknown; signature: string } }>;
}

/** At most this many `servingLeases` in a HELLO. */
export const MAX_HELLO_SERVING_LEASES = 8;

/**
 * HELLO_ACK `reason` (with WebSocket close 1013) when the relay takes no new tunnels for now, because it has lost
 * contact with `.com`'s serving feed: the box reconnects with its usual backoff.
 */
export const HELLO_REFUSED_TRY_AGAIN = "try-again";

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
  /** Mesh relays, to a box that offered `mesh-v1` (relay-mesh.md §9.1): the relay's id… */
  relayId?: string;
  /** …and its RelayBlessing envelope (verbatim JSON); `hubSig` is then made with the blessing's `relayKey`. */
  relayBlessing?: unknown;
}

/**
 * Hub features a box may use on this connection. A box must never send a
 * frame type the hub hasn't advertised here, because an older hub closes
 * the tunnel on an unknown type. Old boxes ignore the field.
 */
export const CAPABILITY_OUTBOUND_V1 = "outbound-v1";
export const CAPABILITY_PB_MAIL_V1 = "pb-mail-v1";
/**
 * Offered by the box in its HELLO `capabilities`; the hub echoes it in the HELLO_ACK only
 * when the box offered it, and only then sends FRAME_DRAIN_NOTICE.
 */
export const CAPABILITY_DRAIN_V1 = "drain-v1";

/**
 * Offered by a 0.3 box in its HELLO `capabilities`; a mesh relay echoes it in the HELLO_ACK (with `relayId` and
 * `relayBlessing`) only when the box offered it, and only then do FRAME_ATTACHMENT / FRAME_MOVE_HINT flow.
 */
export const CAPABILITY_MESH_V1 = "mesh-v1";

/** Longest grace a box honours; a larger `graceMs` is clamped to it. */
export const MAX_DRAIN_GRACE_MS = 5 * 60_000;

export function drainNoticeFrame(graceMs: number): Frame {
  return {
    streamId: 0,
    type: FRAME_DRAIN_NOTICE,
    payload: new TextEncoder().encode(JSON.stringify({ graceMs: Math.max(0, Math.floor(graceMs)) })),
  };
}

/** The notice's grace in ms, clamped to [0, MAX_DRAIN_GRACE_MS]; null when malformed. */
export function parseDrainNotice(payload: Uint8Array): number | null {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const g = (obj as Record<string, unknown>).graceMs;
  if (typeof g !== "number" || !Number.isFinite(g)) return null;
  return Math.min(MAX_DRAIN_GRACE_MS, Math.max(0, Math.floor(g)));
}

export function helloAckFrame(
  ok: boolean,
  reason?: string,
  trust?: HelloAckTrust,
  capabilities?: readonly string[],
): Frame {
  const body: {
    ok: boolean;
    reason?: string;
    serviceBlessing?: unknown;
    hubSig?: string;
    capabilities?: string[];
    relayId?: string;
    relayBlessing?: unknown;
  } = { ok, reason };
  if (trust?.serviceBlessing !== undefined) body.serviceBlessing = trust.serviceBlessing;
  if (trust?.hubSig !== undefined) body.hubSig = trust.hubSig;
  if (capabilities && capabilities.length > 0) body.capabilities = [...capabilities];
  // Key order is part of the byte vectors: the mesh fields come last.
  if (trust?.relayId !== undefined) body.relayId = trust.relayId;
  if (trust?.relayBlessing !== undefined) body.relayBlessing = trust.relayBlessing;
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
  /** Hub features usable on this connection. Absent from an old hub. */
  capabilities?: string[];
  /** Mesh relays only (`mesh-v1` echoed): the relay's id and its RelayBlessing. */
  relayId?: string;
  relayBlessing?: unknown;
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
  if (Array.isArray(o.capabilities)) {
    out.capabilities = o.capabilities.filter((c): c is string => typeof c === "string");
  }
  if (typeof o.relayId === "string") out.relayId = o.relayId;
  if (o.relayBlessing !== undefined && o.relayBlessing !== null) out.relayBlessing = o.relayBlessing;
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

// ── relay mesh frames (mesh-v1) ───────────────────────────────────────────

/** Box → relay: the attachment record and its STK signature (128 hex). The record is checked by checkBoxAttachment. */
export interface AttachmentFramePayload {
  attachment: Record<string, unknown>;
  signature: string;
}

/** The holder's refusal codes for an attachment (relay-mesh.md §9.1). */
export type AttachmentRefusalCode = "clock" | "mismatch" | "not-registered" | "revoked";
export const ATTACHMENT_REFUSAL_CODES: readonly AttachmentRefusalCode[] = ["clock", "mismatch", "not-registered", "revoked"];

/** Relay → box: the answer to an attachment. */
export type AttachmentResultPayload = { ok: true } | { ok: false; code: AttachmentRefusalCode };

/** Relay → box: a signed move hint and the target relay's blessing (checked by checkMoveHint). */
export interface MoveHintFramePayload {
  hint: Record<string, unknown>;
  signature: string;
  target: Record<string, unknown>;
}

const SIG_HEX = /^[0-9a-f]{128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const jsonFrame = (type: typeof FRAME_ATTACHMENT | typeof FRAME_MOVE_HINT, body: unknown): Frame => ({
  streamId: 0,
  type,
  payload: new TextEncoder().encode(JSON.stringify(body)),
});
function parseJsonObject(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(payload));
    return isRecord(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function attachmentFrame(p: AttachmentFramePayload): Frame {
  return jsonFrame(FRAME_ATTACHMENT, { attachment: p.attachment, signature: p.signature });
}

export function attachmentResultFrame(p: AttachmentResultPayload): Frame {
  return jsonFrame(FRAME_ATTACHMENT, p.ok ? { ok: true } : { ok: false, code: p.code });
}

export function moveHintFrame(p: MoveHintFramePayload): Frame {
  return jsonFrame(FRAME_MOVE_HINT, { hint: p.hint, signature: p.signature, target: p.target });
}

/** Relay side: an attachment frame from a box; null unless `{attachment: object, signature: 128 hex}`. */
export function parseAttachmentFrame(payload: Uint8Array): AttachmentFramePayload | null {
  const o = parseJsonObject(payload);
  if (!o || !isRecord(o.attachment) || typeof o.signature !== "string" || !SIG_HEX.test(o.signature)) return null;
  return { attachment: o.attachment, signature: o.signature };
}

/** Box side: the relay's answer; null for anything but `{ok:true}` or `{ok:false, code: <known code>}`. */
export function parseAttachmentResult(payload: Uint8Array): AttachmentResultPayload | null {
  const o = parseJsonObject(payload);
  if (!o) return null;
  if (o.ok === true) return { ok: true };
  if (o.ok === false && typeof o.code === "string" && (ATTACHMENT_REFUSAL_CODES as readonly string[]).includes(o.code)) {
    return { ok: false, code: o.code as AttachmentRefusalCode };
  }
  return null;
}

/** Box side: a move hint; null unless `{hint: object, signature: 128 hex, target: object}`. */
export function parseMoveHintFrame(payload: Uint8Array): MoveHintFramePayload | null {
  const o = parseJsonObject(payload);
  if (!o || !isRecord(o.hint) || !isRecord(o.target) || typeof o.signature !== "string" || !SIG_HEX.test(o.signature)) return null;
  return { hint: o.hint, signature: o.signature, target: o.target };
}
