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
import { conflict, forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

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
// The create-time pairing deposit is written when the recipe is minted and only
// CLAIMED at the box's first boot — minutes-to-days later (burn USB → boot →
// LUKS unlock → daemon). The 5-min mailbox TTL is for live boot-secret
// round-trips and is far too short here: on real hardware the deposit expired
// before the box ever booted, so create-time auto-pairing silently no-op'd.
// Give the pairing deposit a long claim window instead.
const DEFAULT_PAIRING_DEPOSIT_TTL = 14 * 24 * 60 * 60_000; // 14 days
// The entitlement deposit is written when the phone approves the first-boot
// unlock and CLAIMED by the box seconds-to-minutes later (it boots from the
// same approval). Short window — it's first-boot delivery, then the box holds
// the entitlement on disk; an unclaimed one (e.g. a routine reboot where the
// box already has its entitlement) just GCs.
const DEFAULT_ENTITLEMENT_DEPOSIT_TTL = 60 * 60_000; // 1 hour
// The SWK delivery (secret-free recipe) is deposited by the phone after the box
// registers but is CLAIMED at the box's first steady-state boot — which on real
// hardware can be many minutes (burn USB → boot → LUKS unlock → daemon) to days
// later (a box built by someone else, powered on whenever they get to it). Give
// it the same generous claim window as the pairing deposit, NOT the short live-
// mailbox TTL, so it survives a slow boot.
const DEFAULT_SWK_DEPOSIT_TTL = 14 * 24 * 60 * 60_000; // 14 days
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
    return malformed("malformed body");
  }
  if (r.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!PURPOSES.has(r.purpose as SecretMailboxPurpose)) {
    return malformed("unknown purpose");
  }
  if (!HEX_NONCE.test(r.nonce)) {
    return malformed("nonce must be 32 bytes hex");
  }
  if (!HEX64.test(r.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  // Freshness window — a stale request can't be parked (replay bound).
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  // I2 — the posting STK MUST be the directory-bound STK for this
  // domain. A foreign STK (an attacker's box, a stolen recipe used to
  // register a different identity) is rejected here, so the phone is
  // only ever asked to seal for the registered box.
  if (!equalHex(r.stkPub, reg.identityPubKeyHex)) {
    return forbidden("stkPub does not match the registered server");
  }

  let stkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    stkPub = hexToBytes(r.stkPub);
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }

  const claim: SecretRequest = {
    serverDomain: host,
    stkPub,
    purpose: r.purpose as SecretPurpose,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifySecretRequest(claim, sig, stkPub)) {
    return forbidden("invalid signature");
  }

  // Device-info is a display hint only (NOT signed, NOT the boundary).
  // Cap its size so a row can't be bloated; reject obvious abuse.
  let deviceInfoJson: string | null = null;
  if (b.deviceInfo !== undefined && b.deviceInfo !== null) {
    if (typeof b.deviceInfo !== "object" || jsonByteLen(b.deviceInfo) > 4096) {
      return malformed("deviceInfo too large");
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
    return conflict(put.reason);
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
    return malformed("malformed body");
  }
  if (!PURPOSES.has(resp.purpose as SecretMailboxPurpose)) {
    return malformed("unknown purpose");
  }
  if (!HEX_NONCE.test(resp.requestNonceHex.toLowerCase())) {
    return malformed("requestNonceHex must be 32 bytes hex");
  }
  // The sealed payload is opaque hex; cap its size defensively.
  const sealedHex = resp.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(sealedHex) || sealedHex.length === 0 || sealedHex.length > 65536) {
    return malformed("sealed must be non-empty hex within bounds");
  }

  // The pending row must exist, belong to THIS user's account (so a
  // phone can only answer its own mailbox), and not yet be expired.
  const reqRow = await deps.secretMailbox.getRequest(
    resp.serverDomain,
    resp.requestNonceHex.toLowerCase(),
  );
  if (!reqRow || reqRow.expiresAt <= now()) {
    return notFound("unknown or expired request");
  }
  if (reqRow.username.toLowerCase() !== auth.username) {
    return forbidden("request belongs to a different account");
  }
  if (reqRow.purpose !== resp.purpose) {
    return malformed("purpose mismatch");
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
    return malformed("nonce query param must be 32 bytes hex");
  }
  // Public read (the box has no session at boot) — but bound to the
  // server_domain + nonce, so it only reveals the reply to a caller that
  // already knows the box's freshly-minted per-boot nonce. The reply is
  // sealed for the STK regardless, so disclosure is harmless.
  const row = await deps.secretMailbox.consumeResponse(host, nonceHex.toLowerCase(), now());
  if (!row || row.responseSealedHex === null) {
    return notFound("no reply ready");
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
    return malformed("malformed body");
  }
  if (l.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(l.leaseId)) {
    return malformed("leaseId must be 16-128 hex chars");
  }
  if (!HEX64.test(l.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  const sealedKeyHex = l.sealedKey.toLowerCase();
  if (!/^[0-9a-f]+$/.test(sealedKeyHex) || sealedKeyHex.length > 65536) {
    return malformed("sealedKey must be hex within bounds");
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  if (Math.abs(now() - l.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }
  if (l.expiresAt <= now()) {
    return malformed("expiresAt already past");
  }
  if (l.maxUses !== undefined && (!Number.isInteger(l.maxUses) || l.maxUses < 1)) {
    return malformed("maxUses must be a positive integer");
  }

  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  // I2 — the pinned recipient MUST be the directory-bound STK. `.com`
  // cannot accept a lease that seals for some other box.
  if (!equalHex(l.stkPub, reg.identityPubKeyHex)) {
    return forbidden("stkPub does not match the registered server");
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return notFound("unknown user");

  let stkPub: Uint8Array;
  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    stkPub = hexToBytes(l.stkPub);
    sealedKey = hexToBytes(l.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
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
    return forbidden("invalid signature");
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
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const row = await deps.boxSealedLeases.release(host, now());
  if (!row) return notFound("no active lease");
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
    return malformed("malformed body");
  }
  if (r.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (r.leaseId !== leaseId) {
    return forbidden("leaseId / url mismatch");
  }
  if (!HEX128.test(b.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }
  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return notFound("unknown user");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: LeaseRevocation = {
    serverDomain: host,
    leaseId: r.leaseId,
    issuedAt: r.issuedAt,
  };
  if (!verifyLeaseRevocation(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
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
  if (!reg) return notFound("unknown server");
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
// 6a. POST /api/server/:domain/pairing-deposit  (phone, IRK mailbox-auth)
//
// Deposit-on-unlock pairing — fold the paired-session pairing INTO the
// boot-unlock approval ceremony so the box comes online ALREADY paired (no
// separate "Pair this server" tap). The phone seals an owner-IRK-signed
// `add-paired-session` order FOR the box STK and deposits it here.
//
// Authenticated EXACTLY like the unlock-reply (`handlePostSecretResponse`):
// the IRK-signed mailbox-auth (`authPhoneMailbox`) proves the phone owns the
// account's mailbox. `.com` stores the OPAQUE sealed blob — it never sees the
// token (I1). The box does a public, consume-once read (6b) at startup.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostPairingDeposit(
  deps: SecretMailboxDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  // create→first-boot gap, not a live round-trip — use the long deposit TTL.
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_PAIRING_DEPOSIT_TTL;

  const b = body as { deposit?: Record<string, unknown> };
  const d = b?.deposit ?? {};
  if (
    typeof d.serverDomain !== "string" ||
    typeof d.requestNonceHex !== "string" ||
    typeof d.stkPub !== "string" ||
    typeof d.sealed !== "string" ||
    typeof d.issuedAt !== "number"
  ) {
    return malformed("malformed body");
  }
  if (d.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX_NONCE.test(d.requestNonceHex.toLowerCase())) {
    return malformed("requestNonceHex must be 32 bytes hex");
  }
  if (!HEX64.test(d.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  const sealedHex = d.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(sealedHex) || sealedHex.length === 0 || sealedHex.length > 65536) {
    return malformed("sealed must be non-empty hex within bounds");
  }
  if (Math.abs(now() - d.issuedAt) > (deps.maxAgeMs ?? DEFAULT_MAX_AGE)) {
    return forbidden("stale request");
  }

  const reg = await deps.servers.get(host);
  if (reg?.revokedAt) return forbidden("server is revoked");
  if (reg) {
    // POST-registration deposit (e.g. a later re-pair): bind to the registered
    // account AND identity (I2) — the strongest check, used when we have it.
    if (reg.username.toLowerCase() !== auth.username) {
      return forbidden("server belongs to a different account");
    }
    if (!equalHex(d.stkPub, reg.identityPubKeyHex)) {
      return forbidden("stkPub does not match the registered server");
    }
  } else {
    // CREATE-TIME deposit (pre-registration): the creating phone deposits the
    // pairing the moment it mints the recipe, BEFORE the box has ever booted +
    // registered — so there is no directory identity to bind against yet. The
    // IRK mailbox-auth proves the owner, and the fqdn must sit under the owner's
    // namespace (`<server>.<username>.flagship.services`). The SEAL is the real
    // binding: the box only ever unseals a blob sealed to ITS OWN stk and
    // verifies the order's owner-IRK signature on consume, so a wrong/forged
    // stkPub is inert ciphertext. This is what makes "waiting for the server"
    // survive a phone refresh — the link lives in `.com` until the box claims it.
    const ownerLabel = host.toLowerCase().split(".")[1];
    if (ownerLabel !== auth.username) {
      return forbidden("fqdn is not under the authed account");
    }
  }

  const put = await deps.secretMailbox.putPairingDeposit({
    serverDomain: host,
    username: reg?.username ?? auth.username,
    requestNonceHex: d.requestNonceHex.toLowerCase(),
    stkPubHex: d.stkPub.toLowerCase(),
    sealedHex,
    issuedAt: d.issuedAt,
    expiresAt: now() + ttlMs,
  });
  if (!put.ok) {
    return conflict(put.reason);
  }
  return { status: 200, body: { ok: true, expiresAt: now() + ttlMs } };
}

// ──────────────────────────────────────────────────────────────────────
// 6b. GET /api/server/:domain/pairing-deposit  (box, public consume-once)
//
// PUBLIC + domain-scoped + consume-once — the IDENTICAL security posture as
// `handleReleaseBoxSealedLease`: the box has no session at boot, and the blob
// is sealed FOR the box STK, so a public read reveals nothing. Consume-once +
// the registration check bound abuse. Returns the freshest pending sealed
// pairing blob (and marks it consumed) or 404.
// ──────────────────────────────────────────────────────────────────────

export async function handleConsumePairingDeposit(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const row = await deps.secretMailbox.consumePairingDeposit(host, now());
  if (!row) return notFound("no pairing deposit ready");
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      requestNonceHex: row.requestNonceHex,
      stkPub: row.stkPubHex,
      // SEALED for the box STK — never plaintext (I1). The box unseals it.
      sealed: row.sealedHex,
      issuedAt: row.issuedAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 6c. POST /api/server/:domain/entitlement-deposit  (phone, IRK mailbox-auth)
//     GET  /api/server/:domain/entitlement-deposit  (box, public consume-once)
//
// Fold "authorize it to serve" INTO the first-boot unlock approval: when the
// phone unseals the LUKS key it ALSO mints an owner-IRK-signed RootEntitlement
// for the box's STK (which it holds from the unlock request) and deposits it
// here, so the box claims it on boot with NO second tap. Same store-and-forward
// posture as the pairing deposit — EXCEPT the blob is the PUBLIC IRK-signed
// entitlement (what the box presents at HELLO), not an encrypted secret, so the
// public consume-once GET is harmless. The box verifies under the owner IRK.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostEntitlementDeposit(
  deps: SecretMailboxDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_ENTITLEMENT_DEPOSIT_TTL;

  const b = body as { deposit?: Record<string, unknown> };
  const d = b?.deposit ?? {};
  if (
    typeof d.serverDomain !== "string" ||
    typeof d.requestNonceHex !== "string" ||
    typeof d.stkPub !== "string" ||
    typeof d.sealed !== "string" ||
    typeof d.issuedAt !== "number"
  ) {
    return malformed("malformed body");
  }
  if (d.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX_NONCE.test(d.requestNonceHex.toLowerCase())) {
    return malformed("requestNonceHex must be 32 bytes hex");
  }
  if (!HEX64.test(d.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  const carrierHex = d.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(carrierHex) || carrierHex.length === 0 || carrierHex.length > 65536) {
    return malformed("carrier must be non-empty hex within bounds");
  }
  if (Math.abs(now() - d.issuedAt) > (deps.maxAgeMs ?? DEFAULT_MAX_AGE)) {
    return forbidden("stale request");
  }

  // The entitlement binds a REGISTERED box's STK (I2). The box always registers
  // at install — before its first steady-state boot/unlock — so a deposit always
  // has a directory identity to bind against.
  const reg = await deps.servers.get(host);
  if (!reg) return forbidden("server not registered");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (reg.username.toLowerCase() !== auth.username) {
    return forbidden("server belongs to a different account");
  }
  if (!equalHex(d.stkPub, reg.identityPubKeyHex)) {
    return forbidden("stkPub does not match the registered server");
  }

  const put = await deps.secretMailbox.putEntitlementDeposit({
    serverDomain: host,
    username: reg.username,
    requestNonceHex: d.requestNonceHex.toLowerCase(),
    stkPubHex: d.stkPub.toLowerCase(),
    sealedHex: carrierHex,
    issuedAt: d.issuedAt,
    expiresAt: now() + ttlMs,
  });
  if (!put.ok) {
    return conflict(put.reason);
  }
  return { status: 200, body: { ok: true, expiresAt: now() + ttlMs } };
}

export async function handleConsumeEntitlementDeposit(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const row = await deps.secretMailbox.consumeEntitlementDeposit(host, now());
  if (!row) return notFound("no entitlement deposit ready");
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      requestNonceHex: row.requestNonceHex,
      stkPub: row.stkPubHex,
      // PUBLIC IRK-signed entitlement carrier (not sealed) — the box verifies
      // it under the owner IRK + binds it to its STK/podCanonical.
      sealed: row.sealedHex,
      issuedAt: row.issuedAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 6c-bis. POST /api/server/:domain/swk-deposit  (phone, IRK mailbox-auth)
//         GET  /api/server/:domain/swk-deposit  (box, public consume-once)
//
// Secret-free-recipe SWK delivery (docs/recipe-delivery-and-remote-install.md).
// The recipe carries NO SWK; the box boots platform-less, registers, and the
// phone seals the SWK to the box's OWN identity (generated at first boot) and
// IRK-signs the wrapper, then deposits it here. The box claims it on boot and
// turns on its service platform. Same store-and-forward posture as the pairing
// deposit — and like pairing the carrier is SEALED, so the public consume-once
// GET reveals only ciphertext (`.com` stays content-blind; the box unseals it
// with its identity key). The deposit binds the box's REGISTERED STK (I2).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostSwkDeposit(
  deps: SecretMailboxDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_SWK_DEPOSIT_TTL;

  const b = body as { deposit?: Record<string, unknown> };
  const d = b?.deposit ?? {};
  if (
    typeof d.serverDomain !== "string" ||
    typeof d.requestNonceHex !== "string" ||
    typeof d.stkPub !== "string" ||
    typeof d.sealed !== "string" ||
    typeof d.issuedAt !== "number"
  ) {
    return malformed("malformed body");
  }
  if (d.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX_NONCE.test(d.requestNonceHex.toLowerCase())) {
    return malformed("requestNonceHex must be 32 bytes hex");
  }
  if (!HEX64.test(d.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  const carrierHex = d.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(carrierHex) || carrierHex.length === 0 || carrierHex.length > 65536) {
    return malformed("carrier must be non-empty hex within bounds");
  }
  if (Math.abs(now() - d.issuedAt) > (deps.maxAgeMs ?? DEFAULT_MAX_AGE)) {
    return forbidden("stale request");
  }

  // Bind a REGISTERED box's STK (I2). The box registers at install — before its
  // first steady-state boot — so a deposit always has a directory identity to
  // bind against. The owner must own the box.
  const reg = await deps.servers.get(host);
  if (!reg) return forbidden("server not registered");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (reg.username.toLowerCase() !== auth.username) {
    return forbidden("server belongs to a different account");
  }
  if (!equalHex(d.stkPub, reg.identityPubKeyHex)) {
    return forbidden("stkPub does not match the registered server");
  }

  const put = await deps.secretMailbox.putSwkDeposit({
    serverDomain: host,
    username: reg.username,
    requestNonceHex: d.requestNonceHex.toLowerCase(),
    stkPubHex: d.stkPub.toLowerCase(),
    sealedHex: carrierHex,
    issuedAt: d.issuedAt,
    expiresAt: now() + ttlMs,
  });
  if (!put.ok) {
    return conflict(put.reason);
  }
  return { status: 200, body: { ok: true, expiresAt: now() + ttlMs } };
}

export async function handleConsumeSwkDeposit(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const row = await deps.secretMailbox.consumeSwkDeposit(host, now());
  if (!row) return notFound("no swk deposit ready");
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      requestNonceHex: row.requestNonceHex,
      stkPub: row.stkPubHex,
      // SEALED SWK-delivery carrier — the box verifies the owner-IRK signature +
      // unseals the SWK with its identity key. `.com` holds ciphertext only.
      sealed: row.sealedHex,
      issuedAt: row.issuedAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 6d. GET /api/server/:domain/self-delete  (box, public consume-once)
//
// Account-death content-wipe delivery. `.com` deposited the owner-IRK-signed
// `servers-self-delete` order into the `self-delete` lane during the
// last-device account-deletion bundle commit (handleAccountDeletionBundle).
// The box polls this on its heartbeat cadence, consumes the order once, and —
// after re-verifying it under the owner IRK — wipes its content.
//
// CRITICAL: this consume is deliberately REVOKE-TOLERANT — unlike the
// entitlement/pairing consume (which 403 on `reg.revokedAt`). The deletion
// ceremony revokes the server during teardown, so a revoked-guard would make
// the order undeliverable. It is safe to serve post-revoke because the carrier
// is the PUBLIC, owner-IRK-signed order (a relay can't forge it) and the box
// re-verifies it under the config-pinned owner IRK before acting.
// ──────────────────────────────────────────────────────────────────────

export async function handleConsumeSelfDeleteDeposit(
  deps: SecretMailboxDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  // NB: NO `reg.revokedAt` guard — see the revoke-tolerance note above.

  const row = await deps.secretMailbox.consumeSelfDeleteDeposit(host, now());
  if (!row) return notFound("no self-delete order ready");
  return {
    status: 200,
    body: {
      serverDomain: row.serverDomain,
      requestNonceHex: row.requestNonceHex,
      stkPub: row.stkPubHex,
      // PUBLIC owner-IRK-signed servers-self-delete order carrier — the box
      // re-verifies it under the config-pinned owner IRK before wiping.
      sealed: row.sealedHex,
      issuedAt: row.issuedAt,
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

export type AuthResult =
  | { ok: true; username: string }
  | { ok: false; response: HandlerResponse };

export async function authPhoneMailbox(deps: SecretMailboxDeps, body: unknown): Promise<AuthResult> {
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
    return { ok: false, response: malformed("malformed mailbox auth") };
  }
  if (!HEX64.test(a.phoneIrkPub.toLowerCase())) {
    return { ok: false, response: malformed("phoneIrkPub must be 32 bytes hex") };
  }
  if (!HEX_NONCE.test(a.nonce.toLowerCase())) {
    return { ok: false, response: malformed("auth nonce must be 32 bytes hex") };
  }
  if (!HEX128.test(b.authSignature.toLowerCase())) {
    return { ok: false, response: malformed("authSignature must be 64 bytes hex") };
  }
  // Freshness — the claim must be recent and not yet expired.
  if (Math.abs(now() - a.issuedAt) > maxAgeMs) {
    return { ok: false, response: forbidden("stale mailbox auth") };
  }
  if (a.expiresAt <= now()) {
    return { ok: false, response: forbidden("mailbox auth expired") };
  }

  const usernameNorm = a.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) {
    return { ok: false, response: notFound("unknown user") };
  }
  // The claimed phoneIrkPub MUST be the account's registered IRK — the
  // mailbox is served only to the user's own identity key.
  if (!equalHex(a.phoneIrkPub, userRec.irkPubHex)) {
    return { ok: false, response: forbidden("phoneIrkPub does not match account IRK") };
  }

  let phoneIrkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    phoneIrkPub = hexToBytes(a.phoneIrkPub);
    nonce = hexToBytes(a.nonce);
    sig = hexToBytes(b.authSignature);
  } catch {
    return { ok: false, response: malformed("invalid hex") };
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
    return { ok: false, response: forbidden("invalid mailbox auth signature") };
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
