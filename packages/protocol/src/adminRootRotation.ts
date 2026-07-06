/**
 * Slice D — admin master-root rotation proof (docs/device-admin-tier-spec.md §5).
 *
 * The box must NOT trust `.com`'s word for a new admin authority root. When
 * credential recovery mints a fresh admin master root, the OLD admin root signs
 * an `AdminRootRotation{ old → new }`. The box verifies the proof against its
 * PINNED `adminRootPub` (the old root), then — and only then — re-pins to the
 * new root. `.com` relays the proof but can never forge one (it lacks the old
 * master root), which is exactly what lets the box adopt a relayed new root.
 *
 * Canonical bytes (field-guarded, `|`-separated):
 *   flagship/admin-root-rotation/v1 | username | hex(oldAdminRootPub)
 *     | hex(newAdminRootPub) | issuedAt
 *
 * Signed by the OLD admin master root:
 *   signAdminRootRotation(r, oldAdminRoot)   → 64-byte Ed25519 sig
 *   verifyAdminRootRotation(r, sig, oldAdminRootPub)
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_ADMIN_ROOT_ROTATION = "flagship/admin-root-rotation/v1";

export interface AdminRootRotation {
  /** Account whose admin authority root is rotating. */
  username: string;
  /** MUST equal the box's currently-pinned adminRootPub (the anchor being replaced). */
  oldAdminRootPub: Bytes;
  /** The freshly-minted admin master root the box re-pins to on a valid proof. */
  newAdminRootPub: Bytes;
  /** ms since epoch. */
  issuedAt: number;
}

function canonicalAdminRootRotation(r: AdminRootRotation): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [
      TAG_ADMIN_ROOT_ROTATION,
      r.username,
      hex(r.oldAdminRootPub),
      hex(r.newAdminRootPub),
      r.issuedAt,
    ].join("|"),
  );
}

/** Sign with the OLD admin master root (the anchor the box already pins). */
export function signAdminRootRotation(r: AdminRootRotation, oldAdminRoot: Keypair): Bytes {
  return ed.sign(canonicalAdminRootRotation(r), oldAdminRoot.privateKey);
}

/** Verify the proof against the OLD admin master root pubkey (the pinned anchor). */
export function verifyAdminRootRotation(
  r: AdminRootRotation,
  sig: Bytes,
  oldAdminRootPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAdminRootRotation(r), oldAdminRootPub);
  } catch {
    return false;
  }
}
