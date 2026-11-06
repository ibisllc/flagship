// Which IRK does this account hold now? (key-file import, the recovery path)
//
// The clients derive the IRK from the UMK three ways, and an account holds
// whichever one its creating client (or its last re-pair) used:
//   web      HKDF(umk, salt "",                  info "flagship.irk.v<n>")   this app, @flagship/protocol
//   ios      HKDF(umk, salt "",                  info "flagship/irk/v<n>")
//   android  HKDF(umk, salt "flagship/irk/v<n>", info "ed25519-seed")
// So an import can't assume its own v1: it derives every scheme at v1..MAX,
// keeps the one whose public key is the IRK `.com` serves for the account, and
// rotates to the web scheme at that version + 1. `.com` still checks both
// signatures; the lookup only picks which key we sign with. The key material
// itself stays in keystore.js (deriveIrkInScheme, adoptRegisteredIrk).
// Vectors: packages/protocol/test-vectors/irk-lineage (tools/irk-lineage-vectors.mjs).

import { IRK_SCHEMES, OWN_IRK_SCHEME, deriveIrkInScheme } from "../keystore.js";

export { IRK_SCHEMES, OWN_IRK_SCHEME };
export const MAX_IRK_VERSION = 16;

function toHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `{ scheme, version, publicKey, pubHex, sign(bytes) }` for the IRK at
 *  `version` under `scheme`. */
export async function irkKeyFor(umk, scheme, version) {
  const { privateKey, publicKey } = await deriveIrkInScheme(umk, scheme, version);
  return {
    scheme,
    version,
    publicKey,
    pubHex: toHex(publicKey),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes)),
  };
}

/** The key under `umk` whose public half is `registeredPubHex`, or null when
 *  none of v1..MAX in any scheme is (another account, or a key file from before
 *  the account's key was replaced). Own scheme first: the common case. */
export async function findRegisteredIrk(umk, registeredPubHex, { maxVersion = MAX_IRK_VERSION } = {}) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) throw new Error("umk seed must be 32 bytes");
  const want = String(registeredPubHex ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return null;
  const order = [OWN_IRK_SCHEME, ...Object.keys(IRK_SCHEMES).filter((s) => s !== OWN_IRK_SCHEME)];
  for (let v = 1; v <= maxVersion; v++) {
    for (const scheme of order) {
      const key = await irkKeyFor(umk, scheme, v);
      if (key.pubHex === want) return key;
    }
  }
  return null;
}

/** The version this app rotates to after `registered`: always higher, so a key
 *  a re-pair displaced is never the one installed again. */
export function nextIrkVersion(registered) {
  return registered.version + 1;
}

/** `GET /api/username/<u>` → the account's registered IRK (lowercase hex).
 *  Throws `{ status: 404 }` for an unknown account. */
export async function fetchRegisteredIrkPub(username, { fetch: f = fetch, baseUrl } = {}) {
  const resp = await f(`${baseUrl}/api/username/${encodeURIComponent(username)}`, { cache: "no-store" });
  if (!resp.ok) {
    const err = new Error(`account lookup failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const body = await resp.json();
  const pub = String(body?.irkPub ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pub)) throw new Error("account lookup returned no key");
  return pub;
}
