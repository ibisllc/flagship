import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  backupPolicyCanonicalBytes,
  parseBackupPolicy,
  signBackupPolicy,
  verifyBackupPolicy,
  type BackupPolicyOrder,
} from "../src/backupPolicy.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/backup-policy/vectors.json"), "utf8"),
) as { umkSeedHex: string; pub: string; cases: Array<BackupPolicyOrder & { canonical: string; signature: string }>; invalid: BackupPolicyOrder[] };
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("backup-policy vectors (test-vectors/backup-policy/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });
  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    const o = { serverDomain: c.serverDomain, policy: c.policy, phoneReserveBytes: c.phoneReserveBytes, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(backupPolicyCanonicalBytes(o))).toBe(c.canonical);
    expect(hex(signBackupPolicy(o, irk))).toBe(c.signature);
    expect(verifyBackupPolicy(o, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(verifyBackupPolicy({ ...o, issuedAt: o.issuedAt + 1 }, fromHex(c.signature), irk.publicKey)).toBe(false);
    expect(parseBackupPolicy(o)).toEqual(o);
  });
  it.each(V.invalid.map((c, i) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(parseBackupPolicy(c)).toBeNull();
    expect(() => backupPolicyCanonicalBytes(c)).toThrow();
  });
});
