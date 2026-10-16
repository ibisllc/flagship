// Regenerates test-vectors/backup-policy/vectors.json:
//   npx tsx packages/protocol/tests/genBackupPolicyVectors.ts
// Every input is fixed, so the output is byte-stable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupPolicyCanonicalBytes, signBackupPolicy, type BackupPolicyOrder } from "../src/backupPolicy.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const umkSeedHex = "2a".repeat(32);
const irk = deriveIRK({ seed: fromHex(umkSeedHex) });
const orders: BackupPolicyOrder[] = [
  { serverDomain: "home.harry.flagship.services", policy: "phone", phoneReserveBytes: 32 * 1024 ** 3, issuedAt: 1700000000000 },
  { serverDomain: "home2.harry.flagship.services", policy: "peer", phoneReserveBytes: 0, issuedAt: 1792000000000 },
  { serverDomain: "lab.harry.flagship.services", policy: "none", phoneReserveBytes: 0, issuedAt: 1792000000001 },
];
const out = {
  about:
    "flagship/backup-policy/v1 (docs/server-backup-and-clone.md, Backup policy): a server's backup policy. Canonical: tag|serverDomain|policy|phoneReserveBytes|issuedAt. policy is phone, peer or none; phoneReserveBytes is > 0 exactly when the policy is phone, else 0. Key: the protocol IRK derived from the UMK seed.",
  umkSeedHex,
  pub: hex(irk.publicKey),
  cases: orders.map((o) => ({ ...o, canonical: new TextDecoder().decode(backupPolicyCanonicalBytes(o)), signature: hex(signBackupPolicy(o, irk)) })),
  invalid: [
    { serverDomain: "", policy: "none", phoneReserveBytes: 0, issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", policy: "cloud", phoneReserveBytes: 0, issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", policy: "phone", phoneReserveBytes: 0, issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", policy: "peer", phoneReserveBytes: 5, issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", policy: "phone", phoneReserveBytes: -1, issuedAt: 1 },
    { serverDomain: "home.harry.flagship.services", policy: "none", phoneReserveBytes: 0, issuedAt: -1 },
  ],
};
const path = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/backup-policy/vectors.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
