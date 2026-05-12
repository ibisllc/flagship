import {
  verifyAutoUnlockLease,
  verifyConsumeUnlockKey,
  verifyDepositUnlockKey,
  verifyPutSealedLuksKey,
  verifyRevokeAutoUnlockLease,
  type AutoUnlockLease,
  type ConsumeUnlockKey,
  type DepositUnlockKey,
  type PutSealedLuksKey,
  type RevokeAutoUnlockLease,
} from "@flagship/protocol";
import type {
  AutoUnlockLeaseStorage,
  LuksKeyStorage,
  PendingUnlockApprovalStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

/**
 * LUKS unlock-on-boot endpoints.
 *
 * `POST   /api/server/:host/sealed-luks-key`             server identity-signed
 * `GET    /api/server/:host/sealed-luks-key`             public (sealed against BAK)
 * `POST   /api/server/:host/unlock-key`                  IRK-signed (legacy deposit; one-shot)
 * `POST   /api/server/:host/unlock-key/lease`            IRK-signed AutoUnlockLease (one-shot OR multi-use)
 * `DELETE /api/server/:host/unlock-key/lease/:leaseId`   IRK-signed kill switch
 * `POST   /api/server/:host/unlock-key/consume`          server identity-signed (boot stage)
 *
 * The :host parameter must equal the `serverId` field inside the signed
 * request — defense in depth against a bug that mis-routes between hosts.
 *
 * `consume` checks the lease store first (new code path) before falling
 * back to the legacy unlock-key deposit row, so old clients keep working
 * during rollout without any boot-stage change.
 */
export interface LuksKeyDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  luksKeys: LuksKeyStorage;
  /**
   * Optional: when wired, /unlock-key/lease and /unlock-key/lease/:id
   * become available, and /consume checks the lease store first. When
   * absent, only the legacy deposit path is in play.
   */
  autoUnlockLeases?: AutoUnlockLeaseStorage;
  /**
   * When wired alongside `pushUserDevices`, /consume returning 404
   * records a pending row + fans a push to the user's devices (rate-
   * limited per pushDedupMs). The lease deposit handler clears the
   * pending row on success. When absent, /consume just returns 404.
   */
  pendingUnlockApprovals?: PendingUnlockApprovalStorage;
  /**
   * Push fan-out for unlock-request notifications. Built by the
   * apex Worker from `forwardToProviders` + `pushTokens.listByUser`.
   * Returns silently on no-tokens / no-config — the consume path
   * doesn't care if the push actually went out. `payload` is the
   * plaintext to encrypt via RFC 8291 for Web Push (APNs/FCM use
   * the existing sealed-payload pattern unrelated to this).
   */
  pushUserDevices?: (
    username: string,
    category: string,
    payload?: Uint8Array,
  ) => Promise<void>;
  maxAgeMs?: number;
  /** Skip pushing if a push for this server fired within this window. Default 60s. */
  pushDedupMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_PUSH_DEDUP_MS = 60_000;

function randomRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function handlePutSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.sealedKey !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    sealedKey = hexToBytes(r.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: PutSealedLuksKey = {
    serverId: host,
    sealedKey,
    issuedAt: r.issuedAt,
  };
  if (!verifyPutSealedLuksKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.luksKeys.putSealed({
    serverDomain: host,
    sealedKeyHex: r.sealedKey,
    sealedAt: now(),
  });
  return { status: 200, body: { ok: true } };
}

/**
 * #48 — public-read decision (M4).
 *
 * This endpoint is intentionally UNAUTHENTICATED. The audit raised
 * the concern that returning the sealed LUKS key ciphertext to any
 * caller enables an attacker to enumerate which serverDomains have
 * a deposit on file. After deliberation in the Thread-G design pass:
 *
 * DECISION: accept the metadata leak. Reasoning:
 *   - The CONTENT is sealed against BAK, which lives only on the
 *     user's phone (or webapp peer device). Without BAK, the
 *     ciphertext is unusable — no offline attack works against
 *     well-chosen BAK material.
 *   - The bootstrap flow needs to fetch this WITHOUT authentication,
 *     because at boot the daemon has only the disk's pubkey material,
 *     not an IRK-bound session.
 *   - Per-IP rate limit (apps/com /rateLimit binding, #9) bounds the
 *     enumeration cost.
 *
 * PATH TO CLOSURE if we ever decide to gate further:
 *   - Require an IRK-signed fetch envelope, which would mean the boot
 *     stage needs to carry the IRK pubkey + a fresh signature from
 *     the phone via the LUKS unlock approval flow.
 *   - That couples boot-time unlock with phone reachability more
 *     tightly than the current design wants.
 *   - DO NOT add the gate without revisiting the boot-stage protocol.
 *
 * In short: this endpoint is public-by-design and reviewed.
 */
export async function handleGetSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
): Promise<HandlerResponse> {
  const rec = await deps.luksKeys.getSealed(host);
  if (!rec) return { status: 404, body: { error: "no sealed key on file" } };
  return {
    status: 200,
    body: {
      serverDomain: rec.serverDomain,
      sealedKey: rec.sealedKeyHex,
      sealedAt: rec.sealedAt,
    },
  };
}

export async function handleDepositUnlockKey(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.unlockKey !== "string" ||
    typeof r.expiresAt !== "number" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  if (r.expiresAt <= now()) {
    return { status: 400, body: { error: "expiresAt already past" } };
  }

  // Look up the user's IRK pubkey via the server's username.
  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { status: 404, body: { error: "unknown user" } };

  let unlockKey: Uint8Array;
  let sig: Uint8Array;
  try {
    unlockKey = hexToBytes(r.unlockKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: DepositUnlockKey = {
    serverId: host,
    unlockKey,
    expiresAt: r.expiresAt,
    issuedAt: r.issuedAt,
  };
  if (!verifyDepositUnlockKey(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.luksKeys.putUnlock({
    serverDomain: host,
    unlockKeyHex: r.unlockKey,
    depositedAt: now(),
    expiresAt: r.expiresAt,
  });
  return { status: 200, body: { ok: true } };
}

export async function handleConsumeUnlockKey(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.nonce !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  if (nonce.length !== 32) {
    return { status: 400, body: { error: "nonce must be 32 bytes" } };
  }
  const claim: ConsumeUnlockKey = {
    serverId: host,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifyConsumeUnlockKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Lease store first (new path) — covers both the one-shot reactive
  // lease (default per-boot Approve flow) and the long-lived
  // out-and-about lease (toggle).
  if (deps.autoUnlockLeases) {
    const lease = await deps.autoUnlockLeases.consume(host, now());
    if (lease) {
      return {
        status: 200,
        body: {
          unlockKey: lease.unlockKeyHex,
          depositedAt: lease.depositedAt,
          expiresAt: lease.expiresAt,
          leaseId: lease.leaseId,
          multiUse: lease.multiUse,
        },
      };
    }
  }

  // Legacy deposit fallback. Anything written via the old
  // /api/server/:host/unlock-key endpoint still works.
  const dep = await deps.luksKeys.consumeUnlock(host, now());
  if (!dep) {
    // No lease, no legacy deposit — record this server as a pending
    // unlock approval and fan a push to the owner's devices (rate-
    // limited). The pending row is the canonical "this server is
    // asking to boot" entity that the webapp's unlock-approvals
    // view shows + the lease deposit handler clears on success.
    if (deps.pendingUnlockApprovals) {
      const dedupMs = deps.pushDedupMs ?? DEFAULT_PUSH_DEDUP_MS;
      const result = await deps.pendingUnlockApprovals.upsertWithDedup(
        host,
        randomRequestId(),
        now(),
        dedupMs,
      );
      if (result.shouldPush && deps.pushUserDevices) {
        // Fire-and-forget push so the boot poll's response time
        // isn't held back by APNs/FCM/Web Push round-trips. Errors
        // are silently swallowed by the pushUserDevices wrapper.
        await deps.pendingUnlockApprovals.touchLastPushAt(host, now());
        // RFC 8291 plaintext for the SW to personalise the notification
        // ("test.alice.flagship.services is asking to boot"). APNs/FCM
        // ignore this; they get the sealed-payload-by-pushX25519Pub
        // story instead.
        const payload = new TextEncoder().encode(
          JSON.stringify({ kind: "unlock-request", serverFqdn: host, requestId: result.requestId }),
        );
        void deps.pushUserDevices(reg.username, "unlock-request", payload).catch(() => {});
      }
    }
    return { status: 404, body: { error: "no pending unlock-key deposit" } };
  }
  return {
    status: 200,
    body: {
      unlockKey: dep.unlockKeyHex,
      depositedAt: dep.depositedAt,
      expiresAt: dep.expiresAt,
    },
  };
}

/**
 * Deposit an IRK-signed AutoUnlockLease. The same shape covers both
 * the one-shot reactive case (multiUse=false, short expiry) and the
 * opt-in long-lived case (multiUse=true, longer expiry). Either way,
 * `.com` stores the row and serves it on the next /consume.
 *
 * Validation matches the existing handlers: serverId/host must match,
 * server must exist + not be revoked, issuedAt must be within
 * maxAgeMs of now, expiresAt must still be in the future.
 */
export async function handleDepositAutoUnlockLease(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.autoUnlockLeases) {
    return { status: 501, body: { error: "auto-unlock leases not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.leaseId !== "string" ||
    typeof r.unlockKey !== "string" ||
    typeof r.multiUse !== "boolean" ||
    typeof r.expiresAt !== "number" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(r.leaseId)) {
    return { status: 400, body: { error: "leaseId must be 16-128 hex chars" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  if (r.expiresAt <= now()) {
    return { status: 400, body: { error: "expiresAt already past" } };
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { status: 404, body: { error: "unknown user" } };

  let unlockKey: Uint8Array;
  let sig: Uint8Array;
  try {
    unlockKey = hexToBytes(r.unlockKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: AutoUnlockLease = {
    serverId: host,
    leaseId: r.leaseId,
    expiresAt: r.expiresAt,
    unlockKey,
    multiUse: r.multiUse,
    issuedAt: r.issuedAt,
  };
  if (!verifyAutoUnlockLease(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.autoUnlockLeases.put({
    serverDomain: host,
    leaseId: r.leaseId,
    unlockKeyHex: r.unlockKey,
    multiUse: r.multiUse,
    depositedAt: now(),
    expiresAt: r.expiresAt,
  });
  // Clear the pending row — the user has acted, no more pushes needed
  // for this boot wait.
  if (deps.pendingUnlockApprovals) {
    await deps.pendingUnlockApprovals.delete(host).catch(() => {});
  }
  return { status: 200, body: { ok: true, leaseId: r.leaseId } };
}

/**
 * Revoke a previously-deposited lease — kill switch for the user.
 * Signature is by IRK; URL carries `:host` and `:leaseId`. The leaseId
 * lookup is scoped to (host, leaseId), so a leaked sig from one
 * server's revoke can't kill another server's lease.
 */
export async function handleRevokeAutoUnlockLease(
  deps: LuksKeyDeps,
  host: string,
  leaseId: string,
  body: unknown,
): Promise<HandlerResponse> {
  if (!deps.autoUnlockLeases) {
    return { status: 501, body: { error: "auto-unlock leases not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.leaseId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  if (r.leaseId !== leaseId) {
    return { status: 403, body: { error: "leaseId / url mismatch" } };
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
  const claim: RevokeAutoUnlockLease = {
    serverId: host,
    leaseId: r.leaseId,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevokeAutoUnlockLease(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const removed = await deps.autoUnlockLeases.revoke(host, leaseId);
  return { status: 200, body: { ok: true, removed } };
}

/**
 * Read the pending unlock-approval row for a server (proxied by the
 * daemon's /api/screens/unlock-approvals/pending). Public read —
 * the row only contains opaque metadata (requestId + requestedAt),
 * never the unlock key itself, so disclosure is safe. Returns
 * `{ pending: [] }` shape so the daemon-side response parser doesn't
 * need conditional branching.
 */
export async function handleGetPendingUnlockApproval(
  deps: LuksKeyDeps,
  serverFqdn: string,
): Promise<HandlerResponse> {
  if (!deps.pendingUnlockApprovals) {
    return { status: 200, body: { pending: [] } };
  }
  const row = await deps.pendingUnlockApprovals.get(serverFqdn);
  if (!row) return { status: 200, body: { pending: [] } };
  return {
    status: 200,
    body: {
      pending: [
        {
          requestId: row.requestId,
          serverFqdn: row.serverDomain,
          requestedAt: row.requestedAt,
        },
      ],
    },
  };
}

/**
 * List active leases for a server. Read-only, but only meaningful to
 * the user — we still gate by serverId existence so probing returns
 * the same shape across hosts.
 *
 * NOTE: this endpoint does NOT require a signature today (it returns
 * lease metadata only — leaseId, multiUse, expiresAt — never the
 * unlockKeyHex). If we later want to gate it, a paired-session check
 * at the apex Worker is the right hook.
 */
/**
 * #48 — public-read decision (M8).
 *
 * Same posture as handleGetSealedLuksKey above. The sealed LUKS
 * unlock-lease records are public-readable because:
 *   - The lease content is sealed against BAK; without phone keys
 *     it's useless ciphertext.
 *   - The bootstrap flow's auto-unlock path needs to discover whether
 *     a lease exists for this host before it has any session state.
 *   - Per-IP rate limit caps enumeration.
 *
 * The metadata leak: an attacker can learn that a given serverDomain
 * has at least one active lease. Compared to the prior alternative
 * (forcing an IRK-signed read at boot time), this leak is materially
 * less harmful than the operational complexity it would cost.
 *
 * Documented decision; do NOT add a gate without revisiting the
 * boot-stage protocol holistically.
 */
export async function handleListAutoUnlockLeases(
  deps: LuksKeyDeps,
  host: string,
): Promise<HandlerResponse> {
  if (!deps.autoUnlockLeases) {
    return { status: 501, body: { error: "auto-unlock leases not configured" } };
  }
  const now = deps.now ?? (() => Date.now());
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  const rows = await deps.autoUnlockLeases.list(host, now());
  return {
    status: 200,
    body: {
      leases: rows.map((row) => ({
        leaseId: row.leaseId,
        multiUse: row.multiUse,
        depositedAt: row.depositedAt,
        expiresAt: row.expiresAt,
      })),
    },
  };
}
