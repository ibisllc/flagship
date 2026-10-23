// Writes packages/protocol/test-vectors/server-wildcard-grant/vectors.json.
// Run: node --import tsx tools/server-wildcard-grant-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalServerWildcardGrant, signServerWildcardGrant, verifyServerWildcardGrant } from "../packages/protocol/src/serverWildcardGrant.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x66);
const pub = ed.getPublicKey(seed);
const sign = (m) => ed.sign(m, seed);
const text = (g) => new TextDecoder().decode(canonicalServerWildcardGrant(g));
const base = { username: "Alice", serverDomain: "Home.Alice.flagship.services", stkPubHex: "ab".repeat(32), issuedAt: 1760000000000 };
const grants = [base, { ...base, serverDomain: "home2.alice.gym.flagship.services" }].map((g) => {
  const sig = signServerWildcardGrant(g, sign);
  if (!verifyServerWildcardGrant(g, sig, pub)) throw new Error("self-check");
  return { grant: g, canonical: text(g), signatureHex: hex(sig) };
});
const invalid = [
  ["another server", { ...base, serverDomain: "home2.alice.flagship.services" }],
  ["another identity key", { ...base, stkPubHex: "cd".repeat(32) }],
  ["another time", { ...base, issuedAt: base.issuedAt + 1 }],
].map(([name, g]) => ({ name, grant: g }));
const refused = [
  ["a server on another account", { ...base, serverDomain: "home.bob.flagship.services" }],
  ["an uppercase key", { ...base, stkPubHex: "AB".repeat(32) }],
  ["a separator in the name", { ...base, username: "al|ice" }],
].map(([name, g]) => { let threw = false; try { text(g); } catch { threw = true; } if (!threw) throw new Error(`should refuse: ${name}`); return { name, grant: g }; });
mkdirSync("packages/protocol/test-vectors/server-wildcard-grant", { recursive: true });
writeFileSync("packages/protocol/test-vectors/server-wildcard-grant/vectors.json", JSON.stringify({
  about: "The admin's once-per-server permission for a box to hold a certificate for *.<username>.<apex>: flagship/server-wildcard-grant/v1|username (lowercase)|serverDomain (lowercase)|stkPubHex|issuedAt, Ed25519, seed 0x66 repeated. Each invalid grant must fail the first grant's signature; each refused one must fail to produce canonical bytes.",
  seedHex: hex(seed), pubHex: hex(pub), grants, invalid, refused,
}, null, 2) + "\n");
console.log("wrote");
