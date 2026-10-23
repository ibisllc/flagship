/**
 * boot.flagshipserver.com — the dedicated, cloneable boot worker routes.
 *
 * Every route is identity-gated (see gate.ts): box-STK signatures may
 * READ; owner-IRK signatures may WRITE. The signature travels in the
 * `Authorization` header; the body carries only ciphertext + the
 * box/owner-verifiable lease/response artifacts. The worker never sees
 * plaintext keys (invariant I1 carried over from the relay model).
 *
 * Endpoint contract (FIXED — box + mobile are wired to these):
 *   PUT    /api/boot/lease                          owner-IRK  deposit box-sealed lease
 *   GET    /api/boot/lease/:serverDomain            box-STK    fetch the sealed lease
 *   DELETE /api/boot/lease/:serverDomain/:leaseId   owner-IRK  revoke (kill switch)
 *   POST   /api/boot/request                        box-STK    announce need → notify pipe
 *   GET    /api/boot/response/:serverDomain/:nonce  box-STK    poll for the sealed response
 *   POST   /api/boot/response                       owner-IRK  post the sealed response
 *   DELETE /api/boot/lease/:serverDomain            owner-IRK  revoke EVERY lease for the server
 *   PUT    /api/boot/suspension                     owner-IRK  lock / resume (new epoch)
 *   POST   /api/boot/suspension/box                 box-STK    set-only lock (dead-man, manual)
 *   GET    /api/boot/suspension/:serverDomain       owner|box  read the lock state
 */

import {
  verifyAutoUnlockLeaseV2,
  verifyBootSuspension,
  initialSuspension,
  type BootSuspensionOrder,
  verifySecretRequest,
  type AutoUnlockLeaseV2,
  type SecretPurpose,
  type SecretRequest,
} from "@flagship/protocol";
import type {
  BootSuspensionStorage,
  BoxSealedLeaseStorage,
  SecretMailboxStorage,
  SecretMailboxPurpose,
} from "@flagship/storage";
import { gate, type GateDeps } from "./gate.js";
import { equalHex, hexToBytes } from "./hex.js";
import type { DirectoryClient } from "./directory.js";
import type { NotifyPipe } from "./notify.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const HEX_NONCE = /^[0-9a-f]{64}$/; // 32 bytes
const LEASE_ID = /^[0-9a-fA-F]{16,128}$/;

// 10 min — the LIVENESS window, not a deadline. The box waits for the phone
// effectively forever and re-announces (heartbeat) every ~2 min, refreshing
// this row's expiry, so a waiting box keeps the request visible + approvable
// indefinitely. Once the box powers off the heartbeats stop and the row lapses
// in ~10 min, which is how the phone honestly flips from "waiting" to "box
// stopped — power-cycle it." Re-announce refreshes expiry but does NOT re-push.
const DEFAULT_MAILBOX_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_PUSH_DEDUP_MS = 60_000;

const PURPOSES: ReadonlySet<SecretMailboxPurpose> = new Set<SecretMailboxPurpose>([
  "unlock-key",
  "entitlement",
]);

export interface BootRouteDeps {
  boxSealedLeases: BoxSealedLeaseStorage;
  bootSuspensions: BootSuspensionStorage;
  secretMailbox: SecretMailboxStorage;
  directory: DirectoryClient;
  notify: NotifyPipe;
  gate: GateDeps;
  maxAgeMs?: number;
  mailboxTtlMs?: number;
  /** Skip the notify push if one fired for this row within this window. */
  pushDedupMs?: number;
  now?: () => number;
}

export interface BootResponse {
  status: number;
  body: unknown;
}

const ROUTE_RE = {
  LEASE_DEPOSIT: /^\/api\/boot\/lease$/,
  LEASE_GET: /^\/api\/boot\/lease\/([^/]+)$/,
  LEASE_REVOKE: /^\/api\/boot\/lease\/([^/]+)\/([^/]+)$/,
  LEASE_REVOKE_ALL: /^\/api\/boot\/lease\/([^/]+)$/,
  SUSPENSION_SET: /^\/api\/boot\/suspension$/,
  SUSPENSION_BOX: /^\/api\/boot\/suspension\/box$/,
  SUSPENSION_GET: /^\/api\/boot\/suspension\/([^/]+)$/,
  REQUEST_POST: /^\/api\/boot\/request$/,
  RESPONSE_GET: /^\/api\/boot\/response\/([^/]+)\/([^/]+)$/,
  RESPONSE_POST: /^\/api\/boot\/response$/,
  SHARE_PENDING: /^\/api\/boot\/share\/pending\/([^/]+)$/,
  SHARE_KEY: /^\/api\/boot\/share\/key\/([^/]+)$/,
} as const;

/**
 * Dispatch a /api/boot/* request. Returns null when the path isn't a
 * boot route (the caller falls through to a 404). The router applies
 * `Cache-Control: no-store` (rule 5) to every boot response.
 */
export async function routeBoot(
  deps: BootRouteDeps,
  method: string,
  path: string,
  authHeader: string | null,
  body: unknown,
): Promise<BootResponse | null> {
  const m = method.toUpperCase();
  let g: RegExpMatchArray | null;

  if (m === "PUT" && ROUTE_RE.LEASE_DEPOSIT.test(path)) {
    return handleDepositLease(deps, path, authHeader, body);
  }
  if (m === "GET" && (g = path.match(ROUTE_RE.LEASE_GET))) {
    return handleGetLease(deps, path, authHeader, decodeURIComponent(g[1]!));
  }
  if (m === "DELETE" && (g = path.match(ROUTE_RE.LEASE_REVOKE))) {
    return handleRevokeLease(
      deps,
      path,
      authHeader,
      decodeURIComponent(g[1]!),
      decodeURIComponent(g[2]!),
      body,
    );
  }
  if (m === "DELETE" && (g = path.match(ROUTE_RE.LEASE_REVOKE_ALL))) {
    return handleRevokeAllLeases(deps, path, authHeader, decodeURIComponent(g[1]!));
  }
  if (m === "PUT" && ROUTE_RE.SUSPENSION_SET.test(path)) {
    return handleSetSuspension(deps, path, authHeader, body, "owner");
  }
  if (m === "POST" && ROUTE_RE.SUSPENSION_BOX.test(path)) {
    return handleSetSuspension(deps, path, authHeader, body, "box");
  }
  if (m === "GET" && (g = path.match(ROUTE_RE.SUSPENSION_GET)) && g[1] !== "box") {
    return handleGetSuspension(deps, path, authHeader, decodeURIComponent(g[1]!));
  }
  if (m === "POST" && ROUTE_RE.REQUEST_POST.test(path)) {
    return handlePostRequest(deps, path, authHeader, body);
  }
  if (m === "GET" && (g = path.match(ROUTE_RE.RESPONSE_GET))) {
    return handleGetResponse(
      deps,
      path,
      authHeader,
      decodeURIComponent(g[1]!),
      decodeURIComponent(g[2]!),
    );
  }
  if (m === "POST" && ROUTE_RE.RESPONSE_POST.test(path)) {
    return handlePostResponse(deps, path, authHeader, body);
  }
  if (m === "GET" && (g = path.match(ROUTE_RE.SHARE_PENDING))) {
    return handleSharePending(deps, path, authHeader, decodeURIComponent(g[1]!));
  }
  if (m === "GET" && (g = path.match(ROUTE_RE.SHARE_KEY))) {
    return handleShareKey(deps, path, authHeader, decodeURIComponent(g[1]!));
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// PUT /api/boot/lease  — owner-IRK deposit of a box-sealed lease.
// ──────────────────────────────────────────────────────────────────────

async function handleDepositLease(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  body: unknown,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  // Rule 1 — malformed body rejected before any auth work.
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
  if (!LEASE_ID.test(l.leaseId)) return { status: 400, body: { error: "leaseId must be 16-128 hex chars" } };
  if (!HEX64.test(l.stkPub.toLowerCase())) return { status: 400, body: { error: "stkPub must be 32 bytes hex" } };
  const sealedKeyHex = l.sealedKey.toLowerCase();
  if (!/^[0-9a-f]+$/.test(sealedKeyHex) || sealedKeyHex.length > 65536) {
    return { status: 400, body: { error: "sealedKey must be hex within bounds" } };
  }
  if (!HEX128.test(b.signature.toLowerCase())) return { status: 400, body: { error: "signature must be 64 bytes hex" } };
  if (l.expiresAt <= now()) return { status: 400, body: { error: "expiresAt already past" } };
  if (l.maxUses !== undefined && (!Number.isInteger(l.maxUses) || l.maxUses < 1)) {
    return { status: 400, body: { error: "maxUses must be a positive integer" } };
  }

  // Rules 2-4 — owner-IRK gate bound to (PUT, this path, serverDomain).
  const auth = await gate(deps.gate, { role: "owner", serverDomain: l.serverDomain, method: "PUT", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  // I2 — the lease's pinned recipient MUST be the directory-bound box
  // STK; the worker never accepts a lease that seals for another box.
  const dirStk = await deps.directory.boxStkForDomain(l.serverDomain);
  if (dirStk === null) return { status: 404, body: { error: "unknown server" } };
  if (!equalHex(l.stkPub, dirStk)) {
    return { status: 403, body: { error: "stkPub does not match the registered server" } };
  }

  // The lease body is ALSO IRK-signed (signature_hex is released to the
  // box so it can re-verify the lease independently of the worker). Verify
  // it against the SAME account IRK the gate bound — the body signature
  // and the Authorization signature are by the same owner key.
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
    serverDomain: l.serverDomain,
    stkPub,
    leaseId: l.leaseId,
    sealedKey,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    ...(l.maxUses !== undefined ? { maxUses: l.maxUses } : {}),
  };
  if (!verifyAutoUnlockLeaseV2(lease, sig, hexToBytes(auth.pubKeyHex))) {
    return { status: 403, body: { error: "invalid lease signature" } };
  }

  await deps.boxSealedLeases.put({
    serverDomain: l.serverDomain,
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
// PUT /api/boot/suspension (owner) and POST /api/boot/suspension/box (STK):
// set the durable boot suspension (SEC-LOCK-001). The body is an order signed
// by the same key the Authorization header names; the record keeps that
// signature so the box and the phones can check it themselves.
// ──────────────────────────────────────────────────────────────────────

const SUSPENSION_REASONS = new Set(["manual-lock", "dead-man", "box-fail-closed", "owner-suspend", "owner-resume"]);

async function handleSetSuspension(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  body: unknown,
  signer: "owner" | "box",
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  const b = body as { order?: Record<string, unknown>; signature?: unknown };
  const o = b?.order ?? {};
  if (
    typeof o.serverDomain !== "string" || o.serverDomain.length === 0 ||
    !Number.isSafeInteger(o.epoch) || !Number.isSafeInteger(o.seq) || !Number.isSafeInteger(o.issuedAt) ||
    (o.action !== "suspend" && o.action !== "resume") ||
    typeof o.reason !== "string" || !SUSPENSION_REASONS.has(o.reason) ||
    o.signer !== signer ||
    typeof b?.signature !== "string" || !HEX128.test(b.signature.toLowerCase())
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  const order = o as unknown as BootSuspensionOrder;

  const auth = await gate(deps.gate, { role: signer, serverDomain: order.serverDomain, method: signer === "owner" ? "PUT" : "POST", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  if (!verifyBootSuspension(order, sig, hexToBytes(auth.pubKeyHex))) {
    return { status: 403, body: { error: "invalid suspension signature" } };
  }

  let outcome;
  try {
    outcome = await deps.bootSuspensions.apply(order, b.signature.toLowerCase(), now());
  } catch {
    // Could not record it: say so. The caller must not believe it is locked.
    return { status: 503, body: { error: "could not record the suspension", durable: false } };
  }
  if (!outcome.ok) {
    return { status: 409, body: { error: "suspension refused", code: outcome.code, current: publicSuspension(outcome.current) } };
  }
  let leasesRevoked = 0;
  if (outcome.state.suspended) {
    // Anything deposited before a lock must not come back on resume: the owner
    // deposits a fresh, bounded lease after resuming.
    try {
      leasesRevoked = await deps.boxSealedLeases.revokeAll(order.serverDomain);
    } catch {
      return { status: 503, body: { error: "suspended, but the leases could not be removed", durable: true, state: publicSuspension(outcome.state) } };
    }
  }
  return { status: 200, body: { ok: true, durable: true, changed: outcome.changed, leasesRevoked, state: publicSuspension(outcome.state) } };
}

async function handleGetSuspension(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
): Promise<BootResponse> {
  const auth = await gate(deps.gate, { role: ["owner", "box"], serverDomain, method: "GET", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  try {
    const st = (await deps.bootSuspensions.get(serverDomain)) ?? initialSuspension(serverDomain);
    return { status: 200, body: publicSuspension(st) };
  } catch {
    return { status: 503, body: { error: "could not read the suspension" } };
  }
}

function publicSuspension(st: ReturnType<typeof initialSuspension>) {
  return {
    serverDomain: st.serverDomain,
    suspended: st.suspended,
    epoch: st.epoch,
    seq: st.seq,
    reason: st.reason,
    signer: st.signer,
    orderIssuedAt: st.orderIssuedAt,
    updatedAt: st.updatedAt,
    signature: st.signatureHex,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/boot/lease/:serverDomain  — box-STK fetch of the sealed lease.
// ──────────────────────────────────────────────────────────────────────

async function handleGetLease(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  const auth = await gate(deps.gate, { role: "box", serverDomain, method: "GET", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const row = await deps.boxSealedLeases.release(serverDomain, now());
  if (!row) {
    // release() hands out nothing for a suspended server; say so, so the box
    // asks the phone instead of retrying. Never reveals more than the lock bit.
    let suspended = false;
    try {
      const st = await deps.bootSuspensions.get(serverDomain);
      suspended = st?.suspended === true;
    } catch {
      suspended = true;
    }
    return suspended
      ? { status: 423, body: { error: "suspended", suspended: true } }
      : { status: 404, body: { error: "no active lease" } };
  }
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
// DELETE /api/boot/lease/:serverDomain/:leaseId  — owner-IRK revoke.
// ──────────────────────────────────────────────────────────────────────

async function handleRevokeLease(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
  leaseId: string,
  _body: unknown,
): Promise<BootResponse> {
  if (!LEASE_ID.test(leaseId)) return { status: 400, body: { error: "leaseId must be 16-128 hex chars" } };
  const auth = await gate(deps.gate, { role: "owner", serverDomain, method: "DELETE", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const removed = await deps.boxSealedLeases.revoke(serverDomain, leaseId);
  return { status: 200, body: { ok: true, removed } };
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/boot/lease/:serverDomain  — owner-IRK revoke of every lease.
// Used when the dead-man switch is switched on: no lease deposited before it
// may outlive the affirmation (SEC-DEADMAN-001).
// ──────────────────────────────────────────────────────────────────────

async function handleRevokeAllLeases(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
): Promise<BootResponse> {
  const auth = await gate(deps.gate, { role: "owner", serverDomain, method: "DELETE", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  const removed = await deps.boxSealedLeases.revokeAll(serverDomain);
  return { status: 200, body: { ok: true, removed } };
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/boot/request  — box-STK announces it needs approval.
//
// Parks the request (single-use nonce) and fires the NOTIFY PIPE,
// DEDUPED per (serverDomain, requestNonce): a re-announce of the same
// nonce collapses to ONE push. Idempotent — a re-post returns 200.
// ──────────────────────────────────────────────────────────────────────

async function handlePostRequest(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  body: unknown,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_MAILBOX_TTL_MS;
  // Push dedup is no longer consulted on a re-announce: a heartbeat (duplicate
  // nonce) refreshes the TTL and returns deduped WITHOUT re-notifying, so a
  // single push fires per nonce regardless of heartbeat cadence. The
  // pushDedupMs config surface is retained for callers but unused here.
  void (deps.pushDedupMs ?? DEFAULT_PUSH_DEDUP_MS);

  // Rule 1 — malformed body (the box's STK-signed SecretRequest envelope).
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
  if (!PURPOSES.has(r.purpose as SecretMailboxPurpose)) return { status: 400, body: { error: "unknown purpose" } };
  if (!HEX_NONCE.test(r.nonce.toLowerCase())) return { status: 400, body: { error: "nonce must be 32 bytes hex" } };
  if (!HEX64.test(r.stkPub.toLowerCase())) return { status: 400, body: { error: "stkPub must be 32 bytes hex" } };
  if (!HEX128.test(b.signature.toLowerCase())) return { status: 400, body: { error: "signature must be 64 bytes hex" } };

  // Rules 2-4 — box-STK gate bound to (POST, this path, serverDomain).
  const auth = await gate(deps.gate, { role: "box", serverDomain: r.serverDomain, method: "POST", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  // The Authorization signer is the directory-bound box STK (gate rule
  // 4). The request body's `stkPub` MUST equal it — the request is for
  // the same box that announced it.
  if (!equalHex(r.stkPub, auth.pubKeyHex)) {
    return { status: 403, body: { error: "request stkPub does not match the announcing box" } };
  }

  // Re-verify the SecretRequest body signature against the box STK — the
  // phone will re-verify this exact artifact against its directory, so
  // the worker stores a genuine signature, not whatever the transport
  // claimed.
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
    serverDomain: r.serverDomain,
    stkPub,
    purpose: r.purpose as SecretPurpose,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifySecretRequest(claim, sig, stkPub)) {
    return { status: 403, body: { error: "invalid request signature" } };
  }

  // Device-info is a display hint only (NOT signed, NOT the boundary).
  let deviceInfoJson: string | null = null;
  if (b.deviceInfo !== undefined && b.deviceInfo !== null) {
    if (typeof b.deviceInfo !== "object" || JSON.stringify(b.deviceInfo).length > 4096) {
      return { status: 400, body: { error: "deviceInfo too large" } };
    }
    deviceInfoJson = JSON.stringify(b.deviceInfo);
  }

  // Scope the parked row to the OWNING account so the phone's per-account
  // `/api/secret-requests` listing surfaces it. In the CONSOLIDATED (apps/com)
  // deployment this row IS the row the phone reads, so the real username is
  // load-bearing. The standalone worker also benefits (its row is then
  // self-describing), and the directory is the authority for the mapping.
  // Falls back to the serverDomain only if the directory can't resolve a
  // username (it just resolved the box STK in the gate, so this is rare).
  const nonceHex = r.nonce.toLowerCase();
  const owningUsername =
    (await deps.directory.usernameForDomain(r.serverDomain)) ?? usernameOrDomain(r.serverDomain);
  const put = await deps.secretMailbox.putRequest({
    serverDomain: r.serverDomain,
    username: owningUsername,
    requestNonceHex: nonceHex,
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

  // Idempotency + per-nonce dedup. A duplicate nonce is NOT an error — it is
  // the box's HEARTBEAT re-announcing the SAME parked request (same nonce). A
  // heartbeat must (a) refresh the row's TTL so a short DEFAULT_MAILBOX_TTL_MS
  // stays alive while the box waits, and (b) NEVER re-notify — the first
  // announce already pushed the phone. So on a duplicate we bump expires_at and
  // return deduped without touching the notify pipe.
  if (!put.ok) {
    if (put.reason !== "duplicate nonce") {
      return { status: 409, body: { error: put.reason } };
    }
    const refreshedExpiry = now() + ttlMs;
    await deps.secretMailbox.refreshExpiry(r.serverDomain, nonceHex, refreshedExpiry);
    return {
      status: 200,
      body: { ok: true, requestNonceHex: nonceHex, deduped: true, expiresAt: refreshedExpiry },
    };
  }

  // Fire the notify pipe (server-to-server → identity plane → push).
  // Marked-before-send so a concurrent re-announce within the window
  // dedups even if the push round-trip is slow.
  await deps.secretMailbox.touchLastPushAt(r.serverDomain, nonceHex, now());
  void deps.notify
    .notifyOwner({
      serverDomain: r.serverDomain,
      // Forward the box's STK-signed SecretRequest verbatim — the
      // identity plane re-verifies it against its directory (does NOT
      // trust the worker's echo) before pushing.
      signedRequest: { request: r, signature: b.signature, ...(b.deviceInfo ? { deviceInfo: b.deviceInfo } : {}) },
      purpose: r.purpose as SecretMailboxPurpose,
    })
    .catch(() => {});

  return { status: 200, body: { ok: true, requestNonceHex: nonceHex, expiresAt: now() + ttlMs } };
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/boot/response/:serverDomain/:nonce  — box-STK poll.
// ──────────────────────────────────────────────────────────────────────

async function handleGetResponse(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
  nonceHex: string,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  if (!HEX_NONCE.test(nonceHex.toLowerCase())) {
    return { status: 400, body: { error: "nonce must be 32 bytes hex" } };
  }
  const auth = await gate(deps.gate, { role: "box", serverDomain, method: "GET", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const row = await deps.secretMailbox.consumeResponse(serverDomain, nonceHex.toLowerCase(), now());
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
// POST /api/boot/response  — owner-IRK posts the sealed response.
// ──────────────────────────────────────────────────────────────────────

async function handlePostResponse(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  body: unknown,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());

  // Rule 1 — malformed body.
  const b = body as { response?: Record<string, unknown> };
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
  if (!PURPOSES.has(resp.purpose as SecretMailboxPurpose)) return { status: 400, body: { error: "unknown purpose" } };
  if (!HEX_NONCE.test(resp.requestNonceHex.toLowerCase())) {
    return { status: 400, body: { error: "requestNonceHex must be 32 bytes hex" } };
  }
  const sealedHex = resp.sealed.toLowerCase();
  if (!/^[0-9a-f]*$/.test(sealedHex) || sealedHex.length === 0 || sealedHex.length > 65536) {
    return { status: 400, body: { error: "sealed must be non-empty hex within bounds" } };
  }

  // Rules 2-4 — the boot-approval write. This is the ONE route a watch
  // delegate may sign: the owner IRK (full biometric) OR an active
  // boot-approval delegate (the phone's .userPresence key, triggered from
  // the Watch without a fresh Face ID prompt). Every other owner route
  // (deposit/revoke lease) stays IRK-only — least-destructive scoping.
  const auth = await gate(
    deps.gate,
    { role: ["owner", "delegate", "share"], serverDomain: resp.serverDomain, method: "POST", path },
    authHeader,
  );
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  // A share may approve the disk unlock only; the entitlement is the owner's.
  if (auth.role === "share" && resp.purpose !== "unlock-key") {
    return { status: 403, body: { error: "a share can only approve the disk unlock" } };
  }

  // The pending row must exist + not be expired + match the purpose.
  const reqRow = await deps.secretMailbox.getRequest(resp.serverDomain, resp.requestNonceHex.toLowerCase());
  if (!reqRow || reqRow.expiresAt <= now()) {
    return { status: 404, body: { error: "unknown or expired request" } };
  }
  if (reqRow.purpose !== resp.purpose) return { status: 400, body: { error: "purpose mismatch" } };

  const put = await deps.secretMailbox.putResponse(
    resp.serverDomain,
    resp.requestNonceHex.toLowerCase(),
    sealedHex,
    resp.issuedAt,
    now(),
  );
  if (!put.ok) {
    const status = put.reason === "already answered" ? 409 : 404;
    return { status, body: { error: put.reason } };
  }
  return { status: 200, body: { ok: true } };
}

/** The mailbox row's username field is informational on the boot worker
 *  (the identity plane resolves the real account for the push). We park
 *  the serverDomain so the row is self-describing without a directory
 *  read on every announce. */
function usernameOrDomain(serverDomain: string): string {
  return serverDomain.toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────
// Shares (docs/share-a-server.md §5.4): another account whose per-share key
// holds a sealed copy of the disk key reads the server's pending start-up
// requests and its own copy, then answers through POST /api/boot/response.
// ──────────────────────────────────────────────────────────────────────

async function handleSharePending(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
): Promise<BootResponse> {
  const now = deps.now ?? (() => Date.now());
  const auth = await gate(deps.gate, { role: "share", serverDomain, method: "GET", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  const user = await deps.directory.usernameForDomain(serverDomain);
  if (!user) return { status: 404, body: { error: "unknown server" } };
  const rows = await deps.secretMailbox.listPendingForUser(user, now(), 50);
  const requests = rows
    .filter((r) => r.serverDomain.toLowerCase() === serverDomain.toLowerCase() && r.purpose === "unlock-key")
    .map((r) => ({
      request: {
        serverDomain: r.serverDomain,
        stkPub: r.stkPubHex,
        purpose: r.purpose,
        nonce: r.requestNonceHex,
        issuedAt: r.requestIssuedAt,
      },
      signature: r.requestSignatureHex,
      postedAt: r.postedAt,
      expiresAt: r.expiresAt,
    }));
  return { status: 200, body: { requests } };
}

async function handleShareKey(
  deps: BootRouteDeps,
  path: string,
  authHeader: string | null,
  serverDomain: string,
): Promise<BootResponse> {
  const auth = await gate(deps.gate, { role: "share", serverDomain, method: "GET", path }, authHeader);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  const copy = await deps.directory.shareUnlockForMember?.(serverDomain, auth.pubKeyHex);
  if (!copy) return { status: 404, body: { error: "no copy for this share" } };
  return { status: 200, body: { sealedKey: copy.sealedKeyHex } };
}
