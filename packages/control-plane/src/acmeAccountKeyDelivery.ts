/**
 * Seal-to-box delivery of the shared ACME account key (#28 Option B;
 * per-user-cert design §4). The cloud half of deposit-and-release.
 *
 * An autonomous box that mints/renews its per-box TLS cert
 * (`[<server>.<user>, *.<server>.<user>]`, cert model A′) against the shared
 * ACME account needs the ACME ACCOUNT key. Unlike an admin device (which receives its sealed
 * copy via `acmeAccountKeys.ts` and unseals interactively), the box has no
 * session at boot — so the key is delivered by DEPOSIT-AND-RELEASE, mirroring
 * the box-sealed LUKS lease (secretMailbox.ts §5):
 *
 *   POST   /api/server/:domain/acme-account-key   admin DEPOSITS the grant
 *          (IRK-signed; key sealed to the box STK; the directory-bound box STK
 *           is re-checked so .com is only ever asked to carry a seal for THIS
 *           box — I2)
 *   GET    /api/server/:domain/acme-account-key   box RELEASES on boot
 *          (PUBLIC read — the box has no session; the blob is sealed to the box
 *           STK, so a captured GET is harmless, same posture as the LUKS lease
 *           release. The box unseals with its STK private key — I1)
 *   DELETE /api/server/:domain/acme-account-key   IRK-signed delivery-revoke
 *          (drops the slot so a subsequent boot can't release it)
 *
 * Invariants (encoded structurally + tested) — identical to the box-sealed
 * lease's I1/I2/I3:
 *   I1 — .com stores/serves only the SEALED key. No path returns plaintext;
 *        the deposit reply NEVER echoes the sealed key either.
 *   I2 — the seal recipient is PINNED to the directory-bound box STK + covered
 *        by the IRK signature on the grant. .com cannot retarget the seal.
 *   I3 — .com is gate/router only: it can withhold (DoS) but never read/forge.
 *
 * REUSES the AcmeAccountKeyGrant + RevokeAcmeAccountKey envelopes (no new
 * protocol type). The deposit ALSO records the grant via the existing
 * acmeAccountKeyGrants store so the box's sealed copy participates in audit +
 * the authoritative requireMinter check (the box is an admin-equivalent
 * minter), and so a rotation's RevokeAcmeAccountKeyGrant sweep already covers
 * it. The rotation hook (acmeAccountKeys.ts) additionally drops the delivery
 * slot so a stolen box can't re-release a dead key.
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
  AcmeAccountKeyGrantStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, bytesToHex, equalHex, hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

export interface AcmeAccountKeyDeliveryDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  delivery: AcmeAccountKeyDeliveryStorage;
  /** The per-admin-device grant store — the deposit ALSO records the grant
   *  here for audit + the requireMinter authorization the mint path consumes. */
  acmeAccountKeyGrants: AcmeAccountKeyGrantStorage;
  now?: () => number;
}

/** Non-empty, even-length lowercase hex (the sealed-key bound is re-checked by
 *  the protocol canonical-bytes pass; here we only reject obvious garbage). */
const HEX_EVEN_NONEMPTY = /^(?:[0-9a-f]{2})+$/;

const VALID_REVOKE_REASONS: ReadonlySet<AccountKeyRevokeReason> =
  new Set<AccountKeyRevokeReason>(["demotion", "compromise", "rotation"]);

// ──────────────────────────────────────────────────────────────────────
// POST /api/server/:domain/acme-account-key  — admin DEPOSITS the sealed key
//
// Body: { grant: AcmeAccountKeyGrant (wire form), signature(hex) }.
// Verify: the IRK sig over the grant (irkPub fetched from `usernames` by
// grant.username); recipientPubKey MUST equal the directory `servers`
// identityPubKeyHex for serverDomain (I2 — the seal is for THIS box);
// expiresAt > issuedAt. On success: record the grant (audit + requireMinter)
// AND the delivery slot. Reply carries ONLY public references (I1).
// ──────────────────────────────────────────────────────────────────────

interface DepositBody {
  grant?: {
    grantId?: unknown;
    username?: unknown;
    accountKeyId?: unknown;
    recipientPubKey?: unknown; // 32-byte hex
    sealedAccountKey?: unknown; // opaque ciphertext, hex
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over canonical grant, IRK)
}

export async function handleDepositAcmeAccountKey(
  deps: AcmeAccountKeyDeliveryDeps,
  serverDomain: string,
  body: DepositBody | undefined,
): Promise<HandlerResponse> {
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
    !HEX64.test(g.recipientPubKey.toLowerCase()) ||
    typeof g.sealedAccountKey !== "string" ||
    !HEX_EVEN_NONEMPTY.test(g.sealedAccountKey.toLowerCase()) ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature.toLowerCase())
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }

  // The box this delivery is for must be a registered, non-revoked server.
  const reg = await deps.servers.get(serverDomain);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };

  // I2 — the sealed key's recipient MUST be the directory-bound box STK for
  // THIS server. A grant sealed to some OTHER key is rejected here, so .com is
  // only ever asked to carry a seal the registered box can actually open. This
  // is the analogue of the box-sealed-lease "stkPub matches the registered
  // server" check.
  if (!equalHex(g.recipientPubKey, reg.identityPubKeyHex)) {
    return {
      status: 403,
      body: { error: "recipientPubKey does not match the registered server" },
    };
  }

  // The grant MUST name the account that owns this server, and it MUST be
  // signed by THAT account's IRK (the trust anchor). Fetching the IRK off the
  // server's own username — not a body-supplied one — mirrors the box-sealed
  // lease deposit and closes any cross-account deposit ambiguity.
  const usernameNorm = g.username.toLowerCase();
  if (usernameNorm !== reg.username.toLowerCase()) {
    return { status: 403, body: { error: "username does not own this server" } };
  }
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return { status: 404, body: { error: "username not registered" } };

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
    return { status: 400, body: { error: "invalid hex" } };
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

  // The protocol verify folds a malformed envelope (separator/control char,
  // out-of-range expiry, non-32-byte pubkey, over-long sealed key) to `false`.
  // A single 403 either way — the caller can't distinguish "bad signature"
  // from "bad envelope".
  if (!verifyAcmeAccountKeyGrant(grant, sig, irkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }
  if (grant.expiresAt <= now) {
    return { status: 400, body: { error: "grant already expired" } };
  }

  const recipientHex = bytesToHex(recipientPub).toLowerCase();
  const sealedHex = bytesToHex(sealedAccountKey).toLowerCase();

  // Record the grant for audit + requireMinter (the box's sealed copy is an
  // admin-equivalent minter). A duplicate grantId is benign here — the grant
  // store already holds it; we proceed to (re-)deposit the delivery slot so a
  // retried deposit is idempotent rather than 409-ing on the grant.
  await deps.acmeAccountKeyGrants.put({
    grantId: grant.grantId,
    username: usernameNorm,
    accountKeyId: grant.accountKeyId,
    recipientPubHex: recipientHex,
    sealedAccountKeyHex: sealedHex,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(sig).toLowerCase(),
    revokedAt: null,
  });

  // The delivery slot (one per box; a re-deposit supersedes the prior seal).
  await deps.delivery.put({
    serverDomain,
    accountKeyId: grant.accountKeyId,
    sealedAccountKeyHex: sealedHex,
    recipientPubHex: recipientHex,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    revokedAt: null,
  });

  // Public references ONLY — the sealed key is deliberately absent (I1).
  return { status: 200, body: { ok: true, accountKeyId: grant.accountKeyId } };
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/server/:domain/acme-account-key  — box RELEASES on boot
//
// PUBLIC read (the box has no session at boot). Returns the SEALED key + its
// public references when a non-revoked, non-expired slot exists; else 404. The
// blob is sealed to the box STK, so a captured GET cannot open it (I1) — the
// same posture as the box-sealed-lease release.
// ──────────────────────────────────────────────────────────────────────

export async function handleReleaseAcmeAccountKey(
  deps: AcmeAccountKeyDeliveryDeps,
  serverDomain: string,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const row = await deps.delivery.getByDomain(serverDomain);
  if (!row || row.revokedAt !== null || row.expiresAt <= now) {
    return { status: 404, body: { error: "no acme account key ready" } };
  }
  return {
    status: 200,
    body: {
      // SEALED — never plaintext (I1). The box unseals with its STK key.
      sealedAccountKeyHex: row.sealedAccountKeyHex,
      accountKeyId: row.accountKeyId,
      recipientPubKeyHex: row.recipientPubHex,
      expiresAt: row.expiresAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/server/:domain/acme-account-key  — IRK-signed delivery-revoke
//
// Body: { request: RevokeAcmeAccountKey (accountKeyId, username, reason,
// issuedAt), signature(hex) }. IRK-verify under the account's registered IRK,
// then drop the slot so a subsequent boot can't release it. Idempotent.
// ──────────────────────────────────────────────────────────────────────

interface RevokeBody {
  request?: {
    accountKeyId?: unknown;
    username?: unknown;
    reason?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over canonical revoke, IRK)
}

export async function handleRevokeAcmeAccountKeyDelivery(
  deps: AcmeAccountKeyDeliveryDeps,
  serverDomain: string,
  body: RevokeBody | undefined,
): Promise<HandlerResponse> {
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
    !HEX128.test(body.signature.toLowerCase())
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }

  // The box must be a registered server, and the revoke must be signed by THAT
  // server's account IRK (not just any account that names the same key).
  const reg = await deps.servers.get(serverDomain);
  if (!reg) return { status: 404, body: { error: "unknown server" } };

  const usernameNorm = r.username.toLowerCase();
  if (usernameNorm !== reg.username.toLowerCase()) {
    return { status: 403, body: { error: "username does not own this server" } };
  }
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return { status: 404, body: { error: "username not registered" } };

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }

  const envelope: RevokeAcmeAccountKey = {
    accountKeyId: r.accountKeyId,
    username: usernameNorm,
    reason: r.reason as AccountKeyRevokeReason,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevokeAcmeAccountKey(envelope, sig, irkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.delivery.deleteByDomain(serverDomain);
  return { status: 200, body: { ok: true, accountKeyId: r.accountKeyId } };
}
