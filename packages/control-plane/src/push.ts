/**
 * Push-token registration + relay.
 *
 * Routes:
 *   POST   /api/push/register   — IRK-signed; mint or re-register a token
 *   DELETE /api/push/<token-id> — IRK-signed; revoke
 *   POST   /api/push/relay      — STK-signed by a registered box of the
 *                                  target user; submits an encrypted payload
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
  isPushRelayCategory,
  verifyDeviceAdmit,
  verifyPushRelayRequest,
  verifyPushTokenRegister,
  verifyPushTokenRevoke,
  type DeviceAdmit,
  type PushRelayCategory,
  type PushRelayRequest,
  type PushTokenRegister,
  type PushTokenRevoke,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceIdentityStorage,
  PushTokenStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import { hexToBytes, bytesToHex } from "./hex.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

/**
 * Phase 3b — quarantine window for a device admitted via the vouched
 * cross-device QR pairing path. 14 days, matching the
 * `paired_sessions.quarantine_until` semantics on the daemon side and
 * the v1.2 cascade (0028_account_type.sql). During this window the
 * device is a non-admin peer (no revoke-others, no `ukey.*` admin
 * reach) and the owner gets the recurring review-alert ladder.
 */
export const QUARANTINE_MS = 14 * 86_400_000;

export interface PushDeps {
  pushTokens: PushTokenStorage;
  deviceIdentities: DeviceIdentityStorage;
  usernames: UsernameStorage;
  /**
   * Registered servers, used by the relay to authenticate the sender:
   * a legitimate relay is signed by one of the TARGET user's own boxes
   * (the same STK identity it signs daemon-status with). Required by
   * `handlePushRelay`; the register/admit paths don't read it.
   */
  servers?: ServerStorage;
  freshnessMs?: number;
  now?: () => number;
  /**
   * Phase 3b — optional audit sink. When wired, a vouched-admit
   * registration (`quarantine: true`) emits a `device-added` audit row
   * under the owner's account so the Activity feed records the join.
   * Left unset on the plain push-register path → behavior unchanged.
   */
  auditEvents?: AuditEventStorage;
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
    deviceId?: string;
    platform?: string;
    providerToken?: string;
    pushX25519Pub?: string;
    issuedAt?: number;
  };
  signature?: string;
}

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Phase 3b — opt-in extras for the vouched cross-device admit path.
 * Default (omitted) → the legacy plain push-register behavior is
 * preserved bit-for-bit. When `quarantine` is true the freshly-
 * registered token gets `quarantine_until = now + QUARANTINE_MS`
 * stamped and a `device-added` audit row is emitted.
 */
export interface PushRegisterOptions {
  quarantine?: boolean;
  /**
   * Retained only as an internal marker for the quarantine behavior. Every
   * registration is signed by the active account-scoped device key.
   */
  skipSignatureVerify?: boolean;
}

export async function handlePushRegister(
  deps: PushDeps,
  body: RegisterBody | undefined,
  options?: PushRegisterOptions,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.deviceId !== "string" ||
    typeof r.platform !== "string" ||
    typeof r.providerToken !== "string" ||
    typeof r.pushX25519Pub !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.platform !== "apns" && r.platform !== "fcm" && r.platform !== "webpush") {
    return malformed("platform must be apns|fcm|webpush");
  }
  const deviceId = r.deviceId.toLowerCase();
  if (!DEVICE_ID_RE.test(deviceId)) return malformed("deviceId must be 16-byte lowercase hex");
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");
  const identity = await deps.deviceIdentities.get(r.username, deviceId);
  if (!identity || identity.revokedAt !== null) return forbidden("invalid device authorization");

  let pushPub: Uint8Array;
  let sig: Uint8Array;
  let devicePub: Uint8Array;
  try {
    pushPub = hexToBytes(r.pushX25519Pub);
    sig = hexToBytes(body.signature);
    devicePub = hexToBytes(identity.devicePubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (pushPub.length !== 32) return malformed("pushX25519Pub must be 32 bytes");

  const claim: PushTokenRegister = {
    username: r.username,
    deviceId,
    platform: r.platform,
    providerToken: r.providerToken,
    pushX25519Pub: pushPub,
    issuedAt: r.issuedAt,
  };
  if (!verifyPushTokenRegister(claim, sig, devicePub)) return forbidden("invalid device authorization");

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  const tokenId = generateTokenId();
  // Phase 3b — a vouched cross-device admit stamps the 14-day
  // quarantine on the row at insert time (rather than a follow-up
  // setQuarantineUntil) so the device is never momentarily un-
  // quarantined between put + stamp. quarantineAlertsFiredBitmap stays
  // 0; the cron OR-s in the T+0 rung on its first tick.
  const quarantine = options?.quarantine === true;
  const quarantineUntil = quarantine ? now + QUARANTINE_MS : 0;
  await deps.pushTokens.put({
    tokenId,
    username: r.username,
    deviceId,
    platform: r.platform,
    providerToken: r.providerToken,
    pushX25519PubHex: r.pushX25519Pub,
    registrationSignatureHex: body.signature,
    registeredAt: now,
    lastSeenAt: now,
    quarantineUntil,
  });
  if (quarantine && deps.auditEvents) {
    // Best-effort: the audit insert never fails the admission. The
    // device-added row carries quarantineUntil so the Activity feed
    // renders "joined — under review until …".
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username: r.username.toLowerCase(),
        eventKind: "device-added",
        detail: "New device joined via pairing",
        devicePrefix: deviceId.slice(0, 8),
        postedAt: now,
        quarantineUntil,
      },
    );
  }
  return ok({ ok: true, tokenId, ...(quarantine ? { quarantineUntil } : {}) });
}

/**
 * Phase 3b — POST /api/users/:u/devices/admit
 *
 * The vouched cross-device admit. Body carries:
 *   - `admit`     : the DeviceAdmit envelope { username, newDevicePubHex, issuedAt }
 *   - `admitSig`  : Ed25519 over the admit, signed by the account's CURRENT IRK
 *   - `request`   : the same push-token registration fields handlePushRegister takes
 *   - `signature` : the PushTokenRegister signature (carried for storage; NOT
 *                   verified here — the admit is the IRK consent)
 *
 * Verify gate (rejects 401/403):
 *   (a) the DeviceAdmit signature verifies under `users.irk_pub_hex`,
 *   (b) the admit's issuedAt is fresh (~5 min),
 *   (c) the admit username matches the :u path AND the register body,
 *
 * On success → handlePushRegister(deps, body, { quarantine: true,
 * skipSignatureVerify: true }) so the device lands quarantined and a
 * `device-added` audit fires (when `auditEvents` is wired). The admit
 * binds `newDevicePubHex` so a captured admit can't be re-aimed at a
 * different device.
 */
interface AdmitBody {
  admit?: {
    username?: string;
    deviceId?: string;
    newDevicePubHex?: string;
    issuedAt?: number;
  };
  admitSig?: string;
  request?: RegisterBody["request"];
  signature?: string;
}

const DEVICE_PUB_HEX_RE = /^[0-9a-f]{64}$/;

export async function handleVouchedDeviceAdmit(
  deps: PushDeps,
  username: string,
  body: AdmitBody | undefined,
): Promise<HandlerResponse> {
  const a = body?.admit;
  if (
    !a ||
    typeof a.username !== "string" ||
    typeof a.deviceId !== "string" ||
    typeof a.newDevicePubHex !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof body?.admitSig !== "string"
  ) {
    return malformed("malformed admit");
  }
  // username/url match: the admit MUST be for the account named in the
  // path, and the register body (if present) MUST agree.
  if (a.username.toLowerCase() !== username.toLowerCase()) {
    return forbidden("admit username / url mismatch");
  }
  if (
    body.request &&
    typeof body.request.username === "string" &&
    body.request.username.toLowerCase() !== a.username.toLowerCase()
  ) {
    return forbidden("register username does not match admit");
  }
  const deviceId = a.deviceId.toLowerCase();
  if (!DEVICE_ID_RE.test(deviceId) || body.request?.deviceId?.toLowerCase() !== deviceId) {
    return forbidden("register deviceId does not match admit");
  }
  const newDevicePubHex = a.newDevicePubHex.toLowerCase();
  if (!DEVICE_PUB_HEX_RE.test(newDevicePubHex)) {
    return malformed("newDevicePubHex must be 32 bytes hex");
  }

  const userRec = await deps.usernames.get(a.username);
  if (!userRec) return notFound("username not registered");

  let admitSig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    admitSig = hexToBytes(body.admitSig);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }

  const admit: DeviceAdmit = {
    username: a.username,
    deviceId,
    newDevicePubHex,
    issuedAt: a.issuedAt,
  };
  // (a) The admit MUST verify under the account's CURRENT registered
  // IRK — that's the vouch. A bad / wrong-key admit is 401.
  if (!verifyDeviceAdmit(admit, admitSig, irkPub)) {
    return { status: 401, body: { error: "invalid admit proof" } };
  }
  // (b) Freshness — bound replay of a captured admit. Mirrors the
  // push-register window.
  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - a.issuedAt) > freshness) {
    return { status: 401, body: { error: "stale admit proof" } };
  }

  const identityPut = await deps.deviceIdentities.put({
    accountId: a.username,
    deviceId,
    devicePubHex: newDevicePubHex,
    platformClass: body.request?.platform ?? null,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  if (!identityPut.ok) return conflict(identityPut.reason);

  // The admit is valid: admit the incoming device QUARANTINED. We
  // reuse handlePushRegister for the storage + quarantine + audit
  // path; skipSignatureVerify is safe here because the IRK already
  // consented via the admit envelope (the incoming device holds no IRK).
  return handlePushRegister(deps, { request: body.request, signature: body.signature }, {
    quarantine: true,
    skipSignatureVerify: true,
  });
}

interface RelayBody {
  request?: {
    /** Username of the target. Worker fans out to all that user's registered tokens. */
    targetUsername?: string;
    /** Notification category in plaintext (e.g. "unlock-request"); must be a known enum. */
    category?: string;
    /** Hex of the bytes sealed by the sender to the target's push X25519 pub. */
    sealedPayloadHex?: string;
    issuedAt?: number;
  };
  /** Ed25519 over the canonical push-relay bytes, signed by a registered box of the target. */
  signature?: string;
}

const SIG_HEX_RE = /^[0-9a-f]{128}$/i;

/**
 * SEC-2 — the relay is now authenticated. The legitimate sender is one
 * of the TARGET user's OWN boxes (a daemon asking its owner to approve
 * an unlock), so we require an STK-signed `flagship/push-relay/v1`
 * envelope and verify it against the target's registered servers — the
 * same identity-key trust used by daemon-status / dns01. This kills both
 * the push-spam vector (any username-knower could fan out an
 * attacker-chosen category) and the device-registration oracle (404 vs
 * 200 on token presence): an unauthenticated caller now never reaches
 * the token lookup, and `category` is constrained to a known enum so it
 * can't carry arbitrary plaintext into the OS-visible slot.
 */
export async function handlePushRelay(
  deps: PushDeps,
  body: RelayBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.targetUsername !== "string" ||
    typeof r.category !== "string" ||
    typeof r.sealedPayloadHex !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.sealedPayloadHex.length > 8192) {
    return malformed("sealed payload too large");
  }
  if (!isPushRelayCategory(r.category)) {
    return malformed("unknown category");
  }
  if (!SIG_HEX_RE.test(body.signature)) {
    return malformed("signature must be 64-byte hex");
  }

  const now = (deps.now ?? (() => Date.now()))();
  const freshness = deps.freshnessMs ?? 5 * 60_000;
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  if (!deps.servers) return forbidden("relay unauthenticated");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const claim: PushRelayRequest = {
    targetUsername: r.targetUsername,
    category: r.category as PushRelayCategory,
    sealedPayloadHex: r.sealedPayloadHex,
    issuedAt: r.issuedAt,
  };

  // The signer must be a CURRENTLY-registered, non-revoked server of the
  // target user. We try each of the target's servers; the relay is
  // authorized as soon as one identity key verifies. A caller that holds
  // no such key (only a username) verifies against none → 403, BEFORE any
  // token lookup, so the response is no longer a registration oracle.
  const servers = await deps.servers.listForUser(r.targetUsername);
  let authorized = false;
  for (const s of servers) {
    if (s.revokedAt) continue;
    let stkPub: Uint8Array;
    try {
      stkPub = hexToBytes(s.identityPubKeyHex);
    } catch {
      continue;
    }
    if (verifyPushRelayRequest(claim, sig, stkPub)) {
      authorized = true;
      break;
    }
  }
  if (!authorized) return forbidden("not a registered box of the target");

  const tokens = await deps.pushTokens.listByUser(r.targetUsername);
  if (tokens.length === 0) return ok({ ok: true, fanout: 0 });

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
    category: r.category,
    sealedPayloadHex: r.sealedPayloadHex,
  });
  return ok({ ...result });
}

interface RevokeBody {
  request?: {
    tokenId?: string;
    issuedAt?: number;
  };
  signature?: string;
}

/**
 * SEC — `DELETE /api/push/<token-id>` is now AUTHENTICATED.
 *
 * Previously this discarded the body and deleted unconditionally, so any
 * caller who learned a 16-byte hex tokenId could silently kill a device's
 * push registration — including boot-unlock approval pushes and security
 * alerts. Revoke now requires EITHER:
 *
 *   (a) an admin call (`opts.isAdmin === true`, gated by the route's
 *       `authorizeAdmin(FLAGSHIP_ADMIN_SECRET)` check), OR
 *   (b) a valid owner-signed `flagship/push-token-revoke/v1` envelope:
 *       we resolve the token's owner username FROM THE STORED ROW, look
 *       up that user's registered IRK pub, and verify the signature over
 *       canonical bytes binding the tokenId + issuedAt (≈5-min freshness).
 *
 * Fail-closed: a missing/garbage signature without admin → 403. An
 * unknown tokenId returns ok (idempotent — the device is already gone)
 * but ONLY after the caller proved admin, since the unauthenticated path
 * never reaches the lookup. The envelope binds the path tokenId
 * (`request.tokenId` MUST equal the URL segment) so a captured
 * signature can't be re-aimed at a different token.
 */
export interface PushRevokeOptions {
  /** True iff the route already verified FLAGSHIP_ADMIN_SECRET. */
  isAdmin?: boolean;
}

export async function handlePushRevoke(
  deps: PushDeps,
  tokenId: string,
  body: RevokeBody | undefined,
  opts?: PushRevokeOptions,
): Promise<HandlerResponse> {
  // Admin override — the operator can force-drop any token (e.g. cleanup,
  // abuse response). Gated at the route by the shared admin secret.
  if (opts?.isAdmin === true) {
    await deps.pushTokens.remove(tokenId);
    return ok({ ok: true });
  }

  // Owner-signed path. Require a well-formed envelope BEFORE any storage
  // read so an unauthenticated caller never probes token existence.
  const r = body?.request;
  if (
    !r ||
    typeof r.tokenId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return forbidden("revoke requires an owner-signed envelope");
  }
  // The signed tokenId MUST match the URL segment — a captured signature
  // for token A can't be replayed against token B.
  if (r.tokenId !== tokenId) {
    return forbidden("tokenId does not match signed envelope");
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return forbidden("invalid signature");
  }

  // Resolve the owner FROM THE STORED ROW (the token row carries its
  // owner username), then verify against THAT user's registered IRK.
  const rec = await deps.pushTokens.get(tokenId);
  if (!rec) {
    // Unknown token: the caller is not an admin and produced an envelope
    // for a token that doesn't exist. Treat as a no-op success — there is
    // nothing to delete and no row to leak about. (The signature still
    // had to be structurally well-formed to get here.)
    return ok({ ok: true });
  }
  const userRec = await deps.usernames.get(rec.username);
  if (!userRec) return forbidden("owner not found");

  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return forbidden("owner irk unavailable");
  }

  const claim: PushTokenRevoke = { tokenId, issuedAt: r.issuedAt };
  if (!verifyPushTokenRevoke(claim, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  await deps.pushTokens.remove(tokenId);
  return ok({ ok: true });
}

function generateTokenId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
