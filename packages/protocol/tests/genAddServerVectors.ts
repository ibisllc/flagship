// Builds test-vectors/add-server/vectors.json (adding a server is admin-only,
// owner rule 2026-10-16). Regenerate with:
//   npx tsx packages/protocol/tests/genAddServerVectors.ts
// Every input is fixed and Ed25519 here is deterministic, so the output is
// byte-stable; addServerVectors.test.ts fails when the file drifts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import {
  authCodeAdminCanonicalBytes,
  authCodeCanonicalBytes,
  type AuthCode,
} from "../src/installBlob.js";
import { serverRestoreCanonicalBytes, type ServerRestoreOrder } from "../src/serverBackup.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
const pubOf = (seed: Uint8Array) => ed.getPublicKey(seed);
const sign = (msg: Uint8Array, seed: Uint8Array) => bytesToHex(ed.sign(msg, seed));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-vectors/add-server/vectors.json",
);

export function buildAddServerVectors(): unknown {
  const irk = fill(0x11);
  const admin = fill(0x22);
  const other = fill(0x33);
  const device = fill(0x44);
  const delegated = fill(0x55);

  const code = (ar: Uint8Array | undefined): AuthCode => ({
    version: 1,
    serial: "01ABCDEF0123456789ABCDEF01",
    username: "harry",
    serverName: "home2",
    serverDomain: "home2.harry.flagship.services",
    delegatedPubKey: pubOf(delegated),
    userPubKey: pubOf(irk),
    issuedAt: 1792000000000,
    expiresAt: 1792021600000,
    ...(ar ? { adminRootPubKey: ar } : {}),
  });
  const fields = (c: AuthCode) => ({
    version: c.version,
    serial: c.serial,
    username: c.username,
    serverName: c.serverName,
    serverDomain: c.serverDomain,
    delegatedPubKey: bytesToHex(c.delegatedPubKey),
    userPubKey: bytesToHex(c.userPubKey),
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    ...(c.adminRootPubKey ? { adminRootPubKey: bytesToHex(c.adminRootPubKey) } : {}),
  });

  const ac = code(pubOf(admin));
  const acBytes = authCodeCanonicalBytes(ac);
  const adminBytes = authCodeAdminCanonicalBytes(ac);
  const wrong = code(pubOf(other));
  const wrongAdminBytes = authCodeAdminCanonicalBytes(wrong);

  const restore: ServerRestoreOrder = {
    serverDomain: "home2.harry.flagship.services",
    archiveId: "00112233445566778899aabbccddeeff",
    bytes: 123456789,
    sha256: "ab".repeat(32),
    issuedAt: 1792000000000,
  };
  const restoreBytes = serverRestoreCanonicalBytes(restore);

  return {
    about:
      "Adding a server to an account is admin-only (owner rule 2026-10-16; docs/service-access-gating.md \"Account members\"). " +
      "authCode: on an admin-pinned account, POST /api/auth-code/issue carries `adminSignature`, the admin root's (or an admin-granted device's) Ed25519 signature over " +
      "flagship/auth-code-admin/v1|<the AuthCode canonical string>; the AuthCode must carry ar=<the account's pinned admin root>, and an AuthCode without ar= has no admin form (refuse). " +
      "The IRK still signs the plain AuthCode (`signature`). reject: signatures that must NOT verify as the admin approval under keys.adminRootPubHex. " +
      "wrongRoot: an AuthCode pinning another root, approved by that root: it verifies under that root, and .com refuses it because the root is not the account's. " +
      "restore: flagship/server-restore/v1 (unchanged bytes) signed by the admin root, which an admin-pinned box now requires (IRK refused). Seeds are raw Ed25519 seeds.",
    keys: {
      irkSeedHex: bytesToHex(irk),
      irkPubHex: bytesToHex(pubOf(irk)),
      adminRootSeedHex: bytesToHex(admin),
      adminRootPubHex: bytesToHex(pubOf(admin)),
      otherRootSeedHex: bytesToHex(other),
      otherRootPubHex: bytesToHex(pubOf(other)),
      deviceSeedHex: bytesToHex(device),
      devicePubHex: bytesToHex(pubOf(device)),
    },
    authCode: {
      fields: fields(ac),
      canonical: text(acBytes),
      irkSignatureHex: sign(acBytes, irk),
      adminCanonical: text(adminBytes),
      adminSignatureHex: sign(adminBytes, admin),
    },
    reject: [
      { why: "the IRK signed the admin form", signatureHex: sign(adminBytes, irk) },
      { why: "a non-admin device key signed the admin form", signatureHex: sign(adminBytes, device) },
      { why: "the admin root signed the plain AuthCode, not the admin form", signatureHex: sign(acBytes, admin) },
      { why: "another root signed the admin form", signatureHex: sign(adminBytes, other) },
    ],
    wrongRoot: {
      fields: fields(wrong),
      adminCanonical: text(wrongAdminBytes),
      adminSignatureHex: sign(wrongAdminBytes, other),
    },
    refuse: [
      { why: "no admin root in the AuthCode", fields: fields(code(undefined)) },
    ],
    restore: {
      order: restore,
      canonical: text(restoreBytes),
      adminSignatureHex: sign(restoreBytes, admin),
      reject: [
        { why: "the IRK signed it (an admin-pinned box refuses)", signatureHex: sign(restoreBytes, irk) },
        { why: "a non-admin device key signed it", signatureHex: sign(restoreBytes, device) },
      ],
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, JSON.stringify(buildAddServerVectors(), null, 2) + "\n");
  console.log(`wrote ${VECTORS_PATH}`);
}
