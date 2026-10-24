#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for boot unlock v2 (packages/protocol/src/bootUnlockV2.ts, pq-suites.md §19).
 * The TypeScript port GENERATES them; TS, Rust (flagship-boot), Go (flagship-unseal), Swift and
 * Kotlin check them. Every seal and signature is deterministic (fixed seeds, fixed encapsulation
 * randomness, ML-DSA rnd = 0), so the box ports reproduce the request signature byte for byte.
 *
 * Run:          npx tsx tools/boot-unlock-v2-vectors.ts
 * CI freshness: npx tsx tools/boot-unlock-v2-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BootUnlockV2Error,
  boxAcceptsVersion,
  buildBootReplyV2,
  canonicalBootKeyBindingV3,
  canonicalSecretRequestV2,
  chooseLeaseVersion,
  chooseReplyVersion,
  kemKeyIdHex,
  hybridKeyIdHex,
  openBootReplyV2,
  openLeaseV3,
  parseUnlockPolicy,
  sealLeaseV3,
  signSecretRequestV2,
  verifyBootPq,
  verifySecretRequestV2,
  TAG_BOOT_KEY_BINDING_V3,
  type BootPqWire,
  type LeaseV3Fields,
} from "../packages/protocol/src/bootUnlockV2.js";
import { hybridSealKeygen, hybridSign, hybridSigKeygen } from "../packages/protocol/src/pqHybrid.js";
import { signPqKeyBinding, TAG_PQ_KEY_BINDING, verifyPqKeyBinding } from "../packages/protocol/src/pqTrust.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/boot-unlock-v2/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const fill = (v: number, n = 32): Uint8Array => new Uint8Array(n).fill(v);
const NOW = 1_790_000_000_000;
const DOMAIN = "kitchen.john.flagship.services";
const det = { deterministic: true };

const stk = hybridSigKeygen(fill(0x11), fill(0x12));
const boot = hybridSigKeygen(fill(0x21), fill(0x22));
const owner = hybridSigKeygen(fill(0x31), fill(0x32));
const stranger = hybridSigKeygen(fill(0x41), fill(0x42));
const leaseKem = hybridSealKeygen(fill(0x51));
const replyKem = hybridSealKeygen(fill(0x61));
const otherKem = hybridSealKeygen(fill(0x71));
const ed = (pk: Uint8Array) => hex(pk.subarray(0, 32));
const ml = (pk: Uint8Array) => hex(pk.subarray(32));
const bootPubHex = ed(boot.publicKey);
const diskKey = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

const stkBindingWire = signPqKeyBinding(
  { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: ed(stk.publicKey), mldsaPubHex: ml(stk.publicKey), issuedAt: NOW - 1000 },
  (m) => hybridSign(stk.secretKey, TAG_PQ_KEY_BINDING, m, det),
);
const stkBinding = verifyPqKeyBinding(stkBindingWire, { role: "box-stk", subjectId: DOMAIN, ed25519PubHex: ed(stk.publicKey), now: NOW });
const bootBinding = signPqKeyBinding(
  { role: "boot-key", subjectId: DOMAIN, ed25519PubHex: bootPubHex, mldsaPubHex: ml(boot.publicKey), issuedAt: NOW - 500 },
  (m) => hybridSign(boot.secretKey, TAG_PQ_KEY_BINDING, m, det),
);

function material(custody: "software" | "tpm", signer = stk.secretKey): BootPqWire {
  const s = { serverDomain: DOMAIN, bootPubHex, bootMldsaPubHex: ml(boot.publicKey), leaseKemPubHex: hex(leaseKem.publicKey), custody, issuedAt: NOW - 400 };
  return { v: 1, ...s, bootBinding, stkSignature: hex(hybridSign(signer, TAG_BOOT_KEY_BINDING_V3, canonicalBootKeyBindingV3(s), det)) };
}
const mat = material("tpm");
const verifiedMat = verifyBootPq(mat, { serverDomain: DOMAIN, bootPubHex, stkBinding, now: NOW });
const flip = (h: string, at = h.length - 2): string => h.slice(0, at) + (h.slice(at, at + 2) === "00" ? "01" : "00") + h.slice(at + 2);
const zeroMl = (h: string): string => h.slice(0, 128) + "0".repeat(h.length - 128);

const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof BootUnlockV2Error) return e.code;
    throw e;
  }
};

const materialCases = [
  { name: "tpm custody", wire: mat, bootPubHex, expect: "ok" },
  { name: "software custody", wire: material("software"), bootPubHex, expect: "ok" },
  { name: "another boot key", wire: mat, bootPubHex: "ab".repeat(32), expect: "material-boot-key" },
  { name: "custody relabelled", wire: { ...mat, custody: "software" }, bootPubHex, expect: "material-signature" },
  { name: "lease key swapped", wire: { ...mat, leaseKemPubHex: hex(otherKem.publicKey) }, bootPubHex, expect: "material-signature" },
  { name: "signed by another key", wire: material("tpm", stranger.secretKey), bootPubHex, expect: "material-signature" },
  { name: "STK signature ML-DSA half zeroed", wire: { ...mat, stkSignature: zeroMl(mat.stkSignature) }, bootPubHex, expect: "material-signature" },
  { name: "boot binding for another server", wire: { ...mat, bootBinding: { ...bootBinding, subjectId: "other.john.flagship.services" } }, bootPubHex, expect: "material-binding" },
  { name: "boot binding names another ML-DSA key", wire: { ...mat, bootMldsaPubHex: ml(stranger.publicKey) }, bootPubHex, expect: "material-binding" },
  { name: "extra field", wire: { ...mat, extra: 1 }, bootPubHex, expect: "v2-malformed" },
  { name: "unknown custody", wire: { ...mat, custody: "hsm" }, bootPubHex, expect: "v2-malformed" },
];
for (const c of materialCases) {
  const got = code(() => verifyBootPq(c.wire, { serverDomain: DOMAIN, bootPubHex: c.bootPubHex, stkBinding, now: NOW }));
  if (got !== c.expect) throw new Error(`material ${c.name}: ${got}`);
}

const nonceHex = "5a".repeat(32);
const req = { serverDomain: DOMAIN, bootPubHex, purpose: "unlock-key" as const, nonceHex, replyKemPubHex: hex(replyKem.publicKey), issuedAt: NOW };
const reqPq = signSecretRequestV2(req, boot.secretKey, det);
const v1Req = { serverDomain: DOMAIN, bootPubHex, purpose: "unlock-key", nonceHex, issuedAt: NOW };
const requestCases = [
  { name: "valid", v1: v1Req, pq: reqPq, expect: "ok" },
  { name: "reply key swapped", v1: v1Req, pq: { ...reqPq, replyKemPubHex: hex(otherKem.publicKey) }, expect: "request-signature" },
  { name: "another nonce", v1: { ...v1Req, nonceHex: "5b".repeat(32) }, pq: reqPq, expect: "request-signature" },
  { name: "ML-DSA half zeroed", v1: v1Req, pq: { ...reqPq, signature: zeroMl(reqPq.signature) }, expect: "request-signature" },
  { name: "signed by the STK, not the boot key", v1: v1Req, pq: signSecretRequestV2(req, stk.secretKey, det), expect: "request-signature" },
  { name: "for another server", v1: { ...v1Req, serverDomain: "other.john.flagship.services" }, pq: reqPq, expect: "other-server" },
  { name: "entitlement purpose", v1: { ...v1Req, purpose: "entitlement" }, pq: reqPq, expect: "v2-malformed" },
  { name: "classical request only (no pq)", v1: v1Req, pq: null, expect: "v2-malformed" },
];
for (const c of requestCases) {
  const got = code(() => verifySecretRequestV2(c.v1, c.pq, verifiedMat));
  if (got !== c.expect) throw new Error(`request ${c.name}: ${got}`);
}

const ownerSign = (sk: Uint8Array) => (purpose: string, payload: Uint8Array) => hybridSign(sk, purpose, payload, det);
const ctx = { serverDomain: DOMAIN, bootPubHex, nonceHex, replyKemPubHex: hex(replyKem.publicKey) };
const replyRand = fill(0x81, 64);
const reply = buildBootReplyV2({ ctx, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(owner.secretKey), issuedAt: NOW + 10, randomness: replyRand });
const replyByStranger = buildBootReplyV2({ ctx, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(stranger.secretKey), issuedAt: NOW + 10, randomness: replyRand });
const replyZeroMl = buildBootReplyV2({
  ctx,
  diskKey,
  ownerHybridPublicKey: owner.publicKey,
  sign: (p, m) => unhex(zeroMl(hex(hybridSign(owner.secretKey, p, m, det)))),
  issuedAt: NOW + 10,
  randomness: replyRand,
});
const replyOtherNonce = buildBootReplyV2({ ctx: { ...ctx, nonceHex: "5b".repeat(32) }, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(owner.secretKey), issuedAt: NOW + 10, randomness: replyRand });
const replyToOther = buildBootReplyV2({ ctx: { ...ctx, replyKemPubHex: hex(otherKem.publicKey) }, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(owner.secretKey), issuedAt: NOW + 10, randomness: replyRand });
// A v1 seal starts with an X25519 point; the policy refuses it before any opener runs.
const v1Reply = fill(0x09, 32 + 12 + 64 + 16);
const replyCases = [
  { name: "valid", policy: "strict", sealed: hex(reply), nonceHex, expect: "ok" },
  { name: "valid under compat", policy: "compat", sealed: hex(reply), nonceHex, expect: "ok" },
  { name: "signed by someone else", policy: "strict", sealed: hex(replyByStranger), nonceHex, expect: "owner-signature" },
  { name: "owner signature ML-DSA half zeroed", policy: "strict", sealed: hex(replyZeroMl), nonceHex, expect: "owner-signature" },
  { name: "for another request (nonce)", policy: "strict", sealed: hex(replyOtherNonce), nonceHex, expect: "decrypt-failed" },
  { name: "sealed to another reply key", policy: "strict", sealed: hex(replyToOther), nonceHex, expect: "recipient-mismatch" },
  { name: "tampered ciphertext", policy: "strict", sealed: flip(hex(reply)), nonceHex, expect: "decrypt-failed" },
  { name: "classical v1 reply under strict", policy: "strict", sealed: hex(v1Reply), nonceHex, expect: "strict-refuses-v1" },
  { name: "classical v1 reply under compat", policy: "compat", sealed: hex(v1Reply), nonceHex, expect: "accept-v1" },
];
const v1OrV2 = (sealed: Uint8Array) => (sealed[0] === 20 && Buffer.from(sealed.subarray(1, 21)).toString() === "flagship/envelope/v2" ? 2 : 1);
for (const c of replyCases) {
  const sealed = unhex(c.sealed);
  const got = code(() => {
    const v = v1OrV2(sealed);
    boxAcceptsVersion(c.policy as "strict" | "compat", v);
    if (v === 1) throw Object.assign(new BootUnlockV2Error("v2-malformed"), { code: "accept-v1" });
    const k = openBootReplyV2({ sealed, ctx: { serverDomain: DOMAIN, bootPubHex, nonceHex: c.nonceHex }, replyKemSecretKey: replyKem.secretKey, ownerHybridPublicKey: owner.publicKey });
    if (hex(k) !== hex(diskKey)) throw new Error("wrong key");
  });
  if (got !== c.expect) throw new Error(`reply ${c.name}: ${got}`);
}

const leaseFields: LeaseV3Fields = { serverDomain: DOMAIN, bootPubHex, leaseId: "0123456789abcdef0123456789abcdef", issuedAt: NOW, expiresAt: NOW + 86_400_000 };
const leaseRand = fill(0x91, 64);
const leaseSealed = sealLeaseV3({ lease: leaseFields, leaseKemPublicKey: leaseKem.publicKey, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(owner.secretKey), randomness: leaseRand });
const leaseByStranger = sealLeaseV3({ lease: leaseFields, leaseKemPublicKey: leaseKem.publicKey, diskKey, ownerHybridPublicKey: owner.publicKey, sign: ownerSign(stranger.secretKey), randomness: leaseRand });
const v1Lease = v1Reply;
const leaseCases = [
  { name: "valid", policy: "strict", lease: leaseFields, sealed: hex(leaseSealed), nowMs: NOW + 1000, expect: "ok" },
  { name: "expired by the floor-raised clock", policy: "strict", lease: leaseFields, sealed: hex(leaseSealed), nowMs: NOW + 86_400_000, expect: "lease-expired" },
  { name: "worker extended the expiry", policy: "strict", lease: { ...leaseFields, expiresAt: NOW + 2 * 86_400_000 }, sealed: hex(leaseSealed), nowMs: NOW + 1000, expect: "owner-signature" },
  { name: "worker lifted the use cap", policy: "strict", lease: { ...leaseFields, maxUses: 3 }, sealed: hex(leaseSealed), nowMs: NOW + 1000, expect: "owner-signature" },
  { name: "another lease id", policy: "strict", lease: { ...leaseFields, leaseId: "f".repeat(32) }, sealed: hex(leaseSealed), nowMs: NOW + 1000, expect: "decrypt-failed" },
  { name: "another server", policy: "strict", lease: { ...leaseFields, serverDomain: "other.john.flagship.services" }, sealed: hex(leaseSealed), nowMs: NOW + 1000, expect: "decrypt-failed" },
  { name: "signed by someone else", policy: "strict", lease: leaseFields, sealed: hex(leaseByStranger), nowMs: NOW + 1000, expect: "owner-signature" },
  { name: "classical v1 lease under strict", policy: "strict", lease: leaseFields, sealed: hex(v1Lease), nowMs: NOW + 1000, expect: "strict-refuses-v1" },
  { name: "classical v1 lease under compat", policy: "compat", lease: leaseFields, sealed: hex(v1Lease), nowMs: NOW + 1000, expect: "accept-v1" },
];
for (const c of leaseCases) {
  const sealed = unhex(c.sealed);
  const got = code(() => {
    const v = v1OrV2(sealed);
    boxAcceptsVersion(c.policy as "strict" | "compat", v);
    if (v === 1) throw Object.assign(new BootUnlockV2Error("v2-malformed"), { code: "accept-v1" });
    const k = openLeaseV3({ lease: c.lease, sealedKey: sealed, leaseKemSecretKey: leaseKem.secretKey, ownerHybridPublicKey: owner.publicKey, nowMs: c.nowMs });
    if (hex(k) !== hex(diskKey)) throw new Error("wrong key");
  });
  if (got !== c.expect) throw new Error(`lease ${c.name}: ${got}`);
}

const policyCases = [
  { text: null, hasV2Material: true, expect: "compat" },
  { text: "strict\n", hasV2Material: true, expect: "strict" },
  { text: "compat\n", hasV2Material: true, expect: "compat" },
  { text: "Strict", hasV2Material: true, expect: "strict" },
  { text: "", hasV2Material: true, expect: "strict" },
  { text: "garbage", hasV2Material: false, expect: "compat" },
];
for (const c of policyCases) if (parseUnlockPolicy(c.text, c.hasV2Material) !== c.expect) throw new Error(`policy ${JSON.stringify(c)}`);

const choiceCases = [
  { strict: true, material: true, requestHasPq: true, canSignHybrid: true, expect: "2" },
  { strict: false, material: true, requestHasPq: true, canSignHybrid: true, expect: "2" },
  { strict: false, material: true, requestHasPq: true, canSignHybrid: false, expect: "1" },
  { strict: false, material: false, requestHasPq: false, canSignHybrid: true, expect: "1" },
  { strict: true, material: false, requestHasPq: false, canSignHybrid: true, expect: "box-has-no-v2" },
  { strict: true, material: true, requestHasPq: false, canSignHybrid: true, expect: "box-has-no-v2" },
  { strict: true, material: true, requestHasPq: true, canSignHybrid: false, expect: "phone-cannot-sign-hybrid" },
];
for (const c of choiceCases) {
  let got: string;
  try {
    got = String(chooseReplyVersion(c));
  } catch (e) {
    got = (e as BootUnlockV2Error).code;
  }
  if (got !== c.expect) throw new Error(`choice ${JSON.stringify(c)}: ${got}`);
}
const leaseChoiceCases = [
  { strict: true, material: true, canSignHybrid: true, expect: "3" },
  { strict: false, material: false, canSignHybrid: true, expect: "2" },
  { strict: true, material: false, canSignHybrid: true, expect: "box-has-no-v2" },
  { strict: true, material: true, canSignHybrid: false, expect: "phone-cannot-sign-hybrid" },
];
for (const c of leaseChoiceCases) {
  let got: string;
  try {
    got = String(chooseLeaseVersion(c));
  } catch (e) {
    got = (e as BootUnlockV2Error).code;
  }
  if (got !== c.expect) throw new Error(`lease choice ${JSON.stringify(c)}: ${got}`);
}

const doc = {
  about:
    "Boot unlock v2 (packages/protocol/src/bootUnlockV2.ts, pq-suites.md §19). Seeds are fixed; seals use the listed encapsulation randomness and signatures ML-DSA rnd = 0, so ports reproduce sealed bytes and the request signature exactly. 'accept-v1' means the policy lets the classical v1 opener run.",
  now: NOW,
  serverDomain: DOMAIN,
  keys: {
    stk: { edSeed: hex(fill(0x11)), mldsaSeed: hex(fill(0x12)), publicKey: hex(stk.publicKey) },
    boot: { edSeed: hex(fill(0x21)), mldsaSeed: hex(fill(0x22)), publicKey: hex(boot.publicKey), pubHex: bootPubHex, hybridKeyId: hybridKeyIdHex(boot.publicKey) },
    owner: { edSeed: hex(fill(0x31)), mldsaSeed: hex(fill(0x32)), publicKey: hex(owner.publicKey) },
    stranger: { edSeed: hex(fill(0x41)), mldsaSeed: hex(fill(0x42)), publicKey: hex(stranger.publicKey) },
    leaseKem: { seed: hex(fill(0x51)), publicKey: hex(leaseKem.publicKey), keyId: kemKeyIdHex(leaseKem.publicKey) },
    replyKem: { seed: hex(fill(0x61)), publicKey: hex(replyKem.publicKey), keyId: kemKeyIdHex(replyKem.publicKey) },
    otherKem: { seed: hex(fill(0x71)), publicKey: hex(otherKem.publicKey) },
  },
  diskKey: hex(diskKey),
  stkBinding: stkBindingWire,
  material: { statement: Buffer.from(canonicalBootKeyBindingV3(mat)).toString(), wire: mat, cases: materialCases },
  request: { fields: req, canonical: Buffer.from(canonicalSecretRequestV2(req)).toString(), pq: reqPq, cases: requestCases },
  reply: { ctx, issuedAt: NOW + 10, randomness: hex(replyRand), sealed: hex(reply), cases: replyCases },
  lease: { fields: leaseFields, randomness: hex(leaseRand), sealedKey: hex(leaseSealed), cases: leaseCases },
  policy: policyCases,
  replyChoice: choiceCases,
  leaseChoice: leaseChoiceCases,
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/boot-unlock-v2-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote boot-unlock-v2 vectors to ${OUT}`);
}
