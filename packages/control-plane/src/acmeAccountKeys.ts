/**
 * ACME account-key grants — distribute the (sealed) per-user-cert minting
 * authority to the account's admin-scope devices (per-user-cert design §4.2).
 *
 * The ACME ACCOUNT key is the authority to mint the user's `[<user>, *.<user>]`
 * TLS cert. It is held ONLY by admin devices (and, opt-in, an "autonomous"
 * box), sealed to each recipient — NEVER UMK-derived (that would hand it to
 * every device, breaking the admin boundary) and NEVER given to `.com`. This
 * module is the cloud half: mint / list / revoke the IRK-signed grants, plus
 * the authoritative `requireMinter` check the mint-coordination path consumes.
 *
 * Wire contract (served by apps/com against the `flagship-state` D1):
 *   POST /api/users/:u/acme-account-keys          → handleMintAcmeAccountKeyGrant
 *   GET  /api/users/:u/acme-account-keys          → handleListAcmeAccountKeyGrants
 *   POST /api/users/:u/acme-account-keys/revoke   → handleRevokeAcmeAccountKeyGrant
 *
 * THE SEALED KEY IS NEVER A RESPONSE FIELD. The mint reply echoes only the
 * public references (accountKeyId / recipientPubKey / expiresAt); the list is
 * metadata-only. Delivery of the sealed key is the mint REQUEST's job (the
 * device that minted the grant already holds the plaintext to seal); `.com`
 * stores the ciphertext for audit + recovery escrow, but a read endpoint is
 * NOT a delivery channel — a compromised read must not leak a sealed key.
 *
 * Structure deliberately parallels watchDelegates.ts / deviceCapabilityGrants.ts;
 * the differences are: MULTIPLE active grants per user (one sealed copy per
 * admin device, so NO unique-active index — `put` only rejects a duplicate
 * grantId), and revocation is by `accountKeyId` (rotation tombstones every
 * copy of a retired key at once) rather than by a single grantId.
 */

import {
  verifyAcmeAccountKeyGrant,
  verifyRevokeAcmeAccountKey,
  type AcmeAccountKeyGrant,
  type AccountKeyRevokeReason,
  type RevokeAcmeAccountKey,
} from "@flagship/protocol";
import type {
  AcmeAccountKeyDeliveryStorage,
  AcmeAccountKeyGrantRecord,
  AcmeAccountKeyGrantStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes, bytesToHex } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface AcmeAccountKeysDeps {
  storage: AcmeAccountKeyGrantStorage;
  usernames: UsernameStorage;
  /**
   * The #28 seal-to-box DELIVERY store (optional). When present, a grant
   * revoke (key rotation on admin demotion / compromise) ALSO drops the box's
   * released-key slot for that accountKeyId — so a stolen box can't re-release
   * the now-dead key on its next boot. Absent ⇒ delivery sweep is a no-op
   * (mint/list/requireMinter paths don't need it).
   */
  delivery?: AcmeAccountKeyDeliveryStorage;
  now?: () => number;
}

// ── wire bodies ───────────────────────────────────────────────────────────

interface MintBody {
  grant?: {
    grantId?: unknown;
    username?: unknown;
    accountKeyId?: unknown;
    recipientPubKey?: unknown; // 32-byte hex
    sealedAccountKey?: unknown; // opaque ciphertext, hex
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over the canonical bytes, IRK)
}

interface RevokeBody {
  request?: {
    accountKeyId?: unknown;
    username?: unknown;
    reason?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over canonical revoke, IRK)
}

const VALID_REVOKE_REASONS: ReadonlySet<AccountKeyRevokeReason> =
  new Set<AccountKeyRevokeReason>(["demotion", "compromise", "rotation"]);

/** Non-empty, even-length lowercase hex (the sealed-key bound is re-checked by
 *  the protocol's canonical-bytes pass; here we only reject obvious garbage). */
const HEX_EVEN_NONEMPTY = /^(?:[0-9a-f]{2})+$/;

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/acme-account-keys
// ──────────────────────────────────────────────────────────────────────

export async function handleMintAcmeAccountKeyGrant(
  deps: AcmeAccountKeysDeps,
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
    typeof g.accountKeyId !== "string" ||
    g.accountKeyId.length === 0 ||
    typeof g.recipientPubKey !== "string" ||
    !HEX64.test(g.recipientPubKey) ||
    typeof g.sealedAccountKey !== "string" ||
    !HEX_EVEN_NONEMPTY.test(g.sealedAccountKey) ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = g.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  let recipientPub: Uint8Array;
  let sealedAccountKey: Uint8Array;
  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    recipientPub = hexToBytes(g.recipientPubKey);
    sealedAccountKey = hexToBytes(g.sealedAccountKey);
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const grant: AcmeAccountKeyGrant = {
    grantId: g.grantId,
    username: usernameNorm,
    accountKeyId: g.accountKeyId,
    recipientPubKey: recipientPub,
    sealedAccountKey,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
  };

  // The protocol verify rejects malformed envelopes (separator / control char
  // in a field, out-of-range expiry, non-32-byte pubkey, over-long sealed key)
  // by throwing inside the canonical-bytes pass, which `verifyAcmeAccountKeyGrant`
  // folds to `false`. We surface a single 403 either way — the caller never
  // gets to distinguish "bad signature" from "bad envelope".
  if (!verifyAcmeAccountKeyGrant(grant, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  if (grant.expiresAt <= now) return malformed("grant already expired");

  const putResult = await deps.storage.put({
    grantId: grant.grantId,
    username: usernameNorm,
    accountKeyId: grant.accountKeyId,
    recipientPubHex: bytesToHex(recipientPub).toLowerCase(),
    sealedAccountKeyHex: bytesToHex(sealedAccountKey).toLowerCase(),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(sig),
    revokedAt: null,
  });
  if (!putResult.ok) {
    return conflict(putResult.reason);
  }

  // Public fields ONLY — the sealed key is deliberately absent from the reply.
  return ok({
    ok: true,
    grantId: grant.grantId,
    username: usernameNorm,
    accountKeyId: grant.accountKeyId,
    recipientPubKey: bytesToHex(recipientPub).toLowerCase(),
    expiresAt: grant.expiresAt,
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/users/:u/acme-account-keys
// ──────────────────────────────────────────────────────────────────────

export async function handleListAcmeAccountKeyGrants(
  deps: AcmeAccountKeysDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const active = await deps.storage.getActiveForUser(u);
  // Metadata ONLY — listing is NOT a delivery channel for the sealed key.
  return ok({
    username: u,
    grants: active.map((r: AcmeAccountKeyGrantRecord) => ({
      grantId: r.grantId,
      accountKeyId: r.accountKeyId,
      recipientPubKey: r.recipientPubHex,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
    })),
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/acme-account-keys/revoke
// ──────────────────────────────────────────────────────────────────────

export async function handleRevokeAcmeAccountKeyGrant(
  deps: AcmeAccountKeysDeps,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request;
  if (
    !r ||
    typeof r.accountKeyId !== "string" ||
    r.accountKeyId.length === 0 ||
    typeof r.username !== "string" ||
    r.username.length === 0 ||
    typeof r.reason !== "string" ||
    !VALID_REVOKE_REASONS.has(r.reason as AccountKeyRevokeReason) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = r.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const envelope: RevokeAcmeAccountKey = {
    accountKeyId: r.accountKeyId,
    username: usernameNorm,
    reason: r.reason as AccountKeyRevokeReason,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevokeAcmeAccountKey(envelope, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  // Tombstone every still-active grant of this accountKeyId in one shot
  // (rotation on admin demotion / compromise kills all sealed copies at once).
  // Idempotent: a re-revoke just returns 0.
  const revoked = await deps.storage.revokeByAccountKeyId(r.accountKeyId, now);

  // #28 — ALSO drop any seal-to-box DELIVERY slot of this key. The grant
  // tombstone above kills the admin-device copies, but an autonomous box pulls
  // its sealed key from the delivery slot at boot; without this, a stolen box
  // could re-release the now-dead key on its next reboot. deleteByAccountKeyId
  // is idempotent (returns 0 when no slot matches).
  let deliveryDropped = 0;
  if (deps.delivery) {
    deliveryDropped = await deps.delivery.deleteByAccountKeyId(r.accountKeyId);
  }
  return ok({ ok: true, accountKeyId: r.accountKeyId, revoked, deliveryDropped });
}

// ──────────────────────────────────────────────────────────────────────
// requireMinter — the mint-time authorization check
// ──────────────────────────────────────────────────────────────────────

/**
 * Authoritative "may this signer mint/renew the per-user cert for username
 * U, right now?" check. Consumed by the mint-coordination path (the
 * reservation lease) before a holder is allowed to lead a mint cycle.
 *
 * Two branches:
 *   1. signerPubHex == the user's IRK pub → allow (the account root is always
 *      a minter; legacy single-IRK accounts sign directly).
 *   2. signerPubHex holds an ACTIVE, unexpired AcmeAccountKeyGrant for U whose
 *      stored envelope RE-VERIFIES under the user's CURRENT IRK → allow.
 *   otherwise → deny.
 *
 * Branch 2's re-verification is defense-in-depth, identical in spirit to
 * `requireDeviceScope` / `requireBootApprovalDelegate`: a grant row was
 * verified at mint time, but an IRK rotation (Replace-device / Wipe) changes
 * `irkPubHex`, so every grant signed by the prior IRK stops verifying here
 * even if its explicit revoke didn't fire — the removed admin's sealed copy
 * is dead. We walk the recipient's active grants (a device may hold several
 * across rotations of the account key) and allow if ANY still verifies.
 *
 * `reason` strings are specific for the caller's own 403 text but are NOT a
 * security oracle — every deny is a single 403 to the network peer.
 */
export async function requireMinter(
  deps: AcmeAccountKeysDeps,
  args: { username: string; signerPubHex: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = (deps.now ?? (() => Date.now()))();
  const usernameNorm = args.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return { ok: false, reason: "username not registered" };

  // The account root (user IRK) is always a minter.
  if (equalHex(args.signerPubHex, userRec.irkPubHex)) {
    return { ok: true };
  }

  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { ok: false, reason: "user irk corrupt" };
  }

  const grants = await deps.storage.getActiveByRecipient(
    args.signerPubHex.toLowerCase(),
  );
  for (const rec of grants) {
    if (rec.username.toLowerCase() !== usernameNorm) continue;
    if (now >= rec.expiresAt) continue;

    let recipientPub: Uint8Array;
    let sealedAccountKey: Uint8Array;
    let sig: Uint8Array;
    try {
      recipientPub = hexToBytes(rec.recipientPubHex);
      sealedAccountKey = hexToBytes(rec.sealedAccountKeyHex);
      sig = hexToBytes(rec.signatureHex);
    } catch {
      continue;
    }

    const grant: AcmeAccountKeyGrant = {
      grantId: rec.grantId,
      username: rec.username.toLowerCase(),
      accountKeyId: rec.accountKeyId,
      recipientPubKey: recipientPub,
      sealedAccountKey,
      issuedAt: rec.issuedAt,
      expiresAt: rec.expiresAt,
    };
    // Re-verify under the user's CURRENT IRK. An IRK rotation invalidates
    // every grant here even if a stale active row survives the revoke sweep.
    if (verifyAcmeAccountKeyGrant(grant, sig, irkPub)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "not an account minter" };
}
