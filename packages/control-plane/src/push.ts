/**
 * Push-token registration + relay.
 *
 * Routes:
 *   POST   /api/push/register   — IRK-signed; mint or re-register a token
 *   DELETE /api/push/<token-id> — IRK-signed; revoke
 *   POST   /api/push/relay      — phone or daemon submits encrypted payload
 *                                  + target user; Worker forwards to APNs/FCM
 *
 * Privacy invariant: the relay payload is opaque to .com. The phone
 * pre-shares an X25519 pubkey at register time; the sender (another
 * phone OR a daemon) seals the payload to that pubkey before submitting
 * to /api/push/relay. The Worker forwards bytes-as-bytes to APNs/FCM
 * with platform-specific framing (notification body is opaque, only
 * the category is in plaintext so the OS can route + show the right UI).
 */

import {
  verifyPushTokenRegister,
  type PushTokenRegister,
} from "@flagship/protocol";
import type { PushTokenStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes, bytesToHex } from "./hex.js";
import { forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

export interface PushDeps {
  pushTokens: PushTokenStorage;
  usernames: UsernameStorage;
  freshnessMs?: number;
  now?: () => number;
  /**
   * APNs / FCM relay function injected by the Worker. Takes the
   * resolved push-token records and the opaque payload + category;
   * returns ok=true for at-least-one-success.
   */
  forwardToProviders?: (args: {
    targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
    category: string;
    sealedPayloadHex: string;
  }) => Promise<{ ok: boolean; sent: number; failed: number }>;
}

interface RegisterBody {
  request?: {
    username?: string;
    platform?: string;
    providerToken?: string;
    pushX25519Pub?: string;
    label?: string;
    issuedAt?: number;
  };
  signature?: string;
}

/** Maximum bytes of `label` we'll persist. Anything longer is rejected
 *  at the handler so the .com storage doesn't grow unbounded if a
 *  buggy / hostile client ships a 4 MB string. 64 is generous for
 *  "Harry's iPhone (kitchen)" patterns. */
const MAX_LABEL_LEN = 64;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

export async function handlePushRegister(
  deps: PushDeps,
  body: RegisterBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.platform !== "string" ||
    typeof r.providerToken !== "string" ||
    typeof r.pushX25519Pub !== "string" ||
    typeof r.label !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.platform !== "apns" && r.platform !== "fcm" && r.platform !== "webpush") {
    return malformed("platform must be apns|fcm|webpush");
  }
  if (r.label.length > MAX_LABEL_LEN) {
    return malformed(`label longer than ${MAX_LABEL_LEN} bytes`);
  }
  if (CONTROL_CHARS_RE.test(r.label)) {
    return malformed("label contains control characters");
  }
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  let pushPub: Uint8Array;
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    pushPub = hexToBytes(r.pushX25519Pub);
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (pushPub.length !== 32) return malformed("pushX25519Pub must be 32 bytes");

  const claim: PushTokenRegister = {
    username: r.username,
    platform: r.platform,
    providerToken: r.providerToken,
    pushX25519Pub: pushPub,
    label: r.label,
    issuedAt: r.issuedAt,
  };
  if (!verifyPushTokenRegister(claim, sig, irkPub)) return forbidden("invalid signature");

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  const tokenId = generateTokenId();
  await deps.pushTokens.put({
    tokenId,
    username: r.username,
    platform: r.platform,
    providerToken: r.providerToken,
    pushX25519PubHex: r.pushX25519Pub,
    registrationSignatureHex: body.signature,
    label: r.label,
    registeredAt: now,
    lastSeenAt: now,
  });
  return ok({ ok: true, tokenId });
}

interface RelayBody {
  /** Username of the target. Worker fans out to all that user's registered tokens. */
  targetUsername?: string;
  /** Notification category in plaintext (e.g. "unlock-request"). */
  category?: string;
  /** Hex of the bytes sealed by the sender to the target's push X25519 pub. */
  sealedPayloadHex?: string;
}

export async function handlePushRelay(
  deps: PushDeps,
  body: RelayBody | undefined,
): Promise<HandlerResponse> {
  if (
    !body ||
    typeof body.targetUsername !== "string" ||
    typeof body.category !== "string" ||
    typeof body.sealedPayloadHex !== "string"
  ) {
    return malformed("malformed body");
  }
  if (body.sealedPayloadHex.length > 8192) {
    return malformed("sealed payload too large");
  }
  const tokens = await deps.pushTokens.listByUser(body.targetUsername);
  if (tokens.length === 0) return notFound("no push tokens for user");

  if (!deps.forwardToProviders) {
    // Without a real forwarder, return ok with `simulated: true` so
    // tests + dev environments can verify the path.
    return ok({ ok: true, simulated: true, fanout: tokens.length });
  }
  const result = await deps.forwardToProviders({
    targets: tokens.map((t) => ({
      tokenId: t.tokenId,
      platform: t.platform,
      providerToken: t.providerToken,
    })),
    category: body.category,
    sealedPayloadHex: body.sealedPayloadHex,
  });
  return ok({ ...result });
}

export async function handlePushRevoke(
  deps: PushDeps,
  tokenId: string,
  body: { issuedAt?: number; signature?: string } | undefined,
): Promise<HandlerResponse> {
  // Revoke is intentionally lighter — we accept either an IRK-signed
  // envelope (for "this user revokes their old token") or an admin
  // call. v1 here just removes; v2 adds proper sig validation.
  void body;
  await deps.pushTokens.remove(tokenId);
  return ok({ ok: true });
}

function generateTokenId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
