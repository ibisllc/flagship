import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalRecoveryRecord,
  checkRecoveryEvolution,
  recoveryRecordDigest,
  verifyRecoveryRecord,
  type RecoveryRecordV2,
  type StoredRecoveryState,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/recovery-record/vectors.json"), "utf8"),
);
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("recovery record v2 vectors (N03)", () => {
  const rec = vectors.record as RecoveryRecordV2;
  it("canonical bytes, digest and signature are the vector's", () => {
    expect(new TextDecoder().decode(canonicalRecoveryRecord(rec))).toBe(vectors.canonical);
    expect(recoveryRecordDigest(rec)).toBe(vectors.digestHex);
    expect(verifyRecoveryRecord(rec, unhex(vectors.signatureHex), unhex(vectors.userPubHex))).toBe(true);
  });
  it("changing any signed field breaks the signature", () => {
    for (const m of vectors.mutationsThatBreakTheSignature as { field: string; value: unknown }[]) {
      const changed = { ...rec, [m.field]: m.value } as RecoveryRecordV2;
      expect(verifyRecoveryRecord(changed, unhex(vectors.signatureHex), unhex(vectors.userPubHex)), m.field).toBe(false);
    }
  });
  it("the evolution rule gives every vector's verdict", () => {
    for (const c of vectors.evolution as { name: string; stored: StoredRecoveryState | null; next: RecoveryRecordV2; expect: string }[]) {
      const v = checkRecoveryEvolution(c.stored ?? undefined, c.next);
      expect(v.ok ? "ok" : v.reason, c.name).toBe(c.expect);
    }
  });
  it("refuses to canonicalize unknown versions, policies and malformed fields", () => {
    for (const bad of [
      { kdfVersion: 2 }, { algVersion: 9 }, { policy: "anything" }, { generation: 0 }, { nonceHex: "00" },
      { priorDigestHex: "later" }, { generation: 2, priorDigestHex: "genesis" }, { username: "a|b" }, { issuedAt: -1 },
      { adminRoot: { change: "keep", digestHex: "xyz" } },
    ]) {
      expect(() => canonicalRecoveryRecord({ ...rec, ...bad } as RecoveryRecordV2), JSON.stringify(bad)).toThrow();
    }
  });
});
