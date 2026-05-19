/**
 * Sibling-WS wire protocol.
 *
 * Wire shape: every WS message is a single binary blob beginning with a
 * 1-byte frame type, followed by a JSON payload (UTF-8).
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
 * Frame catalogue — DELIBERATELY MINIMAL
 * --------------------------------------------------------------------
 *
 * The harness does NOT enshrine any coordination protocol on top of
 * the sibling-WS — it just keeps the connection authenticated and
 * relays opaque app payloads. URL takeover, state sync, leader
 * election, etc. are app concerns built on top of `sibling-app-message`
 * (0x06). See `docs/multiplexing.md` and the LLM replication-patterns
 * chapter for the patterns apps usually choose.
 *
 * 0x01 sibling-hello — mutual authentication + live-siblings gossip.
 *   Both peers send sibling-hello as the FIRST message after the WS
 *   upgrade. Each side carries a 32-byte challenge nonce and signs the
 *   peer's identity bytes (canonical form via siblingHelloChallenge)
 *   using its STK. The receiver verifies the signature against the
 *   sender's STK pubkey, looked up via .com `/api/server/by-domain`.
 *   Carries `liveSiblings: string[]` — every serverId the sender
 *   currently has a live sibling-WS to. Receivers merge into their
 *   in-memory live-set and may opportunistically connect to new ones.
 *   The set is purely ephemeral (in-memory; no persistence) — a pod
 *   can leave the population at any time, and apps must roll with the
 *   punches. `protocolVersion` MUST be 1.
 *
 * 0x06 sibling-app-message — bidirectional, opaque.
 *   Generic app-payload routing. `serviceId` is the routing key
 *   (FLAGSHIP_APP_TOKEN-bound on the receive side); `payload` is
 *   opaque to the harness. All app-level coordination — takeovers,
 *   sync handshakes, leader-election, RPC, anything — rides on this
 *   frame as serialized app-defined messages.
 *
 * --------------------------------------------------------------------
 * Idempotency + replay
 * --------------------------------------------------------------------
 *
 * Hello replay across handshake legs is prevented by the canonical
 * bytes binding (peer, me) — a captured signature cannot be reused
 * the other direction. App-message routing offers no built-in
 * idempotency; apps that need it (RPC, exactly-once delivery)
 * implement it in their payload.
 */

export const FRAME_SIBLING_HELLO = 0x01;
export const FRAME_SIBLING_APP_MESSAGE = 0x06;

export type SiblingFrameType =
  | typeof FRAME_SIBLING_HELLO
  | typeof FRAME_SIBLING_APP_MESSAGE;

export interface SiblingHelloPayload {
  protocolVersion: 1;
  serverId: string;
  /** 32-byte hex challenge issued by THIS side to the peer. */
  challenge: string;
  /**
   * Hex Ed25519 signature over canonicalSiblingHelloChallenge() where
   * the input is the PEER's challenge (not our own). When ours
   * verifies on theirs, they know we hold the STK matching the
   * registered pubkey for serverId.
   */
  challengeResponseSignature?: string;
  /**
   * Currently-live siblings as known to the sender (every peer the
   * sender has an active sibling-WS to). Receivers merge into their
   * own in-memory live set; entries refer to other pods of the same
   * user and are NOT persisted across restarts.
   */
  liveSiblings?: string[];
}

export interface SiblingAppMessagePayload {
  serviceId: string;
  fromSiblingId: string;
  toSiblingId: string;
  /** Opaque hex payload. */
  payloadHex: string;
}

export type SiblingFrame =
  | { type: typeof FRAME_SIBLING_HELLO; payload: SiblingHelloPayload }
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
  return t === FRAME_SIBLING_HELLO || t === FRAME_SIBLING_APP_MESSAGE;
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
      if (o.liveSiblings !== undefined) {
        if (!Array.isArray(o.liveSiblings)) {
          return { ok: false, reason: "malformed liveSiblings" };
        }
        for (const s of o.liveSiblings) {
          if (typeof s !== "string" || s.length === 0 || s.length > 253) {
            return { ok: false, reason: "malformed liveSiblings entry" };
          }
        }
      }
      const payload: SiblingHelloPayload = {
        protocolVersion: 1,
        serverId: o.serverId,
        challenge: o.challenge,
        challengeResponseSignature: o.challengeResponseSignature as string | undefined,
        liveSiblings: o.liveSiblings as string[] | undefined,
      };
      return { ok: true, payload };
    }
    case FRAME_SIBLING_APP_MESSAGE: {
      if (
        typeof o.serviceId !== "string" ||
        typeof o.fromSiblingId !== "string" ||
        typeof o.toSiblingId !== "string" ||
        typeof o.payloadHex !== "string"
      ) {
        return { ok: false, reason: "malformed sibling-app-message" };
      }
      return {
        ok: true,
        payload: {
          serviceId: o.serviceId,
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
 * - `challengeHex` is the 32-byte hex challenge.
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
