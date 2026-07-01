// Slice D — Phase 3 (webapp): rotate the admin master root.
//
// docs/device-admin-tier-spec.md §5. The owner-facing "Rotate admin key" action
// mints a FRESH random admin master root and proves the change with an
// OLD-signs-OLD→NEW rotation envelope the box verifies against its PINNED old
// root (so `.com` is never trusted as the authority anchor). After a successful
// POST the NEW root is re-stored device-local and re-escrowed under the recovery
// credential.
//
// ⚠️ REVOKE SEMANTIC: rotation EXCLUDES every OTHER admin device. A rotated
// admin root is a NEW authority key that only THIS device (and, after re-escrow,
// the recovery credential) holds — any previously-promoted admin device's
// bare-root or admin-grant authority no longer verifies against the box's
// re-pinned root once the boxes adopt the proof. This is the flat-revocation
// remedy the spec names (lose/compromise an admin device → rotate).
//
// Canonical bytes are byte-identical to the TS spine
// (packages/protocol/src/adminRootRotation.ts):
//   flagship/admin-root-rotation/v1 | username | hex(old) | hex(new) | issuedAt
// `|`-separated UTF-8, with the username field-guarded exactly like
// canonicalBase.legacyFieldGuard (reject '|' + control chars).

import {
  loadAdminRootSeed as ksLoadAdminRootSeed,
  adminRootPubHex as ksAdminRootPubHex,
  signWithAdminRoot as ksSignWithAdminRoot,
  persistAdminRootSeed as ksPersistAdminRootSeed,
  bytesToHex as ksBytesToHex,
} from "../keystore.js";
import { postAdminRootRotation as apiPostAdminRootRotation } from "./api.js";

/** Canonical-bytes tag — MUST match packages/protocol/src/adminRootRotation.ts. */
export const TAG_ADMIN_ROOT_ROTATION = "flagship/admin-root-rotation/v1";

/** Replicates packages/protocol/src/canonicalBase.ts `legacyFieldGuard`: a
 *  string field may not contain the '|' separator (0x7c) or any control char
 *  (<= 0x1f, or 0x7f) — otherwise the canonical bytes would be ambiguous. */
function guardField(name, value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) {
      throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    }
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(`canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
    }
  }
}

/** Normalise + validate a 32-byte pubkey hex (64 lowercase hex chars). Mirrors
 *  the TS `hex(bytes)` output for a 32-byte key. */
function pubHex64(name, hex) {
  const v = String(hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) {
    throw new Error(`admin-root rotation: ${name} must be 32-byte hex`);
  }
  return v;
}

/**
 * The rotation canonical bytes, byte-identical to
 * `canonicalAdminRootRotation` in the TS spine.
 *
 * @param {{ username: string, oldAdminRootPub: string, newAdminRootPub: string, issuedAt: number }} r
 * @returns {Uint8Array}
 */
export function adminRootRotationCanonicalBytes(r) {
  guardField("username", r.username);
  return new TextEncoder().encode(
    [
      TAG_ADMIN_ROOT_ROTATION,
      r.username,
      pubHex64("oldAdminRootPub", r.oldAdminRootPub),
      pubHex64("newAdminRootPub", r.newAdminRootPub),
      r.issuedAt,
    ].join("|"),
  );
}

function defaultMintSeed() {
  return (globalThis.crypto || crypto).getRandomValues(new Uint8Array(32));
}

/**
 * Rotate the admin master root end-to-end.
 *
 * Steps (docs §5.2 client half):
 *   1. Load the CURRENT admin-root seed (this device must hold it).
 *   2. Mint a FRESH random admin master root (NOT UMK-derived).
 *   3. Sign `admin-root-rotation/v1` with the OLD root (OLD signs OLD→NEW).
 *   4. POST the proof to `.com` (records the new pub + relays to the boxes).
 *   5. Re-store the NEW root device-local + re-escrow it under the recovery
 *      credential, and update the live session so subsequent sensitive orders
 *      sign under the new root.
 *
 * All side-effecting collaborators are injectable → unit-testable without
 * IndexedDB / the network.
 *
 * @param {{
 *   username: string,
 *   umkSeed: Uint8Array,
 *   currentAdminRootSeed?: Uint8Array|null,
 *   session?: { adminRootSeed?: Uint8Array|null },
 *   loadAdminRootSeed?: (umk: Uint8Array) => Promise<Uint8Array|null>,
 *   adminRootPubHex?: (seed: Uint8Array) => Promise<string>,
 *   signWithAdminRoot?: (seed: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>,
 *   persistAdminRootSeed?: (umk: Uint8Array, adminSeed: Uint8Array) => Promise<void>,
 *   postAdminRootRotation?: (args: object) => Promise<object>,
 *   reEscrow?: (username: string) => Promise<unknown>,
 *   mintSeed?: () => Uint8Array,
 *   bytesToHex?: (b: Uint8Array) => string,
 *   now?: () => number,
 *   fetch?: typeof fetch,
 *   baseUrl?: string,
 * }} deps
 * @returns {Promise<{ oldAdminRootPub: string, newAdminRootPub: string, issuedAt: number, newAdminRootSeed: Uint8Array }>}
 */
export async function runRotateAdminRoot(deps) {
  const { username, umkSeed } = deps;
  if (!username) throw new Error("rotate: username required");
  if (!(umkSeed instanceof Uint8Array) || umkSeed.length !== 32) {
    throw new Error("rotate: unlock the webapp first");
  }
  const loadSeed = deps.loadAdminRootSeed || ksLoadAdminRootSeed;
  const pubHex = deps.adminRootPubHex || ksAdminRootPubHex;
  const signAdmin = deps.signWithAdminRoot || ksSignWithAdminRoot;
  const persist = deps.persistAdminRootSeed || ksPersistAdminRootSeed;
  const post = deps.postAdminRootRotation || apiPostAdminRootRotation;
  const toHex = deps.bytesToHex || ksBytesToHex;
  const mintSeed = deps.mintSeed || defaultMintSeed;
  const now = deps.now ?? (() => Date.now());

  // 1 — the OLD (current) admin root. Only an admin device can rotate.
  const oldSeed = deps.currentAdminRootSeed instanceof Uint8Array
    ? deps.currentAdminRootSeed
    : await loadSeed(umkSeed);
  if (!(oldSeed instanceof Uint8Array) || oldSeed.length !== 32) {
    throw new Error("rotate: this device isn't an admin device — no admin root to rotate");
  }

  // 2 — mint the fresh random root.
  const newSeed = mintSeed();
  if (!(newSeed instanceof Uint8Array) || newSeed.length !== 32) {
    throw new Error("rotate: minted admin root is malformed");
  }

  const oldAdminRootPub = pubHex64("oldAdminRootPub", await pubHex(oldSeed));
  const newAdminRootPub = pubHex64("newAdminRootPub", await pubHex(newSeed));
  const issuedAt = now();
  const rotation = { username, oldAdminRootPub, newAdminRootPub, issuedAt };

  // 3 — OLD signs OLD→NEW.
  const sig = await signAdmin(oldSeed, adminRootRotationCanonicalBytes(rotation));
  const signatureHex = toHex(sig);

  // 4 — publish to `.com`. On failure we do NOT touch local custody, so the
  // device keeps signing under the OLD root (no half-applied rotation).
  await post({
    username,
    rotation,
    signatureHex,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  });

  // 5 — re-store the NEW root, update the session, re-escrow under recovery.
  await persist(umkSeed, newSeed);
  if (deps.session) deps.session.adminRootSeed = newSeed;
  if (typeof deps.reEscrow === "function") {
    // Best-effort: a rotation still succeeds even if the account has no recovery
    // credential enrolled (nothing to re-wrap) or re-escrow transiently fails.
    try { await deps.reEscrow(username); } catch { /* best-effort re-escrow */ }
  }

  return { oldAdminRootPub, newAdminRootPub, issuedAt, newAdminRootSeed: newSeed };
}
