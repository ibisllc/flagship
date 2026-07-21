import {
  verifyAutoUnlockLease,
  verifyConsumeUnlockKey,
  verifyPutSealedLuksKey,
  verifyRevokeAutoUnlockLease,
  type AutoUnlockLease,
  type ConsumeUnlockKey,
  type PutSealedLuksKey,
  type RevokeAutoUnlockLease,
} from "@flagship/protocol";
import type {
  AutoUnlockLeaseStorage,
  DeviceCapabilityGrantStorage,
  LuksKeyStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/**
 * LUKS unlock-on-boot endpoints (RELAY + box-sealed-lease model).
 *
 * `POST   /api/server/:host/sealed-luks-key`             server identity-signed
 * `GET    /api/server/:host/sealed-luks-key`             public (sealed against BAK)
 * `POST   /api/server/:host/unlock-key/lease`            IRK-signed AutoUnlockLease (one-shot OR multi-use)
 * `DELETE /api/server/:host/unlock-key/lease/:leaseId`   IRK-signed kill switch
 * `POST   /api/server/:host/unlock-key/consume`          server identity-signed (boot stage)
 *
 * The :host parameter must equal the `serverId` field inside the signed
 * request — defense in depth against a bug that mis-routes between hosts.
 *
 * `consume` serves the unlock key from the lease store; when no lease is
 * present it returns 404 and the boot stage falls back to the relay (the
 * STK-signed secret-request mailbox). The legacy plaintext-deposit path,
 * where `.com` held the unsealed key, has been removed.
 */
export interface LuksKeyDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  luksKeys: LuksKeyStorage;
  /**
   * When wired, /unlock-key/lease and /unlock-key/lease/:id become
   * available, and /consume serves from the lease store.
   */
  autoUnlockLeases?: AutoUnlockLeaseStorage;
  /** Slice D — device-grant store for the master-admin authority gate (§2 rows
   *  21 [deposit] + 22 [revoke] of an auto-unlock lease). Optional: absent ⇒
   *  only the bare admin root satisfies the open gate. */
  grants?: DeviceCapabilityGrantStorage;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

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
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    sealedKey = hexToBytes(r.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: PutSealedLuksKey = {
    serverId: host,
    sealedKey,
    issuedAt: r.issuedAt,
  };
  if (!verifyPutSealedLuksKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return forbidden("invalid signature");
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
  if (!rec) return notFound("no sealed key on file");
  return {
    status: 200,
    body: {
      serverDomain: rec.serverDomain,
      sealedKey: rec.sealedKeyHex,
      sealedAt: rec.sealedAt,
    },
  };
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
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  if (nonce.length !== 32) {
    return malformed("nonce must be 32 bytes");
  }
  const claim: ConsumeUnlockKey = {
    serverId: host,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifyConsumeUnlockKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return forbidden("invalid signature");
  }

  // Serve from the lease store — covers both the one-shot reactive
  // lease (default per-boot Approve flow) and the long-lived
  // out-and-about lease (toggle). When no lease is present the boot
  // stage falls back to the relay (the STK-signed secret-request
  // mailbox), so a 404 here is a normal "no lease yet" signal.
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

  return notFound("no unlock-key lease available");
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
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(r.leaseId)) {
    return malformed("leaseId must be 16-128 hex chars");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }
  if (r.expiresAt <= now()) {
    return malformed("expiresAt already past");
  }

  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return notFound("unknown user");

  let unlockKey: Uint8Array;
  let sig: Uint8Array;
  try {
    unlockKey = hexToBytes(r.unlockKey);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: AutoUnlockLease = {
    serverId: host,
    leaseId: r.leaseId,
    expiresAt: r.expiresAt,
    unlockKey,
    multiUse: r.multiUse,
    issuedAt: r.issuedAt,
  };
  // Slice D §2 row 21 — SENSITIVE: master-admin authority (legacy owner-IRK when
  // no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: reg.username.toLowerCase(),
      userRec,
      verifyWith: (pub) => verifyAutoUnlockLease(claim, sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) {
    return forbidden("invalid signature");
  }

  await deps.autoUnlockLeases.put({
    serverDomain: host,
    leaseId: r.leaseId,
    unlockKeyHex: r.unlockKey,
    multiUse: r.multiUse,
    depositedAt: now(),
    expiresAt: r.expiresAt,
  });
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
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  if (r.leaseId !== leaseId) {
    return forbidden("leaseId / url mismatch");
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
  const claim: RevokeAutoUnlockLease = {
    serverId: host,
    leaseId: r.leaseId,
    issuedAt: r.issuedAt,
  };
  // Slice D §2 row 22 — SENSITIVE: master-admin authority (legacy owner-IRK when
  // no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: reg.username.toLowerCase(),
      userRec,
      verifyWith: (pub) => verifyRevokeAutoUnlockLease(claim, sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) {
    return forbidden("invalid signature");
  }

  const removed = await deps.autoUnlockLeases.revoke(host, leaseId);
  return { status: 200, body: { ok: true, removed } };
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
  if (!reg) return notFound("unknown server");
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
