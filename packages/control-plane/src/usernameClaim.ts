import { verifyClaimUsername, type ClaimUsername } from "@flagship/protocol";
import type { UsernameStorage, UsernameOfferStorage } from "@flagship/storage";
import { HEX128, HEX64, hexToBytes, bytesToHex } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import { conflict, forbidden, malformed, notFound, ok } from "./types.js";
import type { HandlerResponseWithHeaders } from "./types.js";

/** How long a suggested name stays claimable (docs/username-suggestion-queue.md).
 *  Generous vs. an actual sign-up (seconds–minutes) so a slow one isn't blocked. */
export const OFFER_TTL_MS = 60 * 60_000;

export interface UsernameClaimDeps {
  storage: UsernameStorage;
  /**
   * The recently-offered roster. When present, a claim is ALLOWED only for a name
   * the server recently SUGGESTED (or one already owned by the claimant — the
   * idempotent re-claim). Prod wires this; legacy test-setups omit it (no gate).
   * docs/username-suggestion-queue.md §3.
   */
  offers?: UsernameOfferStorage;
  offerTtlMs?: number;
  /** Trusted ops/test path (admin-authorized at the edge) bypasses the roster. */
  bypassOfferGate?: boolean;
  freshnessMs?: number;
  now?: () => number;
}

export interface UsernameClaimBody {
  request?: { username?: string; irkPub?: string; issuedAt?: number };
  signature?: string;
  /**
   * Service-access gating v2 — the account's STABLE AID pubkey (hex,
   * `deriveAccountId(UMK)`). OPTIONAL + additive: it is NOT part of the
   * IRK-signed claim canonical bytes (so existing client signing is unchanged),
   * it is merely recorded next to the IRK so `.com` can later verify AID-signed
   * service-invite create/revoke against it (dual-accept with the IRK). A
   * malformed value is ignored, never rejected — it can't block a claim.
   */
  aidPub?: string;
  /**
   * Slice D (docs/device-admin-tier-spec.md §1.2) — the account's pinned ADMIN
   * MASTER ROOT pubkey (hex). A fresh RANDOM Ed25519 keypair the FIRST device
   * mints at account creation (NOT UMK-derived), recorded next to the IRK so
   * `.com` can later serve unforgeable admin authority decisions. OPTIONAL +
   * additive (like `aidPub`): NOT part of the IRK-signed claim canonical bytes,
   * and a malformed value is ignored, never rejected. Phase 2 clients start
   * sending it; Phase 0 keeps it optional so existing flows compile + pass.
   */
  adminRootPub?: string;
}

export async function handleUsernameClaim(
  deps: UsernameClaimDeps,
  body: UsernameClaimBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.irkPub !== "string" ||
    !HEX64.test(r.irkPub) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(r.irkPub);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const claim: ClaimUsername = { username: r.username, irkPub, issuedAt: r.issuedAt };
  if (!verifyClaimUsername(claim, sig, irkPub)) return forbidden("invalid signature");
  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  const v = validateUserLabel(r.username);
  if (!v.ok) return malformed(v.reason);

  // Roster gate — a username is claimable ONLY if the server recently SUGGESTED
  // it (so the generator's not-claimed + not-.com vetting is what gates claims).
  // Exceptions: a name already owned by THIS claimant (idempotent re-claim), and
  // a trusted ops/test path. docs/username-suggestion-queue.md §3.
  if (deps.offers && !deps.bypassOfferGate) {
    const notBefore = now - (deps.offerTtlMs ?? OFFER_TTL_MS);
    const offered = await deps.offers.isOffered(v.label, notBefore);
    if (!offered) {
      const existing = await deps.storage.get(v.label);
      const sameOwner =
        existing !== undefined &&
        existing.irkPubHex.toLowerCase() === bytesToHex(irkPub).toLowerCase();
      if (!sameOwner) {
        return forbidden("that name isn't available — pick one of the suggested handles");
      }
    }
  }

  // gating v2 — record the stable AID alongside the IRK when the client
  // supplies a well-formed one. Ignored if absent/malformed (never blocks).
  const aidPubHex =
    typeof body.aidPub === "string" && HEX64.test(body.aidPub)
      ? body.aidPub.toLowerCase()
      : undefined;

  // Slice D — record the pinned admin master root alongside the IRK when the
  // client supplies a well-formed one. Ignored if absent/malformed (never
  // blocks a claim), mirroring the AID.
  const adminRootPubHex =
    typeof body.adminRootPub === "string" && HEX64.test(body.adminRootPub)
      ? body.adminRootPub.toLowerCase()
      : undefined;

  const out = await deps.storage.put({
    username: v.label,
    irkPubHex: bytesToHex(irkPub),
    claimedAt: now,
    ...(aidPubHex ? { aidPubHex } : {}),
    ...(adminRootPubHex ? { adminRootPubHex } : {}),
  });
  if (!out.ok) return conflict(out.reason);
  // Claimed — retire the offer so the roster stays small + a name can't be
  // "re-claimed off-roster" by a different key later.
  if (deps.offers) await deps.offers.consume(v.label);
  return ok({ ok: true, username: v.label });
}

export async function handleUsernameLookup(
  storage: UsernameStorage,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const rec = await storage.get(username);
  if (!rec) return notFound("not found");
  // v1.2 Phase 4 — surface accountType + totpEnrolledAt so the
  // mobile / webapp Settings surface can render the "Single-device"
  // vs "Multi-device + 2FA" badge without needing a separate call.
  // Defaults to `'single'` for pre-migration rows (matching the
  // column DEFAULT). The totp_secret_encrypted blob is NEVER echoed
  // here — only the enrolled-at timestamp, which is non-sensitive.
  return ok({
    username: rec.username,
    irkPub: rec.irkPubHex,
    claimedAt: rec.claimedAt,
    accountType: rec.accountType ?? "single",
    totpEnrolledAt: rec.totpEnrolledAt ?? null,
    // Slice D — serve the pinned admin master root (or null when the account
    // has none yet). Clients + boxes pin/verify authority against this.
    adminRootPub: rec.adminRootPubHex ?? null,
  });
}
