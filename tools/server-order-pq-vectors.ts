#!/usr/bin/env -S npx tsx
/**
 * Server-order vectors with the per-server PQ key ids (packages/protocol/src/serverOrder.ts
 * `pqKeyIds`, pq-suites.md §16). TS generates; TS, Swift and Kotlin check them.
 *
 * Run: npx tsx tools/server-order-pq-vectors.ts   (--check for CI freshness)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalServerOrder, deriveIRK, signServerOrder, type ServerOrder } from "../packages/protocol/src/index.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/server-order/pq-vectors.json");
const base = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/server-order/vectors.json"), "utf8"));
const irk = deriveIRK({ seed: Uint8Array.from(Buffer.from(base.keys.umkSeedHex, "hex")) });
const order: ServerOrder = { ...base.order.fields, pqKeyIds: ["11".repeat(32), "-", "22".repeat(32)] };
const refuse = [
  { why: "one key id fewer than servers", fields: { ...order, pqKeyIds: ["11".repeat(32), "-"] } },
  { why: "a key id that is not 32-byte hex", fields: { ...order, pqKeyIds: ["11".repeat(31), "-", "-"] } },
  { why: "an uppercase key id", fields: { ...order, pqKeyIds: ["AA".repeat(32), "-", "-"] } },
  { why: "an empty key id", fields: { ...order, pqKeyIds: ["", "-", "-"] } },
];
for (const r of refuse) {
  let threw = false;
  try {
    canonicalServerOrder(r.fields);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`refuse case canonicalized: ${r.why}`);
}
const doc = {
  about:
    "The server order with `pqKeyIds` (one hybrid key id per server, `-` for none): the canonical bytes are the v1 string plus `|pq=<ids comma-joined>`. Every platform must build `order.canonical` from `order.fields` byte for byte and reproduce `order.signatureHex` with the IRK of server-order/vectors.json `keys`; every `refuse` case must be refused before signing. Without `pqKeyIds` the v1 vectors apply unchanged.",
  order: { fields: order, canonical: new TextDecoder().decode(canonicalServerOrder(order)), signatureHex: signServerOrder(order, irk) },
  refuse,
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale`);
    process.exit(1);
  }
} else writeFileSync(OUT, text);
