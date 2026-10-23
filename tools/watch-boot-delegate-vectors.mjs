// Writes packages/protocol/test-vectors/watch-boot-delegate/vectors.json.
// Run: node --import tsx tools/watch-boot-delegate-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519.js";
import { ed } from "../packages/protocol/src/edSync.ts";
import { buildWatchBootDeposit, canonicalWatchBootDelegate, openWatchBootKey, verifyWatchBootDelegate } from "../packages/protocol/src/watchBootDelegate.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const accountSeed = new Uint8Array(32).fill(0x66);
const account = { privateKey: accountSeed, publicKey: ed.getPublicKey(accountSeed) };
const delegatePub = ed.getPublicKey(new Uint8Array(32).fill(0x77));
const decryptPriv = new Uint8Array(32).fill(0x88);
const decryptPub = x25519.getPublicKey(decryptPriv);
const diskKey = new Uint8Array(32).fill(0x99);
const dep = buildWatchBootDeposit(
  { serverDomain: "Kitchen.Alice.flagship.services", diskKey, delegatePub, decryptPub, issuedAt: 1760000000000, expiresAt: 1760000000000 + 24 * 3600_000 },
  account,
);
const unsigned = { serverDomain: dep.serverDomain, delegatePubHex: dep.delegatePubHex, decryptPubHex: dep.decryptPubHex, keySha256Hex: dep.keySha256Hex, issuedAt: dep.issuedAt, expiresAt: dep.expiresAt };
if (!verifyWatchBootDelegate(unsigned, Buffer.from(dep.signatureHex, "hex"), account.publicKey)) throw new Error("self-check: signature");
if (hex(openWatchBootKey(dep, decryptPriv)) !== hex(diskKey)) throw new Error("self-check: open");
const text = (x) => new TextDecoder().decode(canonicalWatchBootDelegate(x));
const invalid = [
  ["another server", { ...unsigned, serverDomain: "attic.alice.flagship.services" }],
  ["another watch", { ...unsigned, delegatePubHex: hex(ed.getPublicKey(new Uint8Array(32).fill(0x78))) }],
  ["another decryption key", { ...unsigned, decryptPubHex: hex(x25519.getPublicKey(new Uint8Array(32).fill(0x89))) }],
  ["another disk key", { ...unsigned, keySha256Hex: "ab".repeat(32) }],
  ["a later end", { ...unsigned, expiresAt: unsigned.expiresAt + 1 }],
];
mkdirSync("packages/protocol/test-vectors/watch-boot-delegate", { recursive: true });
writeFileSync("packages/protocol/test-vectors/watch-boot-delegate/vectors.json", JSON.stringify({
  about: "The account key's attestation of a disk-key copy sealed to a watch's boot-only X25519 key: flagship/watch-boot-delegate/v1|serverDomain (lowercase)|delegatePubHex|decryptPubHex|keySha256Hex|issuedAt|expiresAt, Ed25519, account seed 0x66 repeated. The sealed copy opens with decryptPriv (X25519 seed 0x88 repeated) to the 32-byte key 0x99 repeated, whose SHA-256 is keySha256Hex. Every other server, watch, decryption key, key digest or window fails the same signature.",
  accountSeedHex: hex(accountSeed), accountPubHex: hex(account.publicKey),
  decryptPrivHex: hex(decryptPriv), diskKeyHex: hex(diskKey),
  deposit: dep, canonical: text(unsigned),
  invalid: invalid.map(([name, d]) => ({ name, delegate: d, canonical: text(d) })),
}, null, 2) + "\n");
console.log("wrote");
