/**
 * Sibling-WS wire protocol.
 *
 * Wire shape: every WS message is a single binary blob beginning with a
 * 1-byte frame type, followed by a JSON payload (UTF-8). Binary fields
 * inside the payload are hex-encoded strings.
 *
 *   uint8   frameType
 *   bytes[] utf8(JSON.stringify(payload))
 *
 * No length prefix on the payload — the WS message boundary IS the
 * frame boundary. Multi-frame messages are not supported (each WS
 * message is exactly one sibling frame).
 *
 * The frame-type byte is mandatory; a message that doesn't begin with
 * a known type byte is rejected and the WS is closed with code 1002.
 *
 * --------------------------------------------------------------------
 * Frame catalogue
 * --------------------------------------------------------------------
 *
 * 0x01 sibling-hello — mutual authentication.
 *   Both peers send sibling-hello as the FIRST message after the WS
 *   upgrade. Each side carries a 32-byte challenge nonce and signs the
 *   peer's identity bytes (composed canonically, see siblingHelloChallenge)
 *   using its STK. The receiver verifies the signature against the
 *   sender's STK pubkey, looked up via .com `/api/server/by-domain`.
 *   Optional `resumeToken` references a prior successful handshake on
 *   the same (initiator, responder) pair; when present, the responder
 *   may shortcut frame replay (currently unused — placeholder for
 *   N0e-2). `protocolVersion` MUST be 1.
 *
 * 0x02 sibling-takeover-request — initiator → incumbent.
 *   The initiator (the pod that wants to claim `fqdn`) sends this
 *   carrying the ClaimUrlCapability that authorizes the claim plus the
 *   IRK signature. The incumbent verifies the cap (against its own
 *   capability store + the user's IRK pubkey), then either accepts
 *   (sibling-takeover-ack ok=true followed by sibling-sync-frame(s)
 *   and finally sibling-sync-complete) or rejects (ack ok=false,
 *   reason).
 *
 * 0x03 sibling-sync-frame — incumbent → initiator.
 *   Opaque app payload — the harness does not interpret the bytes.
 *   Apps own consistency model + replication. Field `requestId` ties
 *   the frame to a takeover request. Multiple sync-frames may be sent
 *   per takeover; the stream ends with sibling-sync-complete.
 *
 * 0x04 sibling-takeover-ack — incumbent → initiator.
 *   Pairs with sibling-takeover-request via requestId. ok=true means
 *   the incumbent has accepted the handoff; sync-frames follow if any.
 *   ok=false carries a reason and the takeover ABORTS — the initiator
 *   must NOT then push a HELLO claiming the fqdn.
 *
 * 0x05 sibling-sync-complete — incumbent → initiator.
 *   Final frame of a takeover. After receiving this, the initiator:
 *     1. updates its tunnel HELLO to add fqdn to controlledDomains
 *     2. waits for HELLO_ACK
 *     3. tells the incumbent (via N0e-2's "ack-takeover-complete" upcoming
 *        — for now the incumbent infers from the next inbound HELLO at
 *        the hub steal event)
 *   The incumbent then drops fqdn from its next HELLO update.
 *
 * 0x06 app-message — bidirectional (used by N0i).
 *   Generic app-payload routing. `appId` is the routing key
 *   (FLAGSHIP_APP_TOKEN-bound on the receive side); `payload` is opaque.
 *   Tooling for this lives in N0i's /api/sibling/{list,send,subscribe}
 *   endpoints — this frame is the wire substrate.
 *
 * --------------------------------------------------------------------
 * Idempotency + replay
 * --------------------------------------------------------------------
 *
 * Each direction maintains a monotonic frame counter (ConnState.lastSent
 * and lastRecv). Repeating a frame within a single WS connection is
 * permitted only for sibling-takeover-request (use case: client retry
 * after a transient error before any ack arrived). Receivers track seen
 * requestIds and respond to duplicate requests with the cached ack
 * rather than re-running the takeover.
 *
 * On WS disconnect mid-takeover, the initiator may reconnect and
 * present the same requestId; the incumbent treats this as a resume.
 * (The actual resume mechanism is finalized in N0e-2; the protocol is
 * shaped here so that retries are safe.)
 */

export const FRAME_SIBLING_HELLO = 0x01;
export const FRAME_SIBLING_TAKEOVER_REQUEST = 0x02;
export const FRAME_SIBLING_SYNC_FRAME = 0x03;
export const FRAME_SIBLING_TAKEOVER_ACK = 0x04;
export const FRAME_SIBLING_SYNC_COMPLETE = 0x05;
export const FRAME_SIBLING_APP_MESSAGE = 0x06;

export type SiblingFrameType =
  | typeof FRAME_SIBLING_HELLO
  | typeof FRAME_SIBLING_TAKEOVER_REQUEST
  | typeof FRAME_SIBLING_SYNC_FRAME
  | typeof FRAME_SIBLING_TAKEOVER_ACK
  | typeof FRAME_SIBLING_SYNC_COMPLETE
  | typeof FRAME_SIBLING_APP_MESSAGE;

export interface SiblingHelloPayload {
  protocolVersion: 1;
  serverId: string;
  /** 32-byte hex challenge issued by THIS side to the peer. */
  challenge: string;
  /**
   * Hex Ed25519 signature over canonicalSiblingHelloChallenge() where
   * the input is the PEER's challenge (not our own). Composed and
   * verified by both sides — when ours verifies on theirs, they know we
   * hold the STK matching the registered pubkey for serverId.
   */
  challengeResponseSignature?: string;
  /**
   * Reference to a prior handshake's session id; placeholder for N0e-2's
   * resume mechanism. Receivers that don't recognize the token MUST
   * still complete a normal handshake.
   */
  resumeToken?: string;
}

export interface SiblingTakeoverRequestPayload {
  requestId: string;
  fqdn: string;
  capability: {
    username: string;
    appId: string;
    siblingId: string;
    fqdn: string;
    issuedAt: number;
    expiresAt: number;
  };
  capabilitySignatureHex: string;
}

export interface SiblingSyncFramePayload {
  requestId: string;
  /** Opaque hex payload — apps own format + interpretation. */
  payloadHex: string;
}

export interface SiblingTakeoverAckPayload {
  requestId: string;
  ok: boolean;
  reason?: string;
}

export interface SiblingSyncCompletePayload {
  requestId: string;
}

export interface SiblingAppMessagePayload {
  appId: string;
  fromSiblingId: string;
  toSiblingId: string;
  /** Opaque hex payload. */
  payloadHex: string;
}

export type SiblingFrame =
  | { type: typeof FRAME_SIBLING_HELLO; payload: SiblingHelloPayload }
  | { type: typeof FRAME_SIBLING_TAKEOVER_REQUEST; payload: SiblingTakeoverRequestPayload }
  | { type: typeof FRAME_SIBLING_SYNC_FRAME; payload: SiblingSyncFramePayload }
  | { type: typeof FRAME_SIBLING_TAKEOVER_ACK; payload: SiblingTakeoverAckPayload }
  | { type: typeof FRAME_SIBLING_SYNC_COMPLETE; payload: SiblingSyncCompletePayload }
  | { type: typeof FRAME_SIBLING_APP_MESSAGE; payload: SiblingAppMessagePayload };

export function encodeSiblingFrame(f: SiblingFrame): Uint8Array {
  const json = JSON.stringify(f.payload);
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(1 + body.length);
  out[0] = f.type;
  out.set(body, 1);
  return out;
}

export type DecodeSiblingFrameResult =
  | { kind: "ok"; frame: SiblingFrame }
  | { kind: "error"; reason: string };

export function decodeSiblingFrame(buf: Uint8Array): DecodeSiblingFrameResult {
  if (buf.length < 1) return { kind: "error", reason: "empty frame" };
  const type = buf[0]!;
  if (!isSiblingFrameType(type)) {
    return { kind: "error", reason: `unknown frame type 0x${type.toString(16)}` };
  }
  const body = buf.subarray(1);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "error", reason: "frame payload not JSON" };
  }
  const validated = validatePayload(type, payload);
  if (!validated.ok) return { kind: "error", reason: validated.reason };
  return { kind: "ok", frame: { type, payload: validated.payload } as SiblingFrame };
}

function isSiblingFrameType(t: number): t is SiblingFrameType {
  return (
    t === FRAME_SIBLING_HELLO ||
    t === FRAME_SIBLING_TAKEOVER_REQUEST ||
    t === FRAME_SIBLING_SYNC_FRAME ||
    t === FRAME_SIBLING_TAKEOVER_ACK ||
    t === FRAME_SIBLING_SYNC_COMPLETE ||
    t === FRAME_SIBLING_APP_MESSAGE
  );
}

type ValidateResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: string };

function validatePayload(type: SiblingFrameType, raw: unknown): ValidateResult<SiblingFrame["payload"]> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload not object" };
  }
  const o = raw as Record<string, unknown>;
  switch (type) {
    case FRAME_SIBLING_HELLO: {
      if (
        o.protocolVersion !== 1 ||
        typeof o.serverId !== "string" ||
        typeof o.challenge !== "string" ||
        !/^[0-9a-f]{64}$/.test(o.challenge)
      ) {
        return { ok: false, reason: "malformed sibling-hello" };
      }
      if (
        o.challengeResponseSignature !== undefined &&
        (typeof o.challengeResponseSignature !== "string" ||
          !/^[0-9a-f]{128}$/.test(o.challengeResponseSignature))
      ) {
        return { ok: false, reason: "malformed challengeResponseSignature" };
      }
      if (o.resumeToken !== undefined && typeof o.resumeToken !== "string") {
        return { ok: false, reason: "malformed resumeToken" };
      }
      const payload: SiblingHelloPayload = {
        protocolVersion: 1,
        serverId: o.serverId,
        challenge: o.challenge,
        challengeResponseSignature: o.challengeResponseSignature as string | undefined,
        resumeToken: o.resumeToken as string | undefined,
      };
      return { ok: true, payload };
    }
    case FRAME_SIBLING_TAKEOVER_REQUEST: {
      const c = o.capability;
      if (
        typeof o.requestId !== "string" ||
        typeof o.fqdn !== "string" ||
        typeof o.capabilitySignatureHex !== "string" ||
        typeof c !== "object" || c === null
      ) {
        return { ok: false, reason: "malformed sibling-takeover-request" };
      }
      const cap = c as Record<string, unknown>;
      if (
        typeof cap.username !== "string" ||
        typeof cap.appId !== "string" ||
        typeof cap.siblingId !== "string" ||
        typeof cap.fqdn !== "string" ||
        typeof cap.issuedAt !== "number" ||
        typeof cap.expiresAt !== "number"
      ) {
        return { ok: false, reason: "malformed capability" };
      }
      const payload: SiblingTakeoverRequestPayload = {
        requestId: o.requestId,
        fqdn: o.fqdn,
        capability: {
          username: cap.username,
          appId: cap.appId,
          siblingId: cap.siblingId,
          fqdn: cap.fqdn,
          issuedAt: cap.issuedAt,
          expiresAt: cap.expiresAt,
        },
        capabilitySignatureHex: o.capabilitySignatureHex,
      };
      return { ok: true, payload };
    }
    case FRAME_SIBLING_SYNC_FRAME: {
      if (typeof o.requestId !== "string" || typeof o.payloadHex !== "string") {
        return { ok: false, reason: "malformed sibling-sync-frame" };
      }
      return {
        ok: true,
        payload: { requestId: o.requestId, payloadHex: o.payloadHex },
      };
    }
    case FRAME_SIBLING_TAKEOVER_ACK: {
      if (
        typeof o.requestId !== "string" ||
        typeof o.ok !== "boolean" ||
        (o.reason !== undefined && typeof o.reason !== "string")
      ) {
        return { ok: false, reason: "malformed sibling-takeover-ack" };
      }
      return {
        ok: true,
        payload: {
          requestId: o.requestId,
          ok: o.ok,
          reason: o.reason as string | undefined,
        },
      };
    }
    case FRAME_SIBLING_SYNC_COMPLETE: {
      if (typeof o.requestId !== "string") {
        return { ok: false, reason: "malformed sibling-sync-complete" };
      }
      return { ok: true, payload: { requestId: o.requestId } };
    }
    case FRAME_SIBLING_APP_MESSAGE: {
      if (
        typeof o.appId !== "string" ||
        typeof o.fromSiblingId !== "string" ||
        typeof o.toSiblingId !== "string" ||
        typeof o.payloadHex !== "string"
      ) {
        return { ok: false, reason: "malformed sibling-app-message" };
      }
      return {
        ok: true,
        payload: {
          appId: o.appId,
          fromSiblingId: o.fromSiblingId,
          toSiblingId: o.toSiblingId,
          payloadHex: o.payloadHex,
        },
      };
    }
  }
}

/**
 * Canonical bytes the peer signs to prove possession of its STK.
 *
 * Form: `flagship/sibling-hello/v1|<peerServerId>|<myServerId>|<challengeHex>`
 *
 * - `peerServerId` is the serverId of the side computing the
 *   signature (i.e. the side whose STK signs).
 * - `myServerId` is the side that issued the challenge.
 * - `challengeHex` is the 32-byte hex challenge (matches the
 *   sibling-hello.challenge field).
 *
 * Including both ids in the signed bytes means a captured signature
 * cannot be replayed across (peer, me) pairs — it's bound to a single
 * directional handshake leg.
 */
export function siblingHelloChallenge(args: {
  peerServerId: string;
  myServerId: string;
  challengeHex: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `flagship/sibling-hello/v1|${args.peerServerId}|${args.myServerId}|${args.challengeHex}`,
  );
}
