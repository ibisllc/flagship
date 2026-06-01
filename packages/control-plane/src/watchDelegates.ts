/**
 * Watch delegate keys — opt-in "quick-approve a box boot from the Watch".
 *
 * Spec: docs/watch-delegate-key-design.md.
 *
 * The owner's IRK stays fully biometric-gated for every destructive op.
 * A *separate*, IRK-attested Ed25519 key (held in the phone SE under
 * `.userPresence`, mirrored to the watch over WCSession) is authorized for
 * ONE thing — approving a server boot — and nothing else. This module is the
 * cloud half: mint / list / revoke the delegate, plus the authoritative
 * `requireBootApprovalDelegate` check the boot-approval path consumes.
 *
 * Wire contract (served by apps/com against the `flagship-state` D1):
 *   POST /api/users/:u/watch-delegates          → handleMintWatchDelegate
 *   GET  /api/users/:u/watch-delegates          → handleListWatchDelegates
 *   POST /api/users/:u/watch-delegates/revoke   → handleRevokeWatchDelegate
 *
 * `requireBootApprovalDelegate` answers the single question the boot-approval
 * path needs: "is this delegate pubkey currently authorized to approve a boot
 * for username U?" It returns a discriminated `{ ok: true } | { ok: false }`
 * so the caller folds the reason into its own 403 without this module having
 * to know about HTTP. The caller separately verifies the actual approval
 * payload under the returned delegate pubkey — this module only answers
 * authorization, never the approval signature itself.
 *
 * Structure deliberately parallels deviceCapabilityGrants.ts (the v2
 * device-addressing handlers); differences are: ONE active delegate per user
 * (no device label), scopes locked to exactly ["boot-approval"], and the
 * mint path REVOKES any prior active delegate before inserting the new one
 * (the storage layer's unique-active index would otherwise 409).
 */

import {
  verifyWatchDelegateKey,
  verifyRevokeWatchDelegate,
  watchDelegateAuthorizesScope,
  DELEGATE_SCOPES,
  type WatchDelegateKey,
  type RevokeWatchDelegate,
  type DelegateScope,
} from "@flagship/protocol";
import type {
  WatchDelegateRecord,
  WatchDelegateStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes, bytesToHex } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface WatchDelegatesDeps {
  storage: WatchDelegateStorage;
  usernames: UsernameStorage;
  now?: () => number;
}

// ── wire bodies ───────────────────────────────────────────────────────────

interface MintBody {
  grant?: {
    grantId?: unknown;
    username?: unknown;
    delegatePubKey?: unknown; // 32-byte hex
    scopes?: unknown; // string[]
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over the canonical bytes, IRK)
}

interface RevokeBody {
  request?: {
    grantId?: unknown;
    username?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over canonical revoke, IRK)
}

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Parse + validate the wire `scopes`. v1 accepts EXACTLY the delegate scope
 * set (`["boot-approval"]`). We reject anything broader here so a delegate can
 * never be minted with a scope the boot-only design doesn't permit — the
 * protocol's canonical-bytes pass also rejects unknown scopes, but enforcing
 * the closed v1 set at the cloud boundary makes the "boot and nothing else"
 * guarantee explicit rather than emergent.
 */
function parseDelegateScopes(raw: unknown): DelegateScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DelegateScope[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string") return null;
    if (!(DELEGATE_SCOPES as readonly string[]).includes(s)) return null;
    if (seen.has(s)) return null;
    seen.add(s);
    out.push(s as DelegateScope);
  }
  return out;
}

function recordToPublic(r: WatchDelegateRecord) {
  return {
    grantId: r.grantId,
    username: r.username,
    delegatePubKey: r.delegatePubHex,
    scopes: JSON.parse(r.scopesJson) as DelegateScope[],
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/watch-delegates
// ──────────────────────────────────────────────────────────────────────

export async function handleMintWatchDelegate(
  deps: WatchDelegatesDeps,
  body: MintBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const g = body?.grant;
  if (
    !g ||
    typeof g.grantId !== "string" ||
    g.grantId.length === 0 ||
    typeof g.username !== "string" ||
    g.username.length === 0 ||
    typeof g.delegatePubKey !== "string" ||
    !HEX64.test(g.delegatePubKey) ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const scopes = parseDelegateScopes(g.scopes);
  if (!scopes) return malformed("invalid scopes");

  const usernameNorm = g.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  let delegatePub: Uint8Array;
  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    delegatePub = hexToBytes(g.delegatePubKey);
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const grant: WatchDelegateKey = {
    grantId: g.grantId,
    username: usernameNorm,
    delegatePubKey: delegatePub,
    scopes,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
  };

  // The protocol verify rejects malformed envelopes (separator / control char
  // in a field, out-of-range expiry, non-32-byte pubkey) by throwing inside
  // the canonical-bytes pass, which `verifyWatchDelegateKey` folds to `false`.
  // We surface a single 403 either way — the caller never gets to distinguish
  // "bad signature" from "bad envelope".
  if (!verifyWatchDelegateKey(grant, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  if (grant.expiresAt <= now) return malformed("delegate already expired");

  // ONE active delegate per user. Re-minting (renewal, or re-enabling the
  // toggle) must replace the prior — the storage layer's unique-active index
  // would 409 otherwise. Revoke the prior active row first, then insert.
  const prior = await deps.storage.getActiveForUser(usernameNorm);
  if (prior && prior.grantId !== grant.grantId) {
    await deps.storage.revoke(prior.grantId, now);
  }

  const putResult = await deps.storage.put({
    grantId: grant.grantId,
    username: usernameNorm,
    delegatePubHex: bytesToHex(delegatePub).toLowerCase(),
    scopesJson: JSON.stringify(scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(sig),
    revokedAt: null,
  });
  if (!putResult.ok) {
    return conflict(putResult.reason);
  }

  return ok({
    ok: true,
    grantId: grant.grantId,
    username: usernameNorm,
    delegatePubKey: bytesToHex(delegatePub).toLowerCase(),
    scopes,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    ...(prior && prior.grantId !== grant.grantId
      ? { replacedGrantId: prior.grantId }
      : {}),
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/users/:u/watch-delegates
// ──────────────────────────────────────────────────────────────────────

export async function handleListWatchDelegates(
  deps: WatchDelegatesDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const rows = await deps.storage.listForUser(u);
  const active = rows.filter((r) => r.revokedAt === null);

  // Re-verify each active delegate under the user's CURRENT IRK and drop any
  // that no longer verify. This makes the public list authoritative: an IRK
  // rotation (Replace-device / Wipe) changes irkPubHex, so every delegate
  // signed by the prior IRK silently disappears here even if its explicit
  // revoke didn't fire — the same defense-in-depth requireBootApprovalDelegate
  // applies, but centralized so EVERY consumer (the boot worker's directory
  // read, the iPhone toggle's "active delegates" surface) sees only delegates
  // that are genuinely still tied to the live account identity.
  const userRec = await deps.usernames.get(u);
  if (!userRec) return ok({ username: u, delegates: [] });

  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return ok({ username: u, delegates: [] });
  }

  const verified = active.filter((r) => {
    let delegatePub: Uint8Array;
    let sig: Uint8Array;
    let scopes: DelegateScope[];
    try {
      delegatePub = hexToBytes(r.delegatePubHex);
      sig = hexToBytes(r.signatureHex);
      scopes = JSON.parse(r.scopesJson) as DelegateScope[];
    } catch {
      return false;
    }
    const grant: WatchDelegateKey = {
      grantId: r.grantId,
      username: r.username.toLowerCase(),
      delegatePubKey: delegatePub,
      scopes,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
    };
    return verifyWatchDelegateKey(grant, sig, irkPub);
  });

  return ok({ username: u, delegates: verified.map(recordToPublic) });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/watch-delegates/revoke
// ──────────────────────────────────────────────────────────────────────

export async function handleRevokeWatchDelegate(
  deps: WatchDelegatesDeps,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request;
  if (
    !r ||
    typeof r.grantId !== "string" ||
    r.grantId.length === 0 ||
    typeof r.username !== "string" ||
    r.username.length === 0 ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = r.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  const existing = await deps.storage.get(r.grantId);
  if (!existing) return notFound("unknown grantId");
  if (existing.username.toLowerCase() !== usernameNorm) {
    return malformed("username does not match grant");
  }

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const envelope: RevokeWatchDelegate = {
    grantId: r.grantId,
    username: usernameNorm,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevokeWatchDelegate(envelope, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  // Idempotent: revoking an already-revoked delegate returns its tombstone.
  if (existing.revokedAt !== null) {
    return ok({ ok: true, grantId: r.grantId, revokedAt: existing.revokedAt });
  }

  await deps.storage.revoke(r.grantId, now);
  return ok({ ok: true, grantId: r.grantId, revokedAt: now });
}

// ──────────────────────────────────────────────────────────────────────
// requireBootApprovalDelegate — the boot-approval-time authorization check
// ──────────────────────────────────────────────────────────────────────

export type DelegateCheck =
  | { ok: true; grantId: string; username: string; delegatePubHex: string }
  | { ok: false; reason: string };

/**
 * Authoritative "may this watch-delegate pubkey approve a BOOT for username
 * U, right now?" check. Consumed by the boot-approval path when a watch
 * presents a delegate-signed approval.
 *
 * Branches:
 *   1. No active delegate for that pubkey            → deny ("no active delegate").
 *   2. Delegate belongs to a different user          → deny ("user mismatch").
 *   3. Delegate expired (now >= expiresAt)           → deny ("delegate expired").
 *   4. Delegate not scoped for boot-approval         → deny ("scope not authorized").
 *   5. Stored envelope fails to verify under the     → deny ("delegate signature invalid").
 *      user's CURRENT IRK (rotated/replaced/wiped,
 *      or a corrupt/stale row)
 *   6. otherwise                                     → allow.
 *
 * Branch 5 is the auto-revoke teeth: an IRK rotation / Replace-device / Wipe
 * changes `irkPubHex`, so every prior delegate stops verifying here even if a
 * stale `revoked_at IS NULL` row survives — defense-in-depth identical in
 * spirit to `requireDeviceScope`'s re-verification. The caller still verifies
 * the ACTUAL approval payload under the returned `delegatePubHex`; this
 * function answers authorization only.
 *
 * `reason` strings are specific for the caller's own 403 text but are NOT a
 * security oracle — every deny is a single 403 to the network peer.
 */
export async function requireBootApprovalDelegate(
  deps: WatchDelegatesDeps,
  args: { delegatePubHex: string; username: string },
): Promise<DelegateCheck> {
  const now = (deps.now ?? (() => Date.now()))();
  const usernameNorm = args.username.toLowerCase();

  const rec = await deps.storage.getActiveByDelegatePub(
    args.delegatePubHex.toLowerCase(),
  );
  if (!rec) return { ok: false, reason: "no active delegate" };
  if (rec.username.toLowerCase() !== usernameNorm) {
    return { ok: false, reason: "user mismatch" };
  }
  if (now >= rec.expiresAt) return { ok: false, reason: "delegate expired" };

  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return { ok: false, reason: "username not registered" };

  let delegatePub: Uint8Array;
  let irkPub: Uint8Array;
  let sig: Uint8Array;
  let scopes: DelegateScope[];
  try {
    delegatePub = hexToBytes(rec.delegatePubHex);
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(rec.signatureHex);
    scopes = JSON.parse(rec.scopesJson) as DelegateScope[];
  } catch {
    return { ok: false, reason: "corrupt delegate record" };
  }

  const grant: WatchDelegateKey = {
    grantId: rec.grantId,
    username: rec.username.toLowerCase(),
    delegatePubKey: delegatePub,
    scopes,
    issuedAt: rec.issuedAt,
    expiresAt: rec.expiresAt,
  };

  if (!watchDelegateAuthorizesScope(grant, "boot-approval")) {
    return { ok: false, reason: "scope not authorized" };
  }

  // Re-verify the stored envelope under the user's CURRENT IRK. An IRK
  // rotation invalidates every delegate here even if a stale active row
  // survives the rotation's revoke sweep.
  if (!verifyWatchDelegateKey(grant, sig, irkPub)) {
    return { ok: false, reason: "delegate signature invalid" };
  }

  return {
    ok: true,
    grantId: rec.grantId,
    username: usernameNorm,
    delegatePubHex: rec.delegatePubHex.toLowerCase(),
  };
}
