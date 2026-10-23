#!/usr/bin/env node
// Writes packages/protocol/test-vectors/box-key-pin/vectors.json from the TS
// reference (packages/protocol/src/boxKeyPin.ts). Build the protocol package
// first:
//   npx tsc -b packages/protocol && node scripts/gen-box-key-pin-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/box-key-pin/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);

const serverDomain = "home.plucky-avocet.flagship.services";
const stkSeed = fill(32, 0x5b);
const stkPub = hex(P.ed.getPublicKey(stkSeed));
const otherSeed = fill(32, 0x6c);
const otherPub = hex(P.ed.getPublicKey(otherSeed));
const bootPub = hex(P.ed.getPublicKey(fill(32, 0x7d)));

const binding = { serverDomain, bootPubHex: bootPub, issuedAt: 1_760_000_000_000 };
const canonical = new TextDecoder().decode(P.canonicalBootKeyBinding(binding));
const signature = hex(P.signBootKeyBinding(binding, (m) => P.ed.sign(m, stkSeed)));
const forged = hex(P.signBootKeyBinding(binding, (m) => P.ed.sign(m, otherSeed)));

const decisions = [
  { pinned: null, reported: stkPub, verdict: "first" },
  { pinned: stkPub, reported: stkPub, verdict: "match" },
  { pinned: stkPub, reported: stkPub.toUpperCase(), verdict: "match" },
  { pinned: stkPub, reported: otherPub, verdict: "mismatch" },
  { pinned: stkPub, reported: "", verdict: "invalid" },
  { pinned: null, reported: "abcd", verdict: "invalid" },
];
for (const d of decisions) {
  const got = P.decideBoxKeyPin(d.pinned, d.reported);
  if (got !== d.verdict) throw new Error(`decision ${JSON.stringify(d)} gave ${got}`);
}

const pinned = P.ed.getPublicKey(stkSeed);
const checks = [
  P.verifyBootKeyBinding(binding, Buffer.from(signature, "hex"), pinned, serverDomain) === true,
  P.verifyBootKeyBinding(binding, Buffer.from(forged, "hex"), pinned, serverDomain) === false,
  P.verifyBootKeyBinding(binding, Buffer.from(signature, "hex"), Buffer.from(otherPub, "hex"), serverDomain) === false,
  P.verifyBootKeyBinding(binding, Buffer.from(signature, "hex"), pinned, "kitchen.plucky-avocet.flagship.services") === false,
];
if (checks.includes(false)) throw new Error("boot-key binding checks disagree with the reference");

const vectors = {
  about:
    "A device pins each server's box key (STK) the first time it learns it and refuses to seal to any other. A boot-only key is accepted only through a binding the PINNED STK signs. Seeds are 32 repeated bytes; Ed25519 signatures are deterministic.",
  serverDomain,
  stkSeedHex: hex(stkSeed),
  stkPubHex: stkPub,
  otherSeedHex: hex(otherSeed),
  otherPubHex: otherPub,
  decisions,
  bootKeyBinding: {
    binding,
    canonical,
    signatureHex: signature,
    signedByOtherKeyHex: forged,
    expect: {
      signatureUnderPinnedStk: true,
      signedByOtherKeyUnderPinnedStk: false,
      signatureUnderOtherKey: false,
      otherServerDomain: "kitchen.plucky-avocet.flagship.services",
      signatureForOtherServer: false,
    },
  },
};

const json = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let disk = "";
  try { disk = readFileSync(out, "utf8"); } catch { /* missing */ }
  if (disk !== json) { console.error(`${out} is stale; rerun without --check`); process.exit(1); }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
