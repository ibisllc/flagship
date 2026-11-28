#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for strict Ed25519 verification (edSync: S < L, canonical R and A, A not of small order, the
 * cofactorless equation [S]B = R + [k]A). `mixedOrderR` is a signature a ZIP-215 (cofactored) verifier accepts and the
 * strict rule refuses: R = rB + T with T of order 8 and S = r + k·a, so [8]SB = [8]R + [8]kA but SB != R + kA. The
 * honest signature passes both.
 *
 * Run:          npx tsx tools/ed25519-strict-vectors.ts
 * CI freshness: npx tsx tools/ed25519-strict-vectors.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as noble from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { ed } from "../packages/protocol/src/edSync.js";

noble.etc.sha512Sync = (...m: Uint8Array[]) => sha512(noble.etc.concatBytes(...m));

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/ed25519-strict/vectors.json");
const LOW = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/ed25519-low-order/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const L = noble.CURVE.n;
const le = (b: Uint8Array): bigint => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};
const leBytes = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};

const seed = new Uint8Array(32).fill(0x42);
const { scalar: a, point: A } = noble.utils.getExtendedPublicKey(seed);
const pub = A.toRawBytes();
const msg = new TextEncoder().encode("flagship/ed25519-strict/v1|vector");

const low = JSON.parse(readFileSync(LOW, "utf8")) as { rejectPublicKeysHex: string[] };
const T = low.rejectPublicKeysHex
  .map((h) => {
    try {
      return noble.Point.fromHex(h, false);
    } catch {
      return null;
    }
  })
  .find((p) => p !== null && !p.multiply(4n, false).equals(noble.Point.ZERO));
if (!T) throw new Error("no order-8 point in the low-order vectors");

const r = le(sha512(new TextEncoder().encode("ed25519-strict-vector-nonce"))) % L;
const R = noble.Point.BASE.multiply(r).add(T);
const rBytes = R.toRawBytes();
const k = le(sha512(noble.etc.concatBytes(rBytes, pub, msg))) % L;
const S = (r + k * a) % L;
const mixed = noble.etc.concatBytes(rBytes, leBytes(S));
const honest = noble.sign(msg, seed);

const zip215 = (s: Uint8Array) => noble.verify(s, msg, pub, { zip215: true });
if (!zip215(mixed) || !zip215(honest)) throw new Error("ZIP-215 must accept both");
if (ed.verify(mixed, msg, pub)) throw new Error("strict verify must refuse the mixed-order R");
if (!ed.verify(honest, msg, pub)) throw new Error("strict verify must accept the honest signature");

const out = JSON.stringify(
  {
    description:
      "Strict Ed25519 verification (S < L, canonical R and A, A not of small order, cofactorless [S]B = R + [k]A). honestSignatureHex verifies under publicKeyHex for messageHex in every verifier. mixedOrderRSignatureHex is valid under ZIP-215's cofactored check (R = rB + T, T of order 8, S = r + k·a) and must be refused by a strict verifier.",
    publicKeyHex: hex(pub),
    messageHex: hex(msg),
    honestSignatureHex: hex(honest),
    mixedOrderRSignatureHex: hex(mixed),
    torsionPointHex: hex(T.toRawBytes()),
  },
  null,
  2,
) + "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== out) {
    console.error("ed25519-strict vectors are stale: run npx tsx tools/ed25519-strict-vectors.ts");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, out);
}
