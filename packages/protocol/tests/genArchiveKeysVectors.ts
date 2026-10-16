// Regenerate test-vectors/server-archive-keys/vectors.json:
//   npx tsx packages/protocol/tests/genArchiveKeysVectors.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveKeysCanonicalBytes, archiveKeysDigest, signArchiveKeysDeposit } from "../src/archiveKeys.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK, deriveServerArchiveKey } from "../src/keys.js";

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const umkSeedHex = "2a".repeat(32);
const umk = { seed: fromHex(umkSeedHex) };
const irk = deriveIRK(umk);

const cases = [
  { serverDomain: "home.harry.flagship.services", ids: ["00112233445566778899aabbccddeeff"], issuedAt: 1700000000000 },
  {
    serverDomain: "home2.harry.flagship.services",
    ids: ["ffeeddccbbaa99887766554433221100", "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"],
    issuedAt: 1792000000000,
  },
].map((c) => {
  const keys = c.ids.map((archiveId) => ({ archiveId, kekHex: hex(deriveServerArchiveKey(umk, archiveId)) }));
  const digest = archiveKeysDigest(keys);
  const deposit = { serverDomain: c.serverDomain, count: keys.length, digest, issuedAt: c.issuedAt };
  return {
    serverDomain: c.serverDomain,
    issuedAt: c.issuedAt,
    keys,
    digest,
    canonical: new TextDecoder().decode(archiveKeysCanonicalBytes(deposit)),
    signature: hex(signArchiveKeysDeposit(deposit, irk)),
  };
});

const out = {
  about:
    "flagship/server-archive-keys/v1 (docs/server-backup-and-clone.md, Scheduled backups): an admin device's signed batch of archive ids and account-slot keys (kekHex = deriveServerArchiveKey(UMK, archiveId)) for a box's scheduled backups. digest = SHA-256 hex of the UTF-8 lines '<archiveId>:<kekHex>' joined with '\\n' in order. Canonical: tag|serverDomain|count|digest|issuedAt. count is 1..400. Key: the protocol IRK derived from the UMK seed.",
  umkSeedHex,
  pub: hex(irk.publicKey),
  cases,
  invalid: [
    { serverDomain: "", count: 1, digest: "00".repeat(32), issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", count: 0, digest: "00".repeat(32), issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", count: 401, digest: "00".repeat(32), issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", count: 1, digest: "ZZ", issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", count: 1, digest: "00".repeat(32), issuedAt: -1 },
  ],
};
writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-archive-keys/vectors.json"),
  JSON.stringify(out, null, 2) + "\n",
);
