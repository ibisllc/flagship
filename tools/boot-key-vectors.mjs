// Writes packages/protocol/test-vectors/boot-key/vectors.json: the boot key
// binding (flagship/boot-key-binding/v1, STK-signed) and the box-side check of
// an auto-unlock lease before it is opened (owner signature, server, recipient,
// expiry). Read by the TS protocol and boot-core tests, the webapp, the Go
// helper (tools/unseal-crosscheck), the Rust flagship-boot crate, iOS and
// Android.
//
// Run: node --import tsx tools/boot-key-vectors.mjs
//
// Seeds are 32 repeated bytes: STK 0x0b, boot key 0x1b, owner IRK 0x07, another
// box's STK 0x0c. Lease seals use a fixed ephemeral key and nonce; each positive
// lease is opened with the real protocol opener before it is written.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "../packages/protocol/src/edSync.ts";
import { FLAGSHIP_SEAL_TAG, openSealedFromEd25519Recipient } from "../packages/protocol/src/encryption.ts";
import { signAutoUnlockLeaseV2, verifyAutoUnlockLeaseV2 } from "../packages/protocol/src/phoneEndpoint.ts";
import {
  canonicalBootKeyBinding,
  signBootKeyBinding,
  verifiedBootKey,
} from "../packages/protocol/src/bootKey.ts";

const OUT = new URL("../packages/protocol/test-vectors/boot-key/vectors.json", import.meta.url);
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, len = 32) => new Uint8Array(len).fill(n);

const domain = "home.alice.flagship.services";
const stkSeed = fill(0x0b);
const bootSeed = fill(0x1b);
const ownerSeed = fill(0x07);
const otherStkSeed = fill(0x0c);
const stkPub = ed.getPublicKey(stkSeed);
const bootPub = ed.getPublicKey(bootSeed);
const ownerPub = ed.getPublicKey(ownerSeed);
const otherStkPub = ed.getPublicKey(otherStkSeed);
const issuedAt = 1760000000000;

function wire(b, sig) {
  return {
    binding: { serverDomain: b.serverDomain, stkPub: hex(b.stkPub), bootKeyPub: hex(b.bootKeyPub), issuedAt: b.issuedAt },
    signature: hex(sig),
  };
}

const good = { serverDomain: domain, stkPub, bootKeyPub: bootPub, issuedAt };
const goodSig = signBootKeyBinding(good, { publicKey: stkPub, privateKey: stkSeed });
const goodWire = wire(good, goodSig);

const bindingCases = [
  { name: "valid", wire: goodWire, expect: { serverDomain: domain, stkPubHex: hex(stkPub) }, bootKeyPubHex: hex(bootPub) },
  {
    name: "upper-case hex and domain still bind",
    wire: { binding: { ...goodWire.binding, stkPub: hex(stkPub).toUpperCase(), bootKeyPub: hex(bootPub).toUpperCase() }, signature: goodWire.signature.toUpperCase() },
    expect: { serverDomain: domain.toUpperCase(), stkPubHex: hex(stkPub) },
    bootKeyPubHex: hex(bootPub),
  },
  { name: "another server's STK", wire: goodWire, expect: { serverDomain: domain, stkPubHex: hex(otherStkPub) }, bootKeyPubHex: null },
  { name: "another server", wire: goodWire, expect: { serverDomain: "home.bob.flagship.services", stkPubHex: hex(stkPub) }, bootKeyPubHex: null },
  {
    name: "boot key swapped after signing",
    wire: { ...goodWire, binding: { ...goodWire.binding, bootKeyPub: hex(otherStkPub) } },
    expect: { serverDomain: domain, stkPubHex: hex(stkPub) },
    bootKeyPubHex: null,
  },
  {
    name: "issuedAt changed after signing",
    wire: { ...goodWire, binding: { ...goodWire.binding, issuedAt: issuedAt + 1 } },
    expect: { serverDomain: domain, stkPubHex: hex(stkPub) },
    bootKeyPubHex: null,
  },
  {
    name: "signed by the boot key itself",
    wire: wire(good, signBootKeyBinding(good, { publicKey: bootPub, privateKey: bootSeed })),
    expect: { serverDomain: domain, stkPubHex: hex(stkPub) },
    bootKeyPubHex: null,
  },
  (() => {
    const same = { ...good, bootKeyPub: stkPub };
    return {
      name: "boot key equal to the STK",
      wire: wire(same, signBootKeyBinding(same, { publicKey: stkPub, privateKey: stkSeed })),
      expect: { serverDomain: domain, stkPubHex: hex(stkPub) },
      bootKeyPubHex: null,
    };
  })(),
  { name: "short signature", wire: { ...goodWire, signature: goodWire.signature.slice(0, 126) }, expect: { serverDomain: domain, stkPubHex: hex(stkPub) }, bootKeyPubHex: null },
];

for (const c of bindingCases) {
  const got = verifiedBootKey(c.wire, c.expect);
  if (got !== c.bootKeyPubHex) throw new Error(`binding case "${c.name}": protocol says ${got}`);
}

function seal(plaintext, recipientEdPub, ephPriv, nonce) {
  const recipX = ed25519.utils.toMontgomery(recipientEdPub);
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipX);
  const key = hkdf(sha256, shared, ephPub, new TextEncoder().encode(FLAGSHIP_SEAL_TAG), 32);
  const ct = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(44 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return out;
}

const luksKey = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
const now = issuedAt + 60_000;

function lease({ recipient = bootPub, signer = ownerSeed, serverDomain = domain, expiresAt = issuedAt + 7 * 86_400_000, maxUses, mutate } = {}) {
  const sealed = seal(luksKey, recipient, fill(0x31), fill(0x32, 12));
  const l = { serverDomain, stkPub: recipient, leaseId: "00112233445566778899aabbccddeeff", sealedKey: sealed, issuedAt, expiresAt };
  if (maxUses !== undefined) l.maxUses = maxUses;
  const sig = signAutoUnlockLeaseV2(l, { publicKey: ed.getPublicKey(signer), privateKey: signer });
  const body = {
    serverDomain: l.serverDomain,
    leaseId: l.leaseId,
    stkPub: hex(l.stkPub),
    sealedKey: hex(l.sealedKey),
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    maxUses: maxUses ?? null,
    usesConsumed: 0,
    signature: hex(sig),
  };
  return mutate ? mutate(body) : body;
}

const leaseCases = [
  { name: "valid", lease: lease(), ok: true },
  { name: "valid with maxUses", lease: lease({ maxUses: 3 }), ok: true },
  { name: "signed by a key that is not the owner's", lease: lease({ signer: otherStkSeed }), ok: false, error: "lease signature does not verify under the owner key" },
  { name: "for another server", lease: lease({ serverDomain: "home.bob.flagship.services" }), ok: false, error: "lease is for another server" },
  { name: "sealed to another key", lease: lease({ recipient: stkPub }), ok: false, error: "lease is not sealed to this box's boot key" },
  { name: "expired", lease: lease({ expiresAt: now - 1 }), ok: false, error: "lease has expired" },
  {
    name: "expiry pushed out after signing",
    lease: lease({ mutate: (b) => ({ ...b, expiresAt: b.expiresAt + 86_400_000 }) }),
    ok: false,
    error: "lease signature does not verify under the owner key",
  },
  {
    name: "maxUses removed after signing",
    lease: lease({ maxUses: 1, mutate: (b) => ({ ...b, maxUses: null }) }),
    ok: false,
    error: "lease signature does not verify under the owner key",
  },
  {
    name: "sealed key swapped after signing",
    lease: lease({ mutate: (b) => ({ ...b, sealedKey: b.sealedKey.slice(0, -2) + (b.sealedKey.endsWith("00") ? "01" : "00") }) }),
    ok: false,
    error: "lease signature does not verify under the owner key",
  },
  { name: "missing signature", lease: lease({ mutate: (b) => ({ ...b, signature: "" }) }), ok: false, error: "lease is malformed" },
];

for (const c of leaseCases) {
  if (!c.ok) continue;
  const b = c.lease;
  const l = {
    serverDomain: b.serverDomain,
    stkPub: Buffer.from(b.stkPub, "hex"),
    leaseId: b.leaseId,
    sealedKey: Buffer.from(b.sealedKey, "hex"),
    issuedAt: b.issuedAt,
    expiresAt: b.expiresAt,
    ...(b.maxUses !== null ? { maxUses: b.maxUses } : {}),
  };
  if (!verifyAutoUnlockLeaseV2(l, Buffer.from(b.signature, "hex"), ownerPub)) throw new Error(`lease case "${c.name}" does not verify`);
  const opened = openSealedFromEd25519Recipient(l.sealedKey, bootSeed);
  if (hex(opened) !== hex(luksKey)) throw new Error(`lease case "${c.name}" does not open`);
}

const vectors = {
  about:
    "The boot key binding (flagship/boot-key-binding/v1, signed by the STK) and the checks a box makes on an auto-unlock lease before opening it. Seeds are 32 repeated bytes: STK 0x0b, boot key 0x1b, owner IRK 0x07, another box's STK 0x0c. Regenerate with node --import tsx tools/boot-key-vectors.mjs.",
  serverDomain: domain,
  stkSeedHex: hex(stkSeed),
  stkPubHex: hex(stkPub),
  bootKeySeedHex: hex(bootSeed),
  bootKeyPubHex: hex(bootPub),
  ownerSeedHex: hex(ownerSeed),
  ownerPubHex: hex(ownerPub),
  otherStkPubHex: hex(otherStkPub),
  binding: {
    canonical: new TextDecoder().decode(canonicalBootKeyBinding(good)),
    wire: goodWire,
    cases: bindingCases,
  },
  lease: {
    about:
      "GET /api/boot/lease bodies. The box checks: serverDomain is its own, stkPub is its boot key, the signature verifies under ownerPubHex over flagship/auto-unlock-lease/v2 (maxUses null encodes as -1), and expiresAt > now. Only then does it open sealedKey with the boot key.",
    now,
    luksKeyHex: hex(luksKey),
    cases: leaseCases,
  },
};

mkdirSync(dirname(OUT.pathname), { recursive: true });
writeFileSync(OUT, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${OUT.pathname}: ${bindingCases.length} binding cases, ${leaseCases.length} lease cases`);
