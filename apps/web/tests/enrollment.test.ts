import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enrollmentProofHex, newEnrollmentSecretHex, serverCode, serverSeenMacHex, verifyEnrollmentProof, verifyServerSeen } from "../public/webapp/lib/enrollment.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/enrollment/vectors.json"), "utf8"));

describe("web enrollment", () => {
  it("matches the shared proofs and codes, and refuses another server, key or install code", async () => {
    for (const p of v.proofs) expect(await enrollmentProofHex(v.secretHex, p.statement)).toBe(p.proofHex);
    for (const c of v.invalid) expect(await verifyEnrollmentProof(v.secretHex, c.statement, v.proofs[0].proofHex), c.name).toBe(false);
    expect(await verifyEnrollmentProof(v.secretHex, v.proofs[0].statement, v.proofs[0].proofHex)).toBe(true);
    for (const c of v.codes) expect(await serverCode(c.stkPubHex)).toBe(c.code);
    expect(newEnrollmentSecretHex()).toMatch(/^[0-9a-f]{64}$/);
    for (const s of v.seen) {
      expect(await serverSeenMacHex(v.studioConfirmKeyHex, s.serverDomain, s.stkPubHex)).toBe(s.macHex);
      expect(await verifyServerSeen(v.studioConfirmKeyHex, s.serverDomain, "ef".repeat(32), s.macHex)).toBe(false);
    }
  });
});
