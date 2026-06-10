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
 */

import {
  verifyAutoUnlockLeaseV2,
  verifySecretRequest,
  type AutoUnlockLeaseV2,
  type SecretPurpose,
  type SecretRequest,
} from "@flagship/protocol";
import type {
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

// 40 min — must comfortably exceed the box's relay poll window (default
// 1800s = 30 min in the burner/boot-stage) so a parked unlock request stays
// visible + approvable on the phone for the whole time the box is waiting.
// (The box re-posts on every boot, so this is just the single-boot lifetime.)
const DEFAULT_MAILBOX_TTL_MS = 40 * 60_000;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_PUSH_DEDUP_MS = 60_000;

const PURPOSES: ReadonlySet<SecretMailboxPurpose> = new Set<SecretMailboxPurpose>([
  "unlock-key",
  "entitlement",
]);

export interface BootRouteDeps {
  boxSealedLeases: BoxSealedLeaseStorage;
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
  REQUEST_POST: /^\/api\/boot\/request$/,
  RESPONSE_GET: /^\/api\/boot\/response\/([^/]+)\/([^/]+)$/,
  RESPONSE_POST: /^\/api\/boot\/response$/,
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
  const pushDedupMs = deps.pushDedupMs ?? DEFAULT_PUSH_DEDUP_MS;

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

  // Derive the owning username from the directory (so the phone-side
  // mailbox listing is scoped to the account). usernameFromServerDomain
  // already ran inside the directory binding; we re-resolve here cheaply
  // via the directory abstraction's username helper through ownerIrk —
  // but the row only needs the username for the phone listing, which the
  // identity-plane notify pipe drives. We store the SecretRequest verbatim.
  const nonceHex = r.nonce.toLowerCase();
  const put = await deps.secretMailbox.putRequest({
    serverDomain: r.serverDomain,
    // The mailbox row's username is informational here (the notify pipe
    // resolves the real account on the identity plane). We park the
    // serverDomain as the routing key; the box re-derives the nonce.
    username: usernameOrDomain(r.serverDomain),
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

  // Idempotency + per-nonce dedup. A duplicate nonce is NOT an error —
  // the box re-announcing/polling collapses to the existing pending row.
  // We only fire the notify pipe when no push has fired for this row
  // within the dedup window, so repeated announces send ONE push.
  if (!put.ok) {
    if (put.reason !== "duplicate nonce") {
      return { status: 409, body: { error: put.reason } };
    }
    const existing = await deps.secretMailbox.getRequest(r.serverDomain, nonceHex);
    if (existing && existing.expiresAt > now() && now() - existing.lastPushAt < pushDedupMs) {
      // A recent push already fired — collapse (no second push).
      return { status: 200, body: { ok: true, requestNonceHex: nonceHex, deduped: true } };
    }
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
    { role: ["owner", "delegate"], serverDomain: resp.serverDomain, method: "POST", path },
    authHeader,
  );
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

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
