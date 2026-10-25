// Writes packages/protocol/test-vectors/publisher-trust/vectors.json.
// Run: node --import tsx tools/publisher-trust-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalPublisherTrust, signPublisherTrust, verifyPublisherTrust } from "../packages/protocol/src/appRelease.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x33);
const owner = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const trust = { serviceId: "alice-chess", appId: "alice--chess", identityGeneration: 1, oldKeyHex: "a".repeat(64), newKeyHex: "b".repeat(64), newEpoch: 1, issuedAt: 1760000000000 };
const sig = signPublisherTrust(trust, owner);
if (!verifyPublisherTrust(trust, sig, owner.publicKey)) throw new Error("self-check failed");
// AT-ENV-09: every port refuses a '|' or a control character in a text field before signing.
const refuse = [
  { why: "a '|' in oldKeyHex would move into newKeyHex (AT-ENV-09e)", trust: { ...trust, oldKeyHex: `${trust.oldKeyHex}|${trust.newKeyHex}` } },
  { why: "a '|' in newKeyHex would move into newEpoch", trust: { ...trust, newKeyHex: `${trust.newKeyHex}|1` } },
  { why: "a control character in serviceId", trust: { ...trust, serviceId: "alice-chess\n" } },
  { why: "DEL in appId", trust: { ...trust, appId: "alice--chess\u007f" } },
];
for (const r of refuse) {
  let threw = false;
  try { canonicalPublisherTrust(r.trust); } catch { threw = true; }
  if (!threw) throw new Error(`not refused: ${r.why}`);
}
mkdirSync("packages/protocol/test-vectors/publisher-trust", { recursive: true });
writeFileSync("packages/protocol/test-vectors/publisher-trust/vectors.json", JSON.stringify({
  about: "What the owner's device signs to trust a new publisher key for ONE service: flagship/publisher-trust/v1|serviceId|appId|identityGeneration|oldKeyHex|newKeyHex|newEpoch|issuedAt, Ed25519, seed 0x33 repeated. Every port refuses each trust in \`refuse\` before signing: a '|' or a control character (0x00-0x1f, 0x7f) in any text field; numeric fields are integers.",
  ownerSeedHex: hex(seed), ownerPubHex: hex(owner.publicKey), trust, canonical: new TextDecoder().decode(canonicalPublisherTrust(trust)), signatureHex: sig,
  refuse,
}, null, 2) + "\n");
console.log("wrote");
