// Writes packages/protocol/test-vectors/companion-delegation/vectors.json.
// Run: node --import tsx tools/companion-delegation-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalCompanionDelegation, signCompanionDelegation, verifyCompanionDelegation } from "../packages/protocol/src/companionDelegation.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x55);
const admin = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const d = { sessionId: "0123456789abcdef", serviceRef: "alice--chess", ops: ["deploy", "build"], issuedAt: 1760000000000, expiresAt: 1760001800000 };
const sig = signCompanionDelegation(d, admin);
if (!verifyCompanionDelegation(d, sig, admin.publicKey)) throw new Error("self-check failed");
const text = (x) => new TextDecoder().decode(canonicalCompanionDelegation(x));
const invalid = [
  ["another session", { ...d, sessionId: "fedcba9876543210" }],
  ["another app", { ...d, serviceRef: "alice--other" }],
  ["fewer operations", { ...d, ops: ["build"] }],
  ["a later end", { ...d, expiresAt: d.expiresAt + 1 }],
];
mkdirSync("packages/protocol/test-vectors/companion-delegation", { recursive: true });
writeFileSync("packages/protocol/test-vectors/companion-delegation/vectors.json", JSON.stringify({
  about: "A phone-signed delegation to a Remote session to build and/or deploy ONE app: flagship/companion-delegation/v1|sessionId|serviceRef|ops (sorted, comma-separated)|issuedAt|expiresAt, Ed25519, seed 0x55 repeated. The ops are sorted whatever order they are given in. Every other session, app, operation set or window must fail the signature.",
  adminSeedHex: hex(seed), adminPubHex: hex(admin.publicKey), delegation: d, canonical: text(d), signatureHex: hex(sig),
  invalid: invalid.map(([name, x]) => ({ name, delegation: x, canonical: text(x) })),
}, null, 2) + "\n");
console.log("wrote");
