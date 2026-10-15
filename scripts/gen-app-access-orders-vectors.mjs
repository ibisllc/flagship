#!/usr/bin/env node
// Writes packages/protocol/test-vectors/app-access-orders/vectors.json from
// the TS reference (docs/service-access-gating.md, "Account members, ranks and
// who may change them"). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-app-access-orders-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/app-access-orders/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const text = (b) => new TextDecoder().decode(b);

const signerSeed = new Uint8Array(32).fill(0x3c);
const signer = { privateKey: signerSeed, publicKey: P.ed.getPublicKey(signerSeed) };
const device = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a";
const aid = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4";
const share = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const invite = "ea4ab8be66710610842cf6ef0d7e56bd";
const ref = "harry--chess-club";

const rank = [
  { serviceRef: ref, target: `device:${device}`, rank: "master", issuedAt: 1760000000000 },
  { serviceRef: ref, target: `device:${device}`, rank: "member", issuedAt: 1760000000001 },
  { serviceRef: ref, target: `device:${device}`, rank: "refused", issuedAt: 1760000000002 },
  { serviceRef: ref, target: `share:${share}`, rank: "manager", issuedAt: 1760000000003 },
  { serviceRef: ref, target: `share:${share}`, rank: "refused", issuedAt: 1760000000004 },
  { serviceRef: ref, target: `invite:${invite}`, rank: "manager", issuedAt: 1760000000005 },
  { serviceRef: ref, target: `grant:${invite}/${aid}`, rank: "master", issuedAt: 1760000000006 },
  { serviceRef: "harry--weather", target: `aid:${aid}`, rank: "member", issuedAt: 1760000000007 },
].map((o) => ({
  ...o,
  canonical: text(P.appRankCanonicalBytes(o)),
  signature: hex(P.signAppRank(o, signer)),
}));

const rankInvalid = [
  { serviceRef: ref, target: `aid:${aid}`, rank: "owner", issuedAt: 1, why: "owner is not a rank" },
  { serviceRef: ref, target: `aid:${aid}`, rank: "refused", issuedAt: 1, why: "only a device or a co-manager can be refused" },
  { serviceRef: ref, target: `invite:${invite}`, rank: "refused", issuedAt: 1, why: "an invite can't be refused (withdraw it)" },
  { serviceRef: ref, target: `device:${device.toUpperCase()}`, rank: "member", issuedAt: 1, why: "device keys are lowercase hex" },
  { serviceRef: ref, target: `share:${share}00`, rank: "member", issuedAt: 1, why: "a share id is 32 hex" },
  { serviceRef: "Harry--Club", target: `device:${device}`, rank: "member", issuedAt: 1, why: "serviceRef is lowercase" },
  { serviceRef: "harry|club", target: `device:${device}`, rank: "member", issuedAt: 1, why: "no separator in serviceRef" },
  { serviceRef: ref, target: `device:${device}`, rank: "member", issuedAt: -1, why: "issuedAt is non-negative" },
];
for (const c of rankInvalid) {
  let threw = false;
  try {
    P.appRankCanonicalBytes(c);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`invalid rank case accepted: ${c.why}`);
}

const mode = [
  { serviceRef: ref, mode: "restricted", issuedAt: 1760000000100 },
  { serviceRef: ref, mode: "open", issuedAt: 1760000000101 },
].map((o) => ({ ...o, canonical: text(P.serviceAccessModeV2CanonicalBytes(o)), signature: hex(P.signServiceAccessModeV2(o, signer)) }));
const modeInvalid = [
  { serviceRef: ref, mode: "members-only", issuedAt: 1, why: "mode is open or restricted" },
  { serviceRef: "", mode: "open", issuedAt: 1, why: "empty serviceRef" },
];

const remove = [
  { serviceRef: ref, aid, issuedAt: 1760000000200 },
].map((o) => ({ ...o, canonical: text(P.serviceAllowRemoveV2CanonicalBytes(o)), signature: hex(P.signServiceAllowRemoveV2(o, signer)) }));
const removeInvalid = [
  { serviceRef: ref, aid: aid.slice(2), issuedAt: 1, why: "aid is 64 hex" },
  { serviceRef: ref, aid: aid.toUpperCase(), issuedAt: 1, why: "aid is lowercase" },
];

const doc = {
  about:
    "Admin-only access orders naming the app (docs/service-access-gating.md, Account members). flagship/app-rank/v1, flagship/service-access-mode/v2, flagship/service-allow-remove/v2. Signer: a raw Ed25519 seed (stands in for the admin root).",
  signerSeedHex: hex(signerSeed),
  signerPub: hex(signer.publicKey),
  rank: { cases: rank, invalid: rankInvalid },
  mode: { cases: mode, invalid: modeInvalid },
  remove: { cases: remove, invalid: removeInvalid },
};
const json = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const cur = readFileSync(out, "utf8");
  if (cur !== json) {
    console.error("app-access-orders vectors are stale");
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
