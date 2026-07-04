/**
 * Slice D — transfer-a-box admin-root handoff proof
 * (docs/device-admin-tier-spec.md §9.8; docs/account-deletion-and-name-reclaim.md §4).
 *
 * On a transfer, the box re-homes to the ACQUIRER's account — so its pinned
 * AUTHORITY anchor (`cfg.adminRootPub`) must move from the giver's admin master
 * root to the acquirer's. The box must NOT take `.com`'s word for the new
 * anchor: the GIVER's admin master root (the root the box already pins) signs
 * an `AdminRootTransfer{ old → new }` bound to the specific box + offer, and
 * the box re-pins ONLY on a proof that verifies against its pinned root.
 * `.com` relays the proof but can never forge one (it holds no admin master
 * root) — the same trust posture as `flagship/admin-root-rotation/v1`.
 *
 * This is DELIBERATELY a distinct canonical tag from
 * `flagship/admin-root-rotation/v1`: a rotation proof re-pins EVERY box on the
 * signer's own account, while a transfer proof re-pins ONE box onto a
 * DIFFERENT account's root. Reusing the rotation tag would let a captured
 * transfer proof be replayed as an account-wide rotation of the GIVER's
 * account (handing the acquirer authority over every box the giver still
 * owns). The distinct tag + the (serverDomain, transferNonce) instance binding
 * make the proof single-purpose.
 *
 * Canonical bytes (field-guarded, `|`-separated; strings lowercased exactly
 * like the server-transfer canonicals):
 *   flagship/admin-root-transfer/v1 | serverDomain | giverUsername
 *     | acquirerUsername | oldAdminRootPubHex | newAdminRootPubHex ("" = unpin)
 *     | transferNonce | issuedAt
 *
 * Signed by the GIVER's admin master root (the box's pinned anchor):
 *   signAdminRootTransfer(t, oldAdminRoot)   → 64-byte Ed25519 sig
 *   verifyAdminRootTransfer(t, sig, oldAdminRootPub)
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_ADMIN_ROOT_TRANSFER = "flagship/admin-root-transfer/v1";

export interface AdminRootTransfer {
  /** The box's OLD canonical FQDN (`<server>.<giver>.<apex>`) — instance binding. */
  serverDomain: string;
  /** The giver account (the box's owner at offer time). */
  giverUsername: string;
  /** The acquirer account (the new owner the box re-homes to). */
  acquirerUsername: string;
  /** The giver's admin master root pubkey, hex — MUST equal the box's pinned anchor. */
  oldAdminRootPubHex: string;
  /** The acquirer's admin master root pubkey, hex — or "" to UNPIN (the
   *  acquirer account has no admin root; the box falls back to legacy
   *  owner-IRK authorization). */
  newAdminRootPubHex: string;
  /** The offer's one-time nonce — binds the proof to a specific offer/claim. */
  transferNonce: string;
  issuedAt: number;
}

function canonicalAdminRootTransfer(t: AdminRootTransfer): Bytes {
  legacyFieldGuard("serverDomain", t.serverDomain);
  legacyFieldGuard("giverUsername", t.giverUsername);
  legacyFieldGuard("acquirerUsername", t.acquirerUsername);
  legacyFieldGuard("oldAdminRootPubHex", t.oldAdminRootPubHex);
  legacyFieldGuard("newAdminRootPubHex", t.newAdminRootPubHex);
  legacyFieldGuard("transferNonce", t.transferNonce);
  return new TextEncoder().encode(
    [
      TAG_ADMIN_ROOT_TRANSFER,
      t.serverDomain.toLowerCase(),
      t.giverUsername.toLowerCase(),
      t.acquirerUsername.toLowerCase(),
      t.oldAdminRootPubHex.toLowerCase(),
      t.newAdminRootPubHex.toLowerCase(),
      t.transferNonce.toLowerCase(),
      t.issuedAt,
    ].join("|"),
  );
}

/** Sign with the GIVER's admin master root (the anchor the box already pins). */
export function signAdminRootTransfer(t: AdminRootTransfer, oldAdminRoot: Keypair): Bytes {
  return ed.sign(canonicalAdminRootTransfer(t), oldAdminRoot.privateKey);
}

/** Verify the handoff proof against the GIVER's admin master root pubkey (the
 *  box's pinned anchor / the account's registered `admin_root_pub_hex`). */
export function verifyAdminRootTransfer(
  t: AdminRootTransfer,
  sig: Bytes,
  oldAdminRootPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAdminRootTransfer(t), oldAdminRootPub);
  } catch {
    return false;
  }
}
