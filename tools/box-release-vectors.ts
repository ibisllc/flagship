#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for `flagship/box-release/v1` (docs/retail-box-setup.md §8.2, §15.3). The
 * TypeScript port (packages/protocol/src/boxRelease.ts) GENERATES them; the TS test checks every
 * case, and the Swift and Kotlin ports are to read the same file.
 *
 * Run:          npx tsx tools/box-release-vectors.ts
 * CI freshness: npx tsx tools/box-release-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { boxReleaseProblem, canonicalBoxRelease, signBoxRelease, type BoxReleaseOrder } from "../packages/protocol/src/boxRelease.js";
import { ed } from "../packages/protocol/src/edSync.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/box-release/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const seed = (v: number) => new Uint8Array(32).fill(v);

const adminSeed = seed(0x22);
const admin = { privateKey: adminSeed, publicKey: ed.getPublicKey(adminSeed) };
const irkSeed = seed(0x11);
const irkPub = ed.getPublicKey(irkSeed);
const stkPub = ed.getPublicKey(seed(0x33));

const order: BoxReleaseOrder = {
  serverDomain: "home.alice.flagship.services",
  stkPubHex: hex(stkPub),
  issuedAt: 1_790_000_000_000,
  nonceHex: "0f".repeat(16),
};
const sig = signBoxRelease(order, admin);
const irkSig = ed.sign(canonicalBoxRelease(order), irkSeed);
const other = { ...order, stkPubHex: hex(ed.getPublicKey(seed(0x44))) };

const refuse: Array<{ why: string; fields: unknown; problem: string }> = [
  { why: "upper-case domain", fields: { ...order, serverDomain: "Home.alice.flagship.services" }, problem: "domain" },
  { why: "separator in the domain", fields: { ...order, serverDomain: "home|x" }, problem: "domain" },
  { why: "short key", fields: { ...order, stkPubHex: order.stkPubHex.slice(2) }, problem: "stk" },
  { why: "upper-case key", fields: { ...order, stkPubHex: order.stkPubHex.toUpperCase() }, problem: "stk" },
  { why: "fractional time", fields: { ...order, issuedAt: 1.5 }, problem: "time" },
  { why: "zero time", fields: { ...order, issuedAt: 0 }, problem: "time" },
  { why: "short nonce", fields: { ...order, nonceHex: "0f".repeat(15) }, problem: "nonce" },
];
for (const r of refuse) if (boxReleaseProblem(r.fields as BoxReleaseOrder) !== r.problem) throw new Error(`refuse case ${r.why} does not refuse`);

const out = {
  description: "flagship/box-release/v1: an admin-root-signed order that wipes a retail box back to unclaimed (docs/retail-box-setup.md §8.2).",
  keys: { adminRootSeedHex: hex(adminSeed), adminRootPubHex: hex(admin.publicKey), irkPubHex: hex(irkPub), stkPubHex: hex(stkPub) },
  order: {
    fields: order,
    canonical: new TextDecoder().decode(canonicalBoxRelease(order)),
    signatureHex: hex(sig),
  },
  reject: [
    { why: "signed by the IRK, not the admin root", fields: order, signatureHex: hex(irkSig), verifyUnder: hex(admin.publicKey) },
    { why: "the admin root's signature checked under the IRK", fields: order, signatureHex: hex(sig), verifyUnder: hex(irkPub) },
    { why: "another box's key in the order", fields: other, signatureHex: hex(sig), verifyUnder: hex(admin.publicKey) },
    { why: "a later time than signed", fields: { ...order, issuedAt: order.issuedAt + 1 }, signatureHex: hex(sig), verifyUnder: hex(admin.publicKey) },
  ],
  refuse,
};

const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const cur = readFileSync(OUT, "utf8");
  if (cur !== json) {
    console.error("box-release vectors are stale: run npx tsx tools/box-release-vectors.ts");
    process.exit(1);
  }
  console.log("box-release vectors are current");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
