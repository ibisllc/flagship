#!/usr/bin/env node
// Writes packages/protocol/test-vectors/debug-access/vectors.json from the TS
// reference (docs/recipe-delivery-and-remote-install.md "Debug access").
// Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-debug-access-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/debug-access/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);
const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const adminSeed = fill(32, 0x5a);
const admin = { privateKey: adminSeed, publicKey: P.ed.getPublicKey(adminSeed) };
const irk = P.deriveIRK({ seed: fill(32, 0x2a) });

function sshString(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
const enc = (s) => new TextEncoder().encode(s);
const pub = P.ed.getPublicKey(fill(32, 0x11));
const body = Buffer.from(new Uint8Array([...sshString(enc("ssh-ed25519")), ...sshString(pub)])).toString("base64");
const key = `ssh-ed25519 ${body}`;
const wrongTypeBody = Buffer.from(new Uint8Array([...sshString(enc("ssh-rsa")), ...sshString(pub)])).toString("base64");

const grant = {
  serverDomain: "home.plucky-avocet.flagship.services",
  sshPublicKey: key,
  issuedAt: 1_760_000_000_000,
  expiresAt: 1_760_000_000_000 + P.DEBUG_ACCESS_DEFAULT_MS,
};
const grantSig = hex(P.signDebugAccessGrant(grant, admin));
const revoke = { serverDomain: grant.serverDomain, issuedAt: 1_760_000_600_000 };
const revokeSig = hex(P.signDebugAccessRevoke(revoke, admin));
const fp = P.sshKeyFingerprint(key);

const vectors = {
  about:
    "Owner debug access (docs/recipe-delivery-and-remote-install.md). Every platform must normalize each `sshKeys.accept[].input` to `normalized` and compute `fingerprint` (OpenSSH SHA256, no padding); every `sshKeys.reject` input must normalize to null. Build `grant.canonical` and `revoke.canonical` byte for byte from their fields; the pinned signatures verify under `keys.adminRootPubHex` and must NOT verify under `keys.irkPubHex`; `reject` signatures fail. Every `refuse` grant must be refused before signing (max 7 days, key required and normalized, ends after it starts).",
  keys: {
    adminRootSeedHex: hex(adminSeed),
    adminRootPubHex: hex(admin.publicKey),
    irkPubHex: hex(irk.publicKey),
  },
  limits: { defaultMs: P.DEBUG_ACCESS_DEFAULT_MS, maxMs: P.DEBUG_ACCESS_MAX_MS },
  sshKeys: {
    accept: [
      { input: key, normalized: key, fingerprint: fp },
      { input: `  ${key} harry@laptop\n`, normalized: key, fingerprint: fp },
      { input: `no-pty ${key} with a comment`, normalized: key, fingerprint: fp },
    ],
    reject: ["", "ssh-ed25519", "hello world", "ssh-ed25519 not*base64", `ssh-ed25519 ${wrongTypeBody}`, `ssh-dss ${body}`],
  },
  grant: {
    fields: grant,
    canonical: text(P.canonicalDebugAccessGrant(grant)),
    signatureHex: grantSig,
    wire: { grant, signatureHex: grantSig },
    reject: { signatureHex: flip(grantSig) },
  },
  revoke: {
    fields: revoke,
    canonical: text(P.canonicalDebugAccessRevoke(revoke)),
    signatureHex: revokeSig,
    wire: { revoke, signatureHex: revokeSig },
    reject: { signatureHex: flip(revokeSig) },
  },
  refuse: [
    { why: "no key", fields: { ...grant, sshPublicKey: "" } },
    { why: "key not normalized", fields: { ...grant, sshPublicKey: `${key} comment` } },
    { why: "ends before it starts", fields: { ...grant, expiresAt: grant.issuedAt } },
    { why: "longer than 7 days", fields: { ...grant, expiresAt: grant.issuedAt + P.DEBUG_ACCESS_MAX_MS + 1 } },
  ],
};

for (const r of vectors.refuse) {
  if (!P.debugAccessGrantProblem(r.fields)) throw new Error(`refuse case "${r.why}" is accepted`);
}
for (const r of vectors.sshKeys.reject) {
  if (P.normalizeSshPublicKey(r) !== null) throw new Error(`reject key "${r}" normalizes`);
}

const json = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== json) {
    console.error("debug-access vectors are stale: run node scripts/gen-debug-access-vectors.mjs");
    process.exit(1);
  }
  console.log("debug-access vectors up to date");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
