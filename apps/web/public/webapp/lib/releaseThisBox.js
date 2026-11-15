// "Release this box" (docs/retail-box-setup.md §8.2, §15.3): the account's admin root orders a
// retail box wiped back to unclaimed. Releasing always wipes. Port of
// packages/protocol/src/boxRelease.ts; must pass packages/protocol/test-vectors/box-release.
//
//   flagship/box-release/v1|<serverDomain>|<stkPubHex>|<issuedAt>|<nonceHex>
//
// Signed by the admin root only, never the IRK (the box refuses it). The webapp signs classically:
// it has no ML-DSA key, so a strict box answers `release-needs-hybrid` and the owner uses the phone.

import { bytesToHex, signWithAdminRoot } from "../keystore.js";
import { tr } from "./i18n.js";

export const TAG_BOX_RELEASE = "flagship/box-release/v1";
export const BOX_RELEASE_PATH = "/api/screens/box-release";

const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const STK = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;

/** "domain", "stk", "time", "nonce" or null. */
export function boxReleaseProblem(o) {
  if (!o || typeof o.serverDomain !== "string" || !DOMAIN.test(o.serverDomain)) return "domain";
  if (typeof o.stkPubHex !== "string" || !STK.test(o.stkPubHex)) return "stk";
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt <= 0) return "time";
  if (typeof o.nonceHex !== "string" || !NONCE.test(o.nonceHex)) return "nonce";
  return null;
}

export function canonicalBoxRelease(o) {
  const p = boxReleaseProblem(o);
  if (p) throw new Error(`box release order: bad ${p}`);
  return new TextEncoder().encode([TAG_BOX_RELEASE, o.serverDomain, o.stkPubHex, String(o.issuedAt), o.nonceHex].join("|"));
}

export function makeBoxRelease({ serverDomain, stkPubHex, issuedAt, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  return {
    serverDomain: String(serverDomain).toLowerCase(),
    stkPubHex: String(stkPubHex).toLowerCase(),
    issuedAt,
    nonceHex: bytesToHex(random(16)),
  };
}

/** The body `POST /api/screens/box-release` takes, signed by the admin root seed. */
export async function signBoxRelease(order, adminRootSeed, sign = signWithAdminRoot) {
  if (!(adminRootSeed instanceof Uint8Array)) throw new Error(RELEASE_ADMIN_ONLY);
  const sig = await sign(adminRootSeed, canonicalBoxRelease(order));
  return { order: { ...order }, signatureHex: bytesToHex(sig) };
}

export const RELEASE_TITLE = tr("Release this box");
export const RELEASE_WARNING = tr("Releasing wipes everything on this box: its apps, their data and its keys. It can't be undone. The box goes back to new, ready for its next owner.");
export const RELEASE_SUGGESTION = tr("To keep your data, make a backup first, or transfer the server to its new owner instead.");
export const RELEASE_ADMIN_ONLY = tr("Only an admin device of this account can release this box.");
export const RELEASE_DONE = tr("The box is being wiped. It restarts as a new box.");

/** The box's refusal code as a sentence. */
export function releaseRefusal(code) {
  switch (code) {
    case "release-not-admin":
    case "release-no-admin-root":
      return tr("Only this account's admin key can release this box.");
    case "release-needs-hybrid":
      return tr("This server needs a quantum-safe signature, which the webapp can't make. Release it from the Flagship app on an admin phone.");
    case "release-other-server":
      return tr("That order is for another server. Refresh this page and try again.");
    case "release-clock":
      return tr("This device's clock is too far from the server's. Check the time and try again.");
    case "release-replayed":
      return tr("That order was already used. Try again.");
    case "release-not-claimed":
      return tr("This box is already released.");
    default:
      return tr("The box couldn't be released. Try again in a moment.");
  }
}
