/**
 * Phone-as-unlock-endpoint RELAY model (`.com` as a blind mailbox).
 *
 * docs/security-phone-as-unlock-endpoint.md §4 (handshake), §7a
 * (box-sealed lease + the rogue-operator invariants), §9 (deltas).
 *
 * `.com` is a store-and-forward relay between the booting box and the
 * user's phone. It NEVER holds plaintext on any path — invariant I1:
 *
 *   POST /api/server/:domain/secret-request           box, STK-signed
 *   GET  /api/secret-requests                          phone, IRK-signed mailbox-auth
 *   POST /api/secret-response                          phone, IRK-signed mailbox-auth
 *   GET  /api/server/:domain/secret-response?nonce=    box, public read (single-use)
 *
 *   POST   /api/server/:domain/unlock-key/lease-v2     box-sealed lease, IRK-signed
 *   GET    /api/server/:domain/unlock-key/lease-v2     box reboot release (sealed)
 *   DELETE /api/server/:domain/unlock-key/lease-v2/:id IRK-signed revoke
 *   GET    /api/server/:domain/unlock-key/leases-v2    public read (metadata only)
 *
 * Invariants (encoded structurally + tested):
 *   I1 — `.com` stores/serves only SEALED or public-signed blobs. No
 *        endpoint ever holds or returns the plaintext disk key.
 *   I2 — the lease's recipient `stkPub` is pinned (IRK-signed). `.com`
 *        cannot retarget the seal. The secret-request STK is verified
 *        against the directory-bound STK for that domain.
 *   I3 — `.com` is gate/router/push only: it can withhold (DoS) but
 *        never read or forge.
 */

import {
  verifyAutoUnlockLeaseV2,
  verifyDeviceEndpointClaim,
  verifyLeaseRevocation,
  verifySecretRequest,
  type AutoUnlockLeaseV2,
  type DeviceEndpointClaim,
  type LeaseRevocation,
  type SecretPurpose,
  type SecretRequest,
} from "@flagship/protocol";
import type {
  BoxSealedLeaseStorage,
  SecretMailboxPurpose,
  SecretMailboxStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

export interface SecretMailboxDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  secretMailbox: SecretMailboxStorage;
  boxSealedLeases: BoxSealedLeaseStorage;
  /**
   * Push fan-out for the "your box is finishing setup — open the app"
   * notification. Same closure shape the legacy /consume path uses
   * (built by the apex Worker from the push forwarder + token store).
   * Returns silently on no-tokens / no-config. Absent ⇒ no push.
   */
  pushUserDevices?: (
    username: string,
    category: string,
    payload?: Uint8Array,
  ) => Promise<void>;
  maxAgeMs?: number;
  /** Mailbox row TTL. Default 5 min — the request only needs to live for
   *  one boot handshake; a short window bounds a captured request. */
  mailboxTtlMs?: number;
  /** Skip pushing if a push for this row fired within this window. */
  pushDedupMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_MAILBOX_TTL = 5 * 60_000;
const DEFAULT_PUSH_DEDUP_MS = 60_000;
const HEX_NONCE = /^[0-9a-f]{64}$/; // 32 bytes hex

const PURPOSES: ReadonlySet<SecretMailboxPurpose> = new Set<SecretMailboxPurpose>([
  "unlock-key",
  "entitlement",
]);

function jsonByteLen(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 1. POST /api/server/:domain/secret-request  (box, STK-signed)
//
// The box posts an STK-signed SecretRequest. `.com` verifies the STK
// signature against the DIRECTORY-bound STK for this domain (the
// servers table) — a foreign / mismatched STK is rejected (I2). The
// pending row is parked keyed by the request nonce (single-use), with
// a short TTL + freshness window. A push wakes the user's devices.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostSecretRequest(
  deps: SecretMailboxDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_MAILBOX_TTL;

  const b = body as {
    request?: Record<string, unknown>;
    signature?: unknown;
    deviceInfo?: unknown;
  };
  const r = b?.request ?? {};
  if (
    typeof r.serverDomain !== "string" ||
    typeof r.stkPub !== "string" ||
    typeof r.purpose !== "string" ||
    typeof r.nonce !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverDomain !== host) {
    return { status: 403, body: { error: "serverDomain / host mismatch" } };
  }
  if (!PURPOSES.has(r.purpose as SecretMailboxPurpose)) {
    return { status: 400, body: { error: "unknown purpose" } };
  }
  if (!HEX_NONCE.test(r.nonce)) {
    return { status: 400, body: { error: "nonce must be 32 bytes hex" } };
  }
  if (!HEX64.test(r.stkPub.toLowerCase())) {
    return { status: 400, body: { error: "stkPub must be 32 bytes hex" } };
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return { status: 400, body: { error: "signature must be 64 bytes hex" } };
  }
  // Freshness window — a stale request can't be parked (replay bound).
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };

  // I2 — the posting STK MUST be the directory-bound STK for this
  // domain. A foreign STK (an attacker's box, a stolen recipe used to
  // register a different identity) is rejected here, so the phone is
  // only ever asked to seal for the registered box.
  if (!equalHex(r.stkPub, reg.identityPubKeyHex)) {
    return { status: 403, body: { error: "stkPub does not match the registered server" } };
  }

  let stkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    stkPub = hexToBytes(r.stkPub);
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }

  const claim: SecretRequest = {
    serverDomain: host,
    stkPub,
    purpose: r.purpose as SecretPurpose,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifySecretRequest(claim, sig, stkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Device-info is a display hint only (NOT signed, NOT the boundary).
  // Cap its size so a row can't be bloated; reject obvious abuse.
  let deviceInfoJson: string | null = null;
  if (b.deviceInfo !== undefined && b.deviceInfo !== null) {
    if (typeof b.deviceInfo !== "object" || jsonByteLen(b.deviceInfo) > 4096) {
      return { status: 400, body: { error: "deviceInfo too large" } };
    }
    deviceInfoJson = JSON.stringify(b.deviceInfo);
  }

  const put = await deps.secretMailbox.putRequest({
    serverDomain: host,
    username: reg.username,
    requestNonceHex: r.nonce.toLowerCase(),
    stkPubHex: r.stkPub.toLowerCase(),
    purpose: r.purpose as SecretMailboxPurpose,
    requestIssuedAt: r.issuedAt,
    requestSignatureHex: b.signature.toLowerCase(),
    deviceInfoJson,
    postedAt: now(),
    expiresAt: now() + ttlMs,
    lastPushAt: 0,
    responseSealedHex: null,
    responseIssuedAt: null,
    respondedAt: null,
    consumedAt: null,
  });
  if (!put.ok) {
    // Single-use nonce — a re-post of the same nonce is rejected.
    return { status: 409, body: { error: put.reason } };
  }

  // Fire-and-forget push so the box's poll isn't held back by APNs/FCM.
  if (deps.pushUserDevices) {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        kind: "secret-request",
        serverFqdn: host,
        purpose: r.purpose,
        requestNonceHex: r.nonce.toLowerCase(),
      }),
    );
    await deps.secretMailbox.touchLastPushAt(host, r.nonce.toLowerCase(), now());
    void deps.pushUserDevices(reg.username, "secret-request", payload).catch(() => {});
  }

  return {
    status: 200,
    body: { ok: true, requestNonceHex: r.nonce.toLowerCase(), expiresAt: now() + ttlMs },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 2. GET /api/secret-requests  (phone, IRK-signed mailbox-auth)
//
// The phone proves it owns the user's mailbox with an IRK-signed
// DeviceEndpointClaim (repurposed as the mailbox-auth credential — there
// is no hosted endpoint). `.com` verifies the claim against the user's
// registered IRK and serves only that account's pending requests.
// Includes the box device-info hint for the "is this my box?" confirm.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetSecretRequests(
  deps: SecretMailboxDeps,
  body: unknown,
): Promise<HandlerResponse> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const rows = await deps.secretMailbox.listPendingForUser(auth.username, now());
  return {
    status: 200,
    body: {
      username: auth.username,
      requests: rows.map((row) => ({
        serverDomain: row.serverDomain,
        requestNonceHex: row.requestNonceHex,
        stkPub: row.stkPubHex,
        purpose: row.purpose,
        issuedAt: row.requestIssuedAt,
        requestSignature: row.requestSignatureHex,
        deviceInfo: row.deviceInfoJson ? safeParse(row.deviceInfoJson) : null,
        postedAt: row.postedAt,
        expiresAt: row.expiresAt,
      })),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 3. POST /api/secret-response  (phone, IRK-signed mailbox-auth)
//
// The phone posts its reply for a pending request:
//   - unlock-key:  a SealedSecretResponse (sealed FOR the box's STK).
//                  `.com` stores `sealed` hex — it can't read it (I1).
//   - entitlement: an IRK-signed RootEntitlement carrier (public-signed,
//                  not secret). Stored as a JSON carrier (still I1 —
//                  signed-but-public). The box verifies it against the
//                  baked phone key.
//
// `.com` does not (and cannot) inspect the sealed payload — it only
// matches it to the request nonce + stores it write-once.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostSecretResponse(
  deps: SecretMailboxDeps,
  body: unknown,
): Promise<HandlerResponse> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const b = body as {
    response?: Record<string, unknown>;
  };
  const resp = b?.response ?? {};
  if (
    typeof resp.serverDomain !== "string" ||
    typeof resp.requestNonceHex !== "string" ||
    typeof resp.purpose !== "string" ||
    typeof resp.sealed !== "string" ||
    typeof resp.issuedAt !== "number"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (!PURPOSES.has(resp.purpose as SecretMailboxPurpose)) {
    return { status: 400, body: { error: "unknown purpose" } };
  }
  if (!HEX_NONCE.test(resp.requestNonceHex.toLowerCase())) {
    return { status: 400, body: { error: "requestNonceHex must be 32 bytes hex" } };
  }
  // The sealed payload is opaque hex; cap its size defensively.
  const sealedHex = resp.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(sealedHex) || sealedHex.length === 0 || sealedHex.length > 65536) {
    return { status: 400, body: { error: "sealed must be non-empty hex within bounds" } };
  }

  // The pending row must exist, belong to THIS user's account (so a
  // phone can only answer its own mailbox), and not yet be expired.
  const reqRow = await deps.secretMailbox.getRequest(
    resp.serverDomain,
    resp.requestNonceHex.toLowerCase(),
  );
  if (!reqRow || reqRow.expiresAt <= now()) {
    return { status: 404, body: { error: "unknown or expired request" } };
  }
  if (reqRow.username.toLowerCase() !== auth.username) {
    return { status: 403, body: { error: "request belongs to a different account" } };
  }
  if (reqRow.purpose !== resp.purpose) {
    return { status: 400, body: { error: "purpose mismatch" } };
  }

  const put = await deps.secretMailbox.putResponse(
    resp.serverDomain,
    resp.requestNonceHex.toLowerCase(),
    sealedHex,
    resp.issuedAt,
    now(),
  );
  if (!put.ok) {
    // 'unknown request' (raced expiry) → 404; 'already answered' → 409.
    const status = put.reason === "already answered" ? 409 : 404;
    return { status, body: { error: put.reason } };
  }
  return { status: 200, body: { ok: true } };
}

// ──────────────────────────────────────────────────────────────────────
// 4. GET /api/server/:domain/secret-response?nonce=  (box, polls)
//
// The box polls for its reply. Single-use: the row's reply is consumed
// (marked) on delivery so a leaked URL can't re-fetch it. `.com` returns
// only the SEALED blob — never plaintext (I1). The box unseals it with
// its STK private key.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetSecretResponse(
  deps: SecretMailboxDeps,
  host: string,
  nonceHex: string | null,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  if (!nonceHex || !HEX_NONCE.test(nonceHex.toLowerCase())) {
    return { status: 400, body: { error: "nonce query param must be 32 bytes hex" } };
  }
  // Public read (the box has no session at boot) — but bound to the
  // server_domain + nonce, so it only reveals the reply to a caller that
  // already knows the box's freshly-minted per-boot nonce. The reply is
  // sealed for the STK regardless, so disclosure is harmless.
  const row = await deps.secretMailbox.consumeResponse(host, nonceHex.toLowerCase(), now());
  if (!row || row.responseSealedHex === null) {
    return { status: 404, body: { error: "no reply ready" } };
  }
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      requestNonceHex: row.requestNonceHex,
      purpose: row.purpose,
      sealed: row.responseSealedHex,
      issuedAt: row.responseIssuedAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 5a. POST /api/server/:domain/unlock-key/lease-v2  (box-sealed lease)
//
// IRK-signed AutoUnlockLeaseV2: the key is sealed for the PINNED box STK
// (I1/I2). `.com` stores the SEALED blob + the pinned recipient. Verifies
// the IRK signature against the user's registered IRK; verifies the
// pinned stkPub is the directory-bound STK (a retargeted recipient is
// rejected — I2).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostBoxSealedLease(
  deps: SecretMailboxDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { lease?: Record<string, unknown>; signature?: unknown };
  const l = b?.lease ?? {};
  if (
    typeof l.serverDomain !== "string" ||
    typeof l.stkPub !== "string" ||
    typeof l.leaseId !== "string" ||
    typeof l.sealedKey !== "string" ||
    typeof l.issuedAt !== "number" ||
    typeof l.expiresAt !== "number" ||
    typeof b?.signature !== "string" ||
    (l.maxUses !== undefined && typeof l.maxUses !== "number")
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (l.serverDomain !== host) {
    return { status: 403, body: { error: "serverDomain / host mismatch" } };
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(l.leaseId)) {
    return { status: 400, body: { error: "leaseId must be 16-128 hex chars" } };
  }
  if (!HEX64.test(l.stkPub.toLowerCase())) {
    return { status: 400, body: { error: "stkPub must be 32 bytes hex" } };
  }
  const sealedKeyHex = l.sealedKey.toLowerCase();
  if (!/^[0-9a-f]+$/.test(sealedKeyHex) || sealedKeyHex.length > 65536) {
    return { status: 400, body: { error: "sealedKey must be hex within bounds" } };
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return { status: 400, body: { error: "signature must be 64 bytes hex" } };
  }
  if (Math.abs(now() - l.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  if (l.expiresAt <= now()) {
    return { status: 400, body: { error: "expiresAt already past" } };
  }
  if (l.maxUses !== undefined && (!Number.isInteger(l.maxUses) || l.maxUses < 1)) {
    return { status: 400, body: { error: "maxUses must be a positive integer" } };
  }

  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };

  // I2 — the pinned recipient MUST be the directory-bound STK. `.com`
  // cannot accept a lease that seals for some other box.
  if (!equalHex(l.stkPub, reg.identityPubKeyHex)) {
    return { status: 403, body: { error: "stkPub does not match the registered server" } };
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { status: 404, body: { error: "unknown user" } };

  let stkPub: Uint8Array;
  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    stkPub = hexToBytes(l.stkPub);
    sealedKey = hexToBytes(l.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }

  const lease: AutoUnlockLeaseV2 = {
    serverDomain: host,
    stkPub,
    leaseId: l.leaseId,
    sealedKey,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    ...(l.maxUses !== undefined ? { maxUses: l.maxUses } : {}),
  };
  // The lease is signed by the user IRK (the pinning of stkPub is part
  // of the canonical bytes — a `.com` retarget would fail verify, I2).
  if (!verifyAutoUnlockLeaseV2(lease, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.boxSealedLeases.put({
    serverDomain: host,
    leaseId: l.leaseId,
    stkPubHex: l.stkPub.toLowerCase(),
    sealedKeyHex,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    maxUses: l.maxUses ?? null,
    usesConsumed: 0,
    signatureHex: b.signature.toLowerCase(),
    depositedAt: now(),
  });
  return { status: 200, body: { ok: true, leaseId: l.leaseId } };
}

// ──────────────────────────────────────────────────────────────────────
// 5b. GET /api/server/:domain/unlock-key/lease-v2  (box reboot release)
//
// Returns the freshest active box-sealed lease + increments its use
// count. The box unseals the SEALED blob itself with its STK private
// key. `.com` returns only ciphertext (I1) + the IRK signature so the
// box can re-verify the lease independently of `.com`.
// ──────────────────────────────────────────────────────────────────────

export async function handleReleaseBoxSealedLease(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };

  const row = await deps.boxSealedLeases.release(host, now());
  if (!row) return { status: 404, body: { error: "no active lease" } };
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      leaseId: row.leaseId,
      stkPub: row.stkPubHex,
      // SEALED — never plaintext (I1). The box unseals with its STK key.
      sealedKey: row.sealedKeyHex,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      maxUses: row.maxUses,
      usesConsumed: row.usesConsumed,
      signature: row.signatureHex,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 5c. DELETE /api/server/:domain/unlock-key/lease-v2/:id  (IRK revoke)
//
// IRK-signed kill switch — drops the stored sealed lease so a subsequent
// reboot can't release it (the rogue-operator+host containment in §7a).
// ──────────────────────────────────────────────────────────────────────

export async function handleRevokeBoxSealedLease(
  deps: SecretMailboxDeps,
  host: string,
  leaseId: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverDomain !== "string" ||
    typeof r.leaseId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverDomain !== host) {
    return { status: 403, body: { error: "serverDomain / host mismatch" } };
  }
  if (r.leaseId !== leaseId) {
    return { status: 403, body: { error: "leaseId / url mismatch" } };
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return { status: 400, body: { error: "signature must be 64 bytes hex" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { status: 404, body: { error: "unknown user" } };

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: LeaseRevocation = {
    serverDomain: host,
    leaseId: r.leaseId,
    issuedAt: r.issuedAt,
  };
  if (!verifyLeaseRevocation(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const removed = await deps.boxSealedLeases.revoke(host, leaseId);
  return { status: 200, body: { ok: true, removed } };
}

// ──────────────────────────────────────────────────────────────────────
// 5d. GET /api/server/:domain/unlock-key/leases-v2  (public metadata)
//
// Metadata-only listing for the UI (never the sealed key). Same public-
// read posture as the legacy lease list.
// ──────────────────────────────────────────────────────────────────────

export async function handleListBoxSealedLeases(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  const rows = await deps.boxSealedLeases.list(host, now());
  return {
    status: 200,
    body: {
      leases: rows.map((row) => ({
        leaseId: row.leaseId,
        stkPub: row.stkPubHex,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        maxUses: row.maxUses,
        usesConsumed: row.usesConsumed,
        depositedAt: row.depositedAt,
      })),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Phone mailbox-auth — IRK-signed DeviceEndpointClaim.
//
// Repurposed as the mailbox-auth credential (there is no hosted
// endpoint). The phone signs a DeviceEndpointClaim binding (username,
// phoneIrkPub) with the user's IRK; `.com` verifies it against the
// account's registered IRK so it serves the mailbox ONLY to the user's
// phone. `expiresAt` keeps the claim short-lived; `nonce` makes each
// one unique.
// ──────────────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; username: string }
  | { ok: false; response: HandlerResponse };

async function authPhoneMailbox(deps: SecretMailboxDeps, body: unknown): Promise<AuthResult> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { auth?: Record<string, unknown>; authSignature?: unknown };
  const a = b?.auth ?? {};
  if (
    typeof a.username !== "string" ||
    typeof a.endpointLabel !== "string" ||
    typeof a.phoneIrkPub !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    typeof a.nonce !== "string" ||
    typeof b?.authSignature !== "string"
  ) {
    return { ok: false, response: { status: 400, body: { error: "malformed mailbox auth" } } };
  }
  if (!HEX64.test(a.phoneIrkPub.toLowerCase())) {
    return { ok: false, response: { status: 400, body: { error: "phoneIrkPub must be 32 bytes hex" } } };
  }
  if (!HEX_NONCE.test(a.nonce.toLowerCase())) {
    return { ok: false, response: { status: 400, body: { error: "auth nonce must be 32 bytes hex" } } };
  }
  if (!HEX128.test(b.authSignature.toLowerCase())) {
    return { ok: false, response: { status: 400, body: { error: "authSignature must be 64 bytes hex" } } };
  }
  // Freshness — the claim must be recent and not yet expired.
  if (Math.abs(now() - a.issuedAt) > maxAgeMs) {
    return { ok: false, response: { status: 403, body: { error: "stale mailbox auth" } } };
  }
  if (a.expiresAt <= now()) {
    return { ok: false, response: { status: 403, body: { error: "mailbox auth expired" } } };
  }

  const usernameNorm = a.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) {
    return { ok: false, response: { status: 404, body: { error: "unknown user" } } };
  }
  // The claimed phoneIrkPub MUST be the account's registered IRK — the
  // mailbox is served only to the user's own identity key.
  if (!equalHex(a.phoneIrkPub, userRec.irkPubHex)) {
    return { ok: false, response: { status: 403, body: { error: "phoneIrkPub does not match account IRK" } } };
  }

  let phoneIrkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    phoneIrkPub = hexToBytes(a.phoneIrkPub);
    nonce = hexToBytes(a.nonce);
    sig = hexToBytes(b.authSignature);
  } catch {
    return { ok: false, response: { status: 400, body: { error: "invalid hex" } } };
  }
  const claim: DeviceEndpointClaim = {
    username: a.username,
    endpointLabel: a.endpointLabel,
    phoneIrkPub,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    nonce,
  };
  if (!verifyDeviceEndpointClaim(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { ok: false, response: { status: 403, body: { error: "invalid mailbox auth signature" } } };
  }
  return { ok: true, username: usernameNorm };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
