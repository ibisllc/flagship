/**
 * Mint-reservation lease — the dead-lead-safe CAS lock that serializes who
 * re-mints a SHARED cert this cycle. (Under cert model A′ each box mints its
 * own distinct `[<server>.<user>, *.<server>.<user>]` cert with no
 * contention — the lease matters for certs more than one minter could race
 * on, i.e. the tier-2 shared `<service>.<user>` cert.)
 *
 * A minter (an admin-scope device, or an "autonomous" box holding a renewal
 * delegation) that sees the cert nearing expiry signs a `MintReservationClaim`
 * with its OWN minting key and acquires the lease here. Other minters back off
 * while a live reservation exists; if the holder dies the TTL lapses
 * (δ ≈ one ACME order ≪ remaining cert life) and the next minter takes over —
 * dead-lead-safe, no static election.
 *
 * Wire contract:
 *   POST /api/users/:u/mint-reservation          → handleAcquireMintReservation
 *   POST /api/users/:u/mint-reservation/release  → handleReleaseMintReservation
 *
 * The HOLDER signs the claim (authentication), and `requireMinter` (from
 * acmeAccountKeys) SEPARATELY confirms the holder is genuinely a minter for
 * the user (authorization) — a valid self-signature alone must not let an
 * arbitrary key grab a user's mint lease. The lease itself is non-secret
 * coordination metadata: `.com` orders/dedupes it but cannot forge a cert,
 * and the trust-root's CT monitor catches anything that slips.
 *
 * BEST-EFFORT by design: if `.com` is unreachable the daemon falls back to a
 * deterministic local order, so cert RENEWAL never hard-depends on `.com`.
 */

import {
  verifyMintReservation,
  type MintReservationClaim,
} from "@flagship/protocol";
import type {
  AcmeAccountKeyGrantStorage,
  MintReservationStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";
import { requireMinter } from "./acmeAccountKeys.js";

export interface MintReservationsDeps {
  reservations: MintReservationStorage;
  acmeGrants: AcmeAccountKeyGrantStorage;
  usernames: UsernameStorage;
  now?: () => number;
}

// ── wire body (shared by acquire + release — both are a signed claim) ───────

interface ClaimBody {
  claim?: {
    username?: unknown;
    holderPubKey?: unknown; // 32-byte hex
    expiresAt?: unknown;
  };
  signature?: unknown; // 64-byte hex (Ed25519 over the canonical bytes, HOLDER)
}

/**
 * Parse + signature-check a `MintReservationClaim` body. The HOLDER signed it
 * (self-authentication). Returns the normalized fields or a handler error.
 */
function parseSignedClaim(
  body: ClaimBody | undefined,
):
  | { ok: true; usernameNorm: string; holderPubHex: string; expiresAt: number }
  | { ok: false; res: HandlerResponseWithHeaders } {
  const c = body?.claim;
  if (
    !c ||
    typeof c.username !== "string" ||
    c.username.length === 0 ||
    typeof c.holderPubKey !== "string" ||
    !HEX64.test(c.holderPubKey) ||
    typeof c.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return { ok: false, res: malformed("malformed body") };
  }

  let holderPub: Uint8Array;
  let sig: Uint8Array;
  try {
    holderPub = hexToBytes(c.holderPubKey);
    sig = hexToBytes(body.signature);
  } catch {
    return { ok: false, res: malformed("invalid hex") };
  }

  const usernameNorm = c.username.toLowerCase();
  const claim: MintReservationClaim = {
    username: usernameNorm,
    holderPubKey: holderPub,
    expiresAt: c.expiresAt,
  };
  // The holder signs its own claim; a bad signature (or malformed envelope the
  // canonical-bytes pass throws on) folds to a single 403.
  if (!verifyMintReservation(claim, sig, holderPub)) {
    return { ok: false, res: forbidden("invalid signature") };
  }

  return {
    ok: true,
    usernameNorm,
    holderPubHex: c.holderPubKey.toLowerCase(),
    expiresAt: c.expiresAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/mint-reservation
// ──────────────────────────────────────────────────────────────────────

export async function handleAcquireMintReservation(
  deps: MintReservationsDeps,
  body: ClaimBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();

  const parsed = parseSignedClaim(body);
  if (!parsed.ok) return parsed.res;

  // The self-signature proves who is asking; `requireMinter` proves they're
  // ALLOWED to mint for this user (account IRK, or an active+verifying ACME
  // account-key grant). Anyone else is rejected before touching the lease.
  const minter = await requireMinter(
    { storage: deps.acmeGrants, usernames: deps.usernames, now: () => now },
    { username: parsed.usernameNorm, signerPubHex: parsed.holderPubHex },
  );
  if (!minter.ok) return forbidden(minter.reason);

  const result = await deps.reservations.tryAcquire({
    username: parsed.usernameNorm,
    holderPubHex: parsed.holderPubHex,
    expiresAt: parsed.expiresAt,
    now,
  });

  return ok({
    acquired: result.acquired,
    holder: {
      username: result.holder.username,
      holderPubKey: result.holder.holderPubHex,
      acquiredAt: result.holder.acquiredAt,
      expiresAt: result.holder.expiresAt,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/mint-reservation/release
// ──────────────────────────────────────────────────────────────────────

export async function handleReleaseMintReservation(
  deps: MintReservationsDeps,
  body: ClaimBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const parsed = parseSignedClaim(body);
  if (!parsed.ok) return parsed.res;

  // Release is a no-op unless `holderPubHex` actually holds the lease — a
  // stale holder can't free a successor's lease (enforced in storage). The
  // self-signature is sufficient authorization to drop YOUR OWN lease; no
  // requireMinter gate is needed (releasing early only forfeits leadership).
  await deps.reservations.release(parsed.usernameNorm, parsed.holderPubHex);
  return ok({ ok: true, username: parsed.usernameNorm });
}
