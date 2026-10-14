#!/usr/bin/env node
// Writes packages/protocol/test-vectors/server-order/vectors.json from the TS
// reference (docs/server-order.md). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-server-order-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/server-order/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);

const umk = { seed: fill(32, 0x2a) };
const irk = P.deriveIRK(umk);
const stk = (v) => hex(P.ed.getPublicKey(fill(32, v)));
const order = {
  user: "plucky-avocet",
  stks: [stk(0x31), stk(0x32), stk(0x33)],
  issuedAt: 1_760_000_000_000,
  nonce: hex(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)),
};
const signature = P.signServerOrder(order, irk);
const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const cgk = P.deriveCGK(umk.seed);
const announcement = {
  user: "plucky-avocet",
  name: stk(0x32),
  birthAuthHex: stk(0x32),
  birthDate: 1_750_000_000_000,
  orderDate: order.issuedAt,
  services: ["notes", "chess"],
  liveness: "live",
  issuedAt: 1_760_000_100_000,
};

const vectors = {
  about: "The owner's server order (docs/server-order.md). Every platform must derive `keys.irkPubHex` from `keys.umkSeedHex`, build `order.canonical` from `order.fields` byte for byte (stks in list order, comma-joined), and reproduce `order.signatureHex` with the IRK; `order.reject` must fail to verify; every `refuse` case must be refused before signing. `gossip` is TS-only (boxes).",
  keys: {
    umkSeedHex: hex(umk.seed),
    irkPubHex: hex(irk.publicKey),
    cgkHex: hex(cgk),
  },
  order: {
    fields: order,
    canonical: text(P.canonicalServerOrder(order)),
    signatureHex: signature,
    wire: { order, signature },
    reject: { signatureHex: flip(signature) },
  },
  refuse: [
    { why: "empty list", fields: { ...order, stks: [] } },
    { why: "a server listed twice", fields: { ...order, stks: [order.stks[0], order.stks[0]] } },
    { why: "uppercase stk", fields: { ...order, stks: [order.stks[0].toUpperCase()] } },
    { why: "short nonce", fields: { ...order, nonce: "ab" } },
  ],
  gossip: {
    fields: announcement,
    canonical: text(P.canonicalGossip(announcement)),
    macHex: P.macGossip(announcement, cgk),
  },
};

for (const r of vectors.refuse) {
  let threw = false;
  try { P.canonicalServerOrder(r.fields); } catch { threw = true; }
  if (!threw) throw new Error(`refuse case accepted: ${r.why}`);
}
if (!P.verifyServerOrder(order, signature, irk.publicKey)) throw new Error("order vector doesn't verify");

const json = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing */ }
  if (current !== json) {
    console.error(`${out} is stale; rerun scripts/gen-server-order-vectors.mjs`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
