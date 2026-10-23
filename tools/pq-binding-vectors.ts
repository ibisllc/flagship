#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the architecture-v2 key bindings and the critical-signature gate
 * (docs/architecture-v2/pq-suites.md §9-§10). The TypeScript port (packages/protocol/src/pqTrust.ts)
 * GENERATES them; packages/protocol/tests/pqTrustVectors.test.ts,
 * rust/crates/flagship-crypto/tests/pq_trust_vectors.rs and apps/web/tests/webappPqBinding.test.ts
 * check them.
 *
 * Run:          npx tsx tools/pq-binding-vectors.ts
 * CI freshness: npx tsx tools/pq-binding-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hybridSigKeygen, hybridSign, hybridSigMessage } from "../packages/protocol/src/pqHybrid.js";
import { canonicalPqKeyBinding, messagePurpose, type PqKeyBindingStatement, type PqKeyBindingWire } from "../packages/protocol/src/pqTrust.js";
import { canonicalBootKeyBindingV2 } from "../packages/protocol/src/bootKey.js";
import { canonicalDaemonStatusReport } from "../packages/protocol/src/daemonStatus.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/pq-binding/vectors.json");

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const zero = (s: string, from: number, to: number): string => s.slice(0, from * 2) + "00".repeat(to - from) + s.slice(to * 2);

interface Signer {
  name: string;
  edSeed: Uint8Array;
  mldsaSeed: Uint8Array;
  ed25519PubHex: string;
  mldsaPubHex: string;
  secret: Uint8Array;
}

function signer(name: string, a: number, b: number): Signer {
  const edSeed = fill(32, a);
  const mldsaSeed = fill(32, b);
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, mldsaSeed);
  return { name, edSeed, mldsaSeed, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), secret: secretKey };
}

const A = signer("A", 0x11, 0x22);
const B = signer("B", 0x33, 0x44);
const C = signer("C", 0x55, 0x66);
const NOW = 1_790_000_000_000;
const ISSUED = NOW - 60_000;

const hsign = (s: Signer, msg: Uint8Array): string => hex(hybridSign(s.secret, messagePurpose(msg), msg, { deterministic: true }));
const edsign = (s: Signer, msg: Uint8Array): string => hex(ed25519.sign(msg, s.edSeed));

function bind(s: Signer, role: PqKeyBindingStatement["role"], subjectId: string, issuedAt = ISSUED): PqKeyBindingWire {
  const st: PqKeyBindingStatement = { role, subjectId, ed25519PubHex: s.ed25519PubHex, mldsaPubHex: s.mldsaPubHex, issuedAt };
  return { v: 1, ...st, signature: hsign(s, canonicalPqKeyBinding(st)) };
}

const exp = (w: { role: string; subjectId: string; ed25519PubHex: string }, extra: Record<string, unknown> = {}) => ({
  role: w.role,
  subjectId: w.subjectId,
  ed25519PubHex: w.ed25519PubHex,
  now: NOW,
  ...extra,
});

const SERVER = "home.alice.flagship.services";
const valid = [
  { name: "account-irk", wire: bind(A, "account-irk", "alice") },
  { name: "admin-root", wire: bind(B, "admin-root", "alice") },
  { name: "device", wire: bind(C, "device", "dev_7f3a9c") },
  { name: "box-stk", wire: bind(A, "box-stk", SERVER) },
  { name: "boot-key", wire: bind(B, "boot-key", SERVER) },
].map((v) => ({ ...v, statementHex: hex(canonicalPqKeyBinding(v.wire)), expect: exp(v.wire, { minIssuedAt: ISSUED }) }));

const stk = valid[3]!.wire;
const stmt = (w: PqKeyBindingStatement) => canonicalPqKeyBinding(w);
/** M' for a statement under `ed || ml`. */
const mprime = (w: PqKeyBindingStatement) => hybridSigMessage(Buffer.from(w.ed25519PubHex + w.mldsaPubHex, "hex"), "flagship/pq-key-binding/v1", stmt(w));

// A substituted ML-DSA key: the genuine Ed25519 half of A's binding next to C's ML-DSA signature
// over the new statement. And the reverse: C's Ed25519 next to A's genuine ML-DSA half.
const pqSub = { ...stk, mldsaPubHex: C.mldsaPubHex };
const pqSubSig = stk.signature.slice(0, 128) + hex(hybridSign(new Uint8Array([...A.edSeed, ...C.mldsaSeed]), "flagship/pq-key-binding/v1", stmt(pqSub), { deterministic: true })).slice(128);
const edSub = { ...stk, ed25519PubHex: C.ed25519PubHex };
const edSubSig = hex(ed25519.sign(mprime(edSub), C.edSeed)) + stk.signature.slice(128);

const invalid: Array<{ name: string; wire: unknown; expect: Record<string, unknown>; code: string }> = [
  { name: "pq-key-substituted", wire: { ...pqSub, signature: pqSubSig }, expect: exp(stk), code: "bad-signature" },
  { name: "ed-key-substituted", wire: { ...edSub, signature: edSubSig }, expect: exp(edSub), code: "bad-signature" },
  { name: "keys-swapped-between-fields", wire: { ...stk, ed25519PubHex: stk.mldsaPubHex, mldsaPubHex: stk.ed25519PubHex }, expect: exp(stk), code: "binding-malformed" },
  { name: "another-identity-pq-key", wire: { ...stk, mldsaPubHex: B.mldsaPubHex }, expect: exp(stk), code: "bad-signature" },
  { name: "pq-signature-missing", wire: { ...stk, signature: stk.signature.slice(0, 128) }, expect: exp(stk), code: "bad-signature" },
  { name: "ed-signature-missing", wire: { ...stk, signature: stk.signature.slice(128) }, expect: exp(stk), code: "bad-signature" },
  { name: "signature-empty", wire: { ...stk, signature: "" }, expect: exp(stk), code: "bad-signature" },
  { name: "ed-half-zeroed", wire: { ...stk, signature: zero(stk.signature, 0, 64) }, expect: exp(stk), code: "bad-signature" },
  { name: "pq-half-zeroed", wire: { ...stk, signature: zero(stk.signature, 64, 3373) }, expect: exp(stk), code: "bad-signature" },
  { name: "classical-only-signature", wire: { ...stk, signature: edsign(A, stmt(stk)) }, expect: exp(stk), code: "bad-signature" },
  { name: "wrong-role-expected", wire: stk, expect: exp(stk, { role: "admin-root" }), code: "binding-role" },
  { name: "role-relabelled", wire: { ...stk, role: "admin-root" }, expect: exp({ ...stk, role: "admin-root" }), code: "bad-signature" },
  { name: "unknown-role", wire: { ...stk, role: "owner" }, expect: exp(stk), code: "binding-role" },
  { name: "wrong-subject-expected", wire: stk, expect: exp(stk, { subjectId: "home2.alice.flagship.services" }), code: "binding-subject" },
  { name: "subject-relabelled", wire: { ...stk, subjectId: "home2.alice.flagship.services" }, expect: exp({ ...stk, subjectId: "home2.alice.flagship.services" }), code: "bad-signature" },
  { name: "subject-not-canonical", wire: { ...stk, subjectId: "Home.Alice.flagship.services" }, expect: exp(stk), code: "binding-subject" },
  { name: "subject-with-separator", wire: { ...stk, subjectId: "home|x" }, expect: exp(stk), code: "binding-subject" },
  { name: "not-the-trusted-ed25519-key", wire: stk, expect: exp(stk, { ed25519PubHex: B.ed25519PubHex }), code: "binding-key-mismatch" },
  { name: "pinned-pq-key-changed", wire: stk, expect: exp(stk, { mldsaPubHex: B.mldsaPubHex }), code: "binding-pq-key-changed" },
  { name: "stale", wire: stk, expect: exp(stk, { minIssuedAt: ISSUED + 1 }), code: "binding-stale" },
  { name: "dated-in-the-future", wire: stk, expect: exp(stk, { now: ISSUED - 300_001 }), code: "binding-future" },
  { name: "issued-at-relabelled", wire: { ...stk, issuedAt: ISSUED + 1 }, expect: exp(stk), code: "bad-signature" },
  { name: "extra-field", wire: { ...stk, suite: "ed25519/v1" }, expect: exp(stk), code: "binding-malformed" },
  { name: "missing-version", wire: { ...stk, v: undefined }, expect: exp(stk), code: "binding-malformed" },
  { name: "version-2", wire: { ...stk, v: 2 }, expect: exp(stk), code: "binding-malformed" },
  { name: "uppercase-hex", wire: { ...stk, ed25519PubHex: stk.ed25519PubHex.toUpperCase() }, expect: exp(stk), code: "binding-malformed" },
  { name: "short-pq-key", wire: { ...stk, mldsaPubHex: stk.mldsaPubHex.slice(2) }, expect: exp(stk), code: "binding-malformed" },
  { name: "negative-issued-at", wire: { ...stk, issuedAt: -1 }, expect: exp(stk), code: "binding-malformed" },
  { name: "fractional-issued-at", wire: { ...stk, issuedAt: 1.5 }, expect: exp(stk), code: "binding-malformed" },
  { name: "signature-not-hex", wire: { ...stk, signature: "zz" }, expect: exp(stk), code: "binding-malformed" },
  { name: "identity-ed25519-key", wire: { ...stk, ed25519PubHex: "01" + "00".repeat(31) }, expect: exp({ ...stk, ed25519PubHex: "01" + "00".repeat(31) }), code: "bad-public-key" },
].map((c) => ({ ...c, wire: JSON.parse(JSON.stringify(c.wire)) as unknown }));

// ── gate ──
const status = canonicalDaemonStatusReport({
  serverDomain: SERVER,
  certSha256: "ab".repeat(32),
  certValidUntil: 1_800_000_000_000,
  certIssuer: "R11",
  appsServed: ["notes", "chess"],
  nonce: "0f".repeat(16),
  issuedAt: NOW,
});
const PURPOSE = "flagship/daemon-status/v1";
const classical = edsign(A, status);
const hybrid = hsign(A, status);
const boot = { serverDomain: SERVER, bootPubHex: B.ed25519PubHex, issuedAt: ISSUED };
const bootV2 = canonicalBootKeyBindingV2(boot);
const tampered = Uint8Array.from(status);
tampered[tampered.length - 1] ^= 0x01;

const compat = { profile: "compatibility", rollout: "legacy" };
const strict = { profile: "strict", rollout: "enforced" };
type GateCase = {
  name: string;
  messageHex: string;
  expectedPurpose: string;
  envelope: { suite: string; signature: string };
  signerEd25519PubHex: string;
  binding: string | null;
  policy: { profile: string; rollout: string };
  expect: { ok: true; suite: string; strict: boolean } | { ok: false; code: string };
};
const g = (name: string, o: Partial<GateCase> & Pick<GateCase, "envelope" | "policy" | "expect">): GateCase => ({
  name,
  messageHex: hex(status),
  expectedPurpose: PURPOSE,
  signerEd25519PubHex: A.ed25519PubHex,
  binding: "box-stk",
  ...o,
});
const ED = (sig: string) => ({ suite: "ed25519/v1", signature: sig });
const HY = (sig: string) => ({ suite: "hybrid-ed25519-mldsa65/v1", signature: sig });
const ok = (suite: string, s: boolean) => ({ ok: true as const, suite, strict: s });
const no = (code: string) => ({ ok: false as const, code });

const gate: GateCase[] = [
  g("compat-classical", { envelope: ED(classical), policy: compat, expect: ok("ed25519/v1", false) }),
  g("compat-classical-no-binding", { envelope: ED(classical), binding: null, policy: compat, expect: ok("ed25519/v1", false) }),
  g("compat-hybrid", { envelope: HY(hybrid), policy: compat, expect: ok("hybrid-ed25519-mldsa65/v1", false) }),
  g("strict-hybrid", { envelope: HY(hybrid), policy: strict, expect: ok("hybrid-ed25519-mldsa65/v1", true) }),
  g("strict-retired-hybrid", { envelope: HY(hybrid), policy: { profile: "strict", rollout: "retired" }, expect: ok("hybrid-ed25519-mldsa65/v1", true) }),
  g("strict-prepared-is-not-in-force", { envelope: ED(classical), policy: { profile: "strict", rollout: "prepared" }, expect: ok("ed25519/v1", false) }),
  g("compat-after-enforced-is-not-in-force", { envelope: ED(classical), policy: { profile: "compatibility", rollout: "enforced" }, expect: ok("ed25519/v1", false) }),
  g("strict-suite-stripped", { envelope: ED(classical), policy: strict, expect: no("strict-requires-hybrid") }),
  g("strict-suite-stripped-no-binding", { envelope: ED(classical), binding: null, policy: strict, expect: no("strict-requires-hybrid") }),
  g("strict-hybrid-no-binding", { envelope: HY(hybrid), binding: null, policy: strict, expect: no("strict-requires-binding") }),
  g("compat-hybrid-no-binding", { envelope: HY(hybrid), binding: null, policy: compat, expect: no("no-binding") }),
  g("strict-ed-half-relabelled-classical", { envelope: ED(hybrid.slice(0, 128)), policy: strict, expect: no("strict-requires-hybrid") }),
  g("compat-ed-half-relabelled-classical", { envelope: ED(hybrid.slice(0, 128)), policy: compat, expect: no("bad-signature") }),
  g("hybrid-suite-classical-bytes", { envelope: HY(classical), policy: compat, expect: no("bad-signature") }),
  g("classical-suite-hybrid-bytes", { envelope: ED(hybrid), policy: compat, expect: no("bad-signature") }),
  g("hybrid-pq-half-zeroed", { envelope: HY(zero(hybrid, 64, 3373)), policy: strict, expect: no("bad-signature") }),
  g("hybrid-ed-half-zeroed", { envelope: HY(zero(hybrid, 0, 64)), policy: strict, expect: no("bad-signature") }),
  g("hybrid-tampered-message", { messageHex: hex(tampered), envelope: HY(hybrid), policy: strict, expect: no("bad-signature") }),
  g("classical-tampered-message", { messageHex: hex(tampered), envelope: ED(classical), policy: compat, expect: no("bad-signature") }),
  g("hybrid-by-another-signer", { envelope: HY(hsign(B, status)), policy: strict, expect: no("bad-signature") }),
  g("binding-of-another-signer", { envelope: HY(hybrid), binding: "boot-key", policy: strict, expect: no("binding-key-mismatch") }),
  g("purpose-mismatch", { expectedPurpose: "flagship/box-trust-status/v1", envelope: HY(hybrid), policy: strict, expect: no("purpose-mismatch") }),
  g("expected-purpose-not-v2", { expectedPurpose: "pb-put", envelope: HY(hybrid), policy: strict, expect: no("bad-purpose") }),
  g("unknown-suite", { envelope: { suite: "ed448/v1", signature: classical }, policy: compat, expect: no("unknown-suite") }),
  g("signature-not-hex", { envelope: HY("xy"), policy: compat, expect: no("bad-signature") }),
  g("signer-key-not-hex", { signerEd25519PubHex: "nothex", envelope: ED(classical), binding: null, policy: compat, expect: no("bad-public-key") }),
  g("boot-key-binding-v2", { messageHex: hex(bootV2), expectedPurpose: "flagship/boot-key-binding/v2", envelope: HY(hsign(A, bootV2)), policy: strict, expect: ok("hybrid-ed25519-mldsa65/v1", true) }),
];

const out = {
  about:
    "Architecture-v2 key bindings and the critical-signature gate (docs/architecture-v2/pq-suites.md §9-§10). DRAFT, pending Q01 external cryptographic review. Generated by tools/pq-binding-vectors.ts; TS (protocol + webapp) and Rust check every case. ML-DSA signatures are deterministic (rnd = 0^32). Gate cases name the binding they use by its `valid` entry name (null = none); policy is {profile, rollout}.",
  now: NOW,
  signers: [A, B, C].map((s) => ({ name: s.name, edSeedHex: hex(s.edSeed), mldsaSeedHex: hex(s.mldsaSeed), ed25519PubHex: s.ed25519PubHex, mldsaPubHex: s.mldsaPubHex })),
  bindings: { valid, invalid },
  gate,
};
const text = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/pq-binding-vectors.ts`);
    process.exit(1);
  }
  console.log("pq-binding vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
