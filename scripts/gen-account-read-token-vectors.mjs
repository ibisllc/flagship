#!/usr/bin/env node
// Writes packages/protocol/test-vectors/account-read-token/vectors.json from
// the TS reference (docs/account-read-token.md). Build the protocol package
// first:
//   npx tsc -b packages/protocol && node scripts/gen-account-read-token-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/account-read-token/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);

const account = "plucky-avocet";
const umk = { seed: fill(32, 0x2a) };
const deviceId = "0123456789abcdef0123456789abcdef";
const deviceSeed = P.deriveAccountDeviceKeySeed(umk.seed, account, deviceId);
const devicePub = P.ed.getPublicKey(deviceSeed);
const irk = P.deriveIRK(umk);
const stkSeed = fill(32, 0x5b);
const stkPub = P.ed.getPublicKey(stkSeed);
const t0 = 1_760_000_000_000;

const deviceRequest = {
  accountId: account,
  deviceId,
  signerPubHex: hex(devicePub),
  method: "POST",
  path: P.accountReadTokenPath(account),
  requestId: "00112233445566778899aabbccddeeff",
  issuedAt: t0,
};
const deviceSig = P.signAccountDirectoryRequest(deviceRequest, (m) => P.ed.sign(m, deviceSeed));

const irkClaim = {
  username: account,
  endpointLabel: P.ACCOUNT_READ_TOKEN_LABEL,
  phoneIrkPub: irk.publicKey,
  issuedAt: t0,
  expiresAt: t0 + 5 * 60_000,
  nonce: Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff),
};
const irkSig = P.signDeviceEndpointClaim(irkClaim, irk);
const irkCanonical = [
  "flagship/device-endpoint-claim/v1",
  irkClaim.username,
  irkClaim.endpointLabel,
  hex(irkClaim.phoneIrkPub),
  irkClaim.issuedAt,
  irkClaim.expiresAt,
  hex(irkClaim.nonce),
].join("|");
if (!P.verifyDeviceEndpointClaim(irkClaim, irkSig, irk.publicKey)) throw new Error("irk vector doesn't verify");

const boxRequest = {
  username: account,
  serverDomain: `home3.${account}.flagship.services`,
  stkPubHex: hex(stkPub),
  issuedAt: t0,
  nonceHex: "fedcba98765432100123456789abcdef",
};
const boxSig = P.signBoxReadTokenRequest(boxRequest, (m) => P.ed.sign(m, stkSeed));

const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const vectors = {
  about: "Account read tokens (docs/account-read-token.md). Every client platform must reproduce `device` and `irk`: derive the keys from `keys`, build the canonical string from `fields` byte for byte, and reproduce the Ed25519 signature; `box` is TS-only (servers). The device request travels in headers to POST `fields.path`; the IRK claim travels as `{auth, authSignature}` in the body. Every `reject` signature must fail to verify.",
  keys: {
    umkSeedHex: hex(umk.seed),
    accountId: account,
    deviceId,
    deviceSeedHex: hex(deviceSeed),
    devicePubHex: hex(devicePub),
    irkPubHex: hex(irk.publicKey),
    stkSeedHex: hex(stkSeed),
    stkPubHex: hex(stkPub),
  },
  device: {
    fields: deviceRequest,
    headers: {
      "x-flagship-device-id": deviceId,
      "x-flagship-device-pub": deviceRequest.signerPubHex,
      "x-flagship-request-id": deviceRequest.requestId,
      "x-flagship-issued-at": String(t0),
      "x-flagship-signature": deviceSig,
    },
    canonical: ["flagship/account-directory-request/v1", "POST", deviceRequest.path, account, deviceId, deviceRequest.signerPubHex, deviceRequest.requestId, t0].join("|"),
    signatureHex: deviceSig,
    reject: { signatureHex: flip(deviceSig) },
  },
  irk: {
    fields: { ...irkClaim, phoneIrkPub: hex(irkClaim.phoneIrkPub), nonce: hex(irkClaim.nonce) },
    body: {
      auth: { ...irkClaim, phoneIrkPub: hex(irkClaim.phoneIrkPub), nonce: hex(irkClaim.nonce) },
      authSignature: hex(irkSig),
    },
    canonical: irkCanonical,
    signatureHex: hex(irkSig),
    reject: { signatureHex: flip(hex(irkSig)) },
  },
  box: {
    fields: boxRequest,
    canonical: text(P.canonicalBoxReadTokenRequest(boxRequest)),
    signatureHex: boxSig,
    reject: { signatureHex: flip(boxSig) },
  },
};

const json = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing */ }
  if (current !== json) {
    console.error(`${out} is stale; rerun scripts/gen-account-read-token-vectors.mjs`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
