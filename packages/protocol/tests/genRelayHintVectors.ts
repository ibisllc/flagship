// Builds test-vectors/relay-hint/vectors.json (docs/relay-hints.md).
// Regenerate with:
//   npx tsx packages/protocol/tests/genRelayHintVectors.ts
// Every input is fixed and Ed25519 is deterministic, so the output is
// byte-stable; relayHint.test.ts fails when the file drifts. Swift and Kotlin read the same file.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import {
  acceptRelayHint,
  canonicalRelayHint,
  parseRelayHint,
  relayHintAddresses,
  relayHintProblem,
  signRelayHint,
  verifyRelayHint,
  type RelayHint,
  type RelayHintBody,
  type RelayHintStore,
} from "../src/relayHint.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const DAY = 24 * 3600_000;

export const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/relay-hint/vectors.json");
export const T0 = 1792000000000;

const authoritySeed = fill(0x77);
const otherSeed = fill(0x78);
const authority = { publicKey: ed.getPublicKey(authoritySeed), privateKey: authoritySeed };
const other = { publicKey: ed.getPublicKey(otherSeed), privateKey: otherSeed };
const authorityPub = bytesToHex(authority.publicKey);
const otherPub = bytesToHex(other.publicKey);

const V4 = "149.248.216.86";
const V6 = "2a09:8280:1::110:d2b6:0";
const V4B = "203.0.113.7";

const base = (over: Partial<RelayHintBody>): RelayHintBody => ({
  seq: 1,
  validFrom: T0,
  validUntil: T0 + 90 * DAY,
  addresses: [V4, V6],
  ...over,
});

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function buildRelayHintVectors() {
  const first = signRelayHint(base({}), authority);
  const second = signRelayHint(base({ seq: 2, addresses: [V4B, V4, V6] }), authority);
  const positive = [
    { name: "first", hint: first },
    { name: "second-changes-the-list", hint: second },
  ].map((p) => ({ ...p, canonical: text(canonicalRelayHint(p.hint, p.hint.signedBy)) }));

  const wrongSigner = signRelayHint(base({}), other);
  const tamperedAddress = { ...copy(first), addresses: [V4B, V6] };
  const tamperedSeq = { ...copy(first), seq: 9 };
  const reject = [
    { name: "signed-by-someone-else", hint: wrongSigner, expect: "unauthorized-signer" },
    { name: "address-changed-after-signing", hint: tamperedAddress, expect: "signature-invalid" },
    { name: "seq-changed-after-signing", hint: tamperedSeq, expect: "signature-invalid" },
  ];

  const unsignable = [
    { name: "seq-zero", body: base({ seq: 0 }) },
    { name: "window-reversed", body: base({ validUntil: T0 }) },
    { name: "window-over-180-days", body: base({ validUntil: T0 + 181 * DAY }) },
    { name: "no-addresses", body: base({ addresses: [] }) },
    { name: "nine-addresses", body: base({ addresses: Array.from({ length: 9 }, (_, i) => `203.0.113.${i + 1}`) }) },
    { name: "duplicate-address", body: base({ addresses: [V4, V4] }) },
    { name: "hostname-not-an-address", body: base({ addresses: ["relay.example.com"] }) },
    { name: "ipv4-leading-zero", body: base({ addresses: ["149.248.216.086"] }) },
    { name: "ipv4-octet-over-255", body: base({ addresses: ["149.248.216.256"] }) },
    { name: "private-10", body: base({ addresses: ["10.0.0.7"] }) },
    { name: "private-192-168", body: base({ addresses: ["192.168.1.2"] }) },
    { name: "private-172-16", body: base({ addresses: ["172.16.0.1"] }) },
    { name: "loopback", body: base({ addresses: ["127.0.0.1"] }) },
    { name: "link-local", body: base({ addresses: ["169.254.1.1"] }) },
    { name: "cgnat", body: base({ addresses: ["100.64.0.1"] }) },
    { name: "ipv6-loopback", body: base({ addresses: ["::1"] }) },
    { name: "ipv6-unique-local", body: base({ addresses: ["fd00::1"] }) },
    { name: "ipv6-link-local", body: base({ addresses: ["fe80::1"] }) },
  ].map((u) => ({ ...u, code: relayHintProblem(u.body, authorityPub) ?? "NONE" }));

  const empty: RelayHintStore = { highestSeq: 0, hint: null };
  const afterFirst = acceptRelayHint(empty, first, [authorityPub]);
  const afterSecond = acceptRelayHint(afterFirst.store, second, [authorityPub]);
  const rollback = acceptRelayHint(afterSecond.store, first, [authorityPub]);
  const accept = [
    { name: "first-into-empty", from: empty, candidate: first, refused: afterFirst.refused, highestSeq: afterFirst.store.highestSeq },
    { name: "second-replaces-first", from: afterFirst.store, candidate: second, refused: afterSecond.refused, highestSeq: afterSecond.store.highestSeq },
    { name: "older-one-is-stale", from: afterSecond.store, candidate: first, refused: rollback.refused, highestSeq: rollback.store.highestSeq },
    { name: "another-signer-refused", from: afterFirst.store, candidate: wrongSigner, refused: "unauthorized-signer", highestSeq: 1 },
    { name: "null-changes-nothing", from: afterFirst.store, candidate: null, refused: null, highestSeq: 1 },
    { name: "garbage-is-malformed", from: afterFirst.store, candidate: { type: "RelayHint" }, refused: "malformed", highestSeq: 1 },
  ];

  const seed = [V4, V6];
  const stored = (h: RelayHint | null): RelayHintStore => ({ highestSeq: h?.seq ?? 0, hint: h });
  const addresses = [
    { name: "no-hint-uses-the-seed", store: stored(null), now: T0, authority: [authorityPub], seed },
    { name: "hint-first-then-seed", store: stored(second), now: T0 + DAY, authority: [authorityPub], seed },
    { name: "before-window-uses-the-seed", store: stored(second), now: T0 - 1, authority: [authorityPub], seed },
    { name: "after-window-uses-the-seed", store: stored(second), now: T0 + 90 * DAY, authority: [authorityPub], seed },
    { name: "authority-gone-uses-the-seed", store: stored(second), now: T0 + DAY, authority: [otherPub], seed },
  ].map((a) => ({ ...a, expect: relayHintAddresses(a.store, a.authority, a.seed, a.now) }));

  for (const p of positive) {
    if (!verifyRelayHint(parseRelayHint(p.hint)!, [authorityPub]).ok) throw new Error(`positive ${p.name} does not verify`);
  }

  return {
    note: "Golden vectors for RelayHint (docs/relay-hints.md). Ed25519 is deterministic: regenerate with `npx tsx packages/protocol/tests/genRelayHintVectors.ts`.",
    keys: { authorityPubHex: authorityPub, otherPubHex: otherPub },
    t0: T0,
    positive,
    reject,
    unsignable,
    accept,
    addresses,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, JSON.stringify(buildRelayHintVectors(), null, 2) + "\n");
  console.log(`wrote ${VECTORS_PATH}`);
}
