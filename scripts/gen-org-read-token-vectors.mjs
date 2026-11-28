#!/usr/bin/env node
// Writes packages/protocol/test-vectors/org-read-token/vectors.json from the TS reference
// (docs/account-read-token.md "Org routes"). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-org-read-token-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/org-read-token/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const text = (b) => new TextDecoder().decode(b);
const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const umk = new Uint8Array(32).fill(0x2a);
const orgId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const seatId = "61616161616161616161616161616161";
const member = P.deriveOrgSeatMemberSeeds(umk, orgId);
const memberPub = P.ed.getPublicKey(member.edSeed);
const stkSeed = new Uint8Array(32).fill(0x5b);
const stkPub = P.ed.getPublicKey(stkSeed);
const t0 = 1_760_000_000_000;

function vector(subject, seed, pub, nonceHex) {
  const request = { orgId, subject, pubHex: hex(pub), issuedAt: t0, nonceHex };
  const canonical = text(P.canonicalOrgReadTokenRequest(request));
  const signatureHex = P.signOrgReadTokenRequest(request, (m) => P.ed.sign(m, seed));
  if (!P.verifyOrgReadTokenRequest(request, signatureHex, pub)) throw new Error(`${subject} doesn't verify`);
  return { path: P.orgReadTokenPath(orgId), request, canonical, signatureHex, reject: { signatureHex: flip(signatureHex) } };
}

const vectors = {
  about: "Org read tokens (docs/account-read-token.md \"Org routes\"). Every client platform must reproduce `seat`: derive the seat member key from `keys.umkSeedHex` and `keys.orgId` (deriveOrgSeatMemberSeeds, its Ed25519 half), build `canonical` from `request` byte for byte, and reproduce the Ed25519 signature; `box` is the server's (STK). The body POSTed to `path` is `{request, signature}`. Every `reject` signature must fail to verify.",
  keys: {
    umkSeedHex: hex(umk),
    orgId,
    seatId,
    memberEdSeedHex: hex(member.edSeed),
    memberPubHex: hex(memberPub),
    stkSeedHex: hex(stkSeed),
    stkPubHex: hex(stkPub),
  },
  seat: vector(P.orgSeatReadSubject(seatId), member.edSeed, memberPub, "00112233445566778899aabbccddeeff"),
  box: vector(P.orgBoxReadSubject("home.acme.flagship.services"), stkSeed, stkPub, "fedcba98765432100123456789abcdef"),
};
const json = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== json) {
    console.error(`${out} is stale`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
