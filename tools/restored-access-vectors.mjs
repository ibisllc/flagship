// Writes packages/protocol/test-vectors/restored-access-approve/vectors.json.
// Run: node --import tsx tools/restored-access-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { restoredAccessApproveCanonicalBytes, signRestoredAccessApprove, verifyRestoredAccessApprove } from "../packages/protocol/src/appAccessOrders.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x44);
const admin = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const order = { serviceRef: "alice--chess", draftSha256: "ab".repeat(32), issuedAt: 1760000000000 };
const sig = signRestoredAccessApprove(order, admin);
if (!verifyRestoredAccessApprove(order, sig, admin.publicKey)) throw new Error("self-check failed");
const others = [
  ["another app", { ...order, serviceRef: "alice--other" }],
  ["another draft", { ...order, draftSha256: "cd".repeat(32) }],
  ["another issue time", { ...order, issuedAt: order.issuedAt + 1 }],
];
mkdirSync("packages/protocol/test-vectors/restored-access-approve", { recursive: true });
writeFileSync("packages/protocol/test-vectors/restored-access-approve/vectors.json", JSON.stringify({
  about: "An admin's approval of the permissions a restore held back: flagship/restored-access-approve/v1|serviceRef|draftSha256|issuedAt, Ed25519, seed 0x44 repeated. The signature covers one app and one draft digest; every other pair must fail.",
  adminSeedHex: hex(seed), adminPubHex: hex(admin.publicKey), order,
  canonical: new TextDecoder().decode(restoredAccessApproveCanonicalBytes(order)), signatureHex: hex(sig),
  invalid: others.map(([name, o]) => ({ name, order: o, canonical: new TextDecoder().decode(restoredAccessApproveCanonicalBytes(o)) })),
}, null, 2) + "\n");
console.log("wrote");
