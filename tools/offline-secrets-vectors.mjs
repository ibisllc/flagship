// Writes packages/protocol/test-vectors/offline-secrets/vectors.json.
// Run: node --import tsx tools/offline-secrets-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalOfflineSecrets, signOfflineSecrets, swkCommitment, verifyOfflineSecrets } from "../packages/protocol/src/offlineSecrets.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x55);
const kp = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const swk = new Uint8Array(32).fill(0x66);
const order = { serverDomain: "home.alice.flagship.services", serial: "01HZZTESTSERIAL", userPub: kp.publicKey, issuedAt: 1760000000000, expiresAt: 1760003600000 };
const good = signOfflineSecrets({ serverDomain: order.serverDomain, serial: order.serial, swkSha256Hex: swkCommitment(swk), issuedAt: order.issuedAt + 1000 }, kp);
const cases = [
  ["a commitment signed for this server, order and key", good, hex(swk), "ok"],
  ["another workload key", good, hex(new Uint8Array(32).fill(0x67)), "wrong-secret"],
  ["another server", { ...good, serverDomain: "home.bob.flagship.services" }, hex(swk), "wrong-server"],
  ["another order", { ...good, serial: "OTHER" }, hex(swk), "wrong-order"],
  ["a changed signature", { ...good, signatureHex: "00".repeat(64) }, hex(swk), "bad-signature"],
  ["issued after the order expired", { ...good, issuedAt: order.expiresAt + 1 }, hex(swk), "outside-order-validity"],
  ["no commitment", null, hex(swk), "missing"],
];
const out = cases.map(([name, sibling, swkHex, expect]) => {
  const v = verifyOfflineSecrets(sibling, swkHex, order);
  const got = v.ok ? "ok" : v.reason;
  if (got !== expect) throw new Error(`${name}: expected ${expect} got ${got}`);
  return { name, sibling, swkHex, expect };
});
mkdirSync("packages/protocol/test-vectors/offline-secrets", { recursive: true });
writeFileSync("packages/protocol/test-vectors/offline-secrets/vectors.json", JSON.stringify({
  about: "Offline secret-bearing recipe commitment. Canonical bytes: flagship/offline-secrets/v1|serverDomain(lowercase)|serial|swkSha256Hex|issuedAt, signed with Ed25519 by the account key the install blob names. A sibling workload key is accepted only when its SHA-256 matches a signed commitment for the same server and order, issued within the order's validity. Seed 0x55 repeated; swk 0x66 repeated.",
  userSeedHex: hex(seed), userPubHex: hex(kp.publicKey), order: { ...order, userPub: hex(kp.publicKey) },
  canonicalOfGood: new TextDecoder().decode(canonicalOfflineSecrets(good)), cases: out,
}, null, 2) + "\n");
console.log("wrote", out.length);
