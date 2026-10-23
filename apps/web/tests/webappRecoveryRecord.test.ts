import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
// @ts-expect-error plain browser module
import { buildRecoveryEnvelope, canonicalRecoveryRecordBytes, ciphertextMismatch, recoveryRecordDigest, verifySignedRecord } from "../public/webapp/lib/recoveryRecord.js";
// @ts-expect-error plain browser module
import { ciphertextMismatch as subOriginMismatch } from "../public/recovery/recoveryRecordCheck.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/recovery-record/vectors.json", import.meta.url), "utf8"));
const seed = Uint8Array.from(Buffer.from(vectors.userSeedHex, "hex"));
const pub = ed.getPublicKey(seed);
const sign = async (b: Uint8Array) => ed.sign(b, seed);
const verify = async (p: Uint8Array, s: Uint8Array, m: Uint8Array) => ed.verify(s, m, p);
const b64 = (b: number[]) => Buffer.from(b).toString("base64");

describe("the webapp's recovery record v2", () => {
  it("builds the same canonical bytes and digest as the shared vector", async () => {
    expect(new TextDecoder().decode(canonicalRecoveryRecordBytes(vectors.record))).toBe(vectors.canonical);
    expect(await recoveryRecordDigest(vectors.record)).toBe(vectors.digestHex);
    expect(await verifySignedRecord(vectors.record, vectors.signatureHex, pub, verify)).toBe(true);
  });

  it("every one-field change to the claim breaks the signature", async () => {
    for (const m of vectors.mutationsThatBreakTheSignature) {
      const changed = { ...vectors.record, [m.field]: m.value };
      expect(await verifySignedRecord(changed, vectors.signatureHex, pub, verify), m.field).toBe(false);
    }
  });

  it("chains onto what is stored and says keep / replace / none explicitly", async () => {
    const authority = { irkPubHex: Buffer.from(pub).toString("hex"), adminRootPubHex: "none" };
    const first = await buildRecoveryEnvelope({
      op: "put", username: "Alice", authority, current: null, credentialIdHex: "c0ffee00c0ffee00", wrappedUmkB64: b64([1, 2, 3]),
      fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), sign,
    });
    expect(first.claim).toMatchObject({ generation: 1, priorDigestHex: "genesis", adminRoot: { change: "none" }, acmeKey: { change: "none" } });
    const stored = { digestHex: await recoveryRecordDigest(first.claim), generation: 1, adminRootDigestHex: "ee".repeat(32) };
    const second = await buildRecoveryEnvelope({
      op: "put", username: "Alice", authority, current: stored, credentialIdHex: "c0ffee00c0ffee00", wrappedUmkB64: b64([1, 2, 3]),
      fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), sign,
    });
    expect(second.claim).toMatchObject({ generation: 2, priorDigestHex: stored.digestHex, adminRoot: { change: "keep", digestHex: "ee".repeat(32) } });
    expect(second).not.toHaveProperty("wrappedAdminRoot");
    const upgrade = await buildRecoveryEnvelope({
      op: "put", username: "Alice", authority, current: { legacy: true }, credentialIdHex: "c0ffee00c0ffee00", wrappedUmkB64: b64([1]),
      wrappedAdminRootB64: b64([9]), fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), sign,
    });
    expect(upgrade.claim).toMatchObject({ generation: 1, priorDigestHex: "legacy", adminRoot: { change: "replace" } });
  });

  it("detects a swapped, dropped or added ciphertext before anything is unwrapped", async () => {
    const authority = { irkPubHex: Buffer.from(pub).toString("hex"), adminRootPubHex: "none" };
    const env = await buildRecoveryEnvelope({
      op: "put", username: "a", authority, current: null, credentialIdHex: "c0ffee00c0ffee00", wrappedUmkB64: b64([1, 2, 3]),
      wrappedAdminRootB64: b64([4, 5]), fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), sign,
    });
    const good = { wrappedUmkB64: b64([1, 2, 3]), wrappedAdminRootB64: b64([4, 5]) };
    for (const check of [ciphertextMismatch, subOriginMismatch]) {
      expect(await check(env.claim, good)).toBeNull();
      expect(await check(env.claim, { ...good, wrappedUmkB64: b64([9]) })).toBe("wrappedUmk");
      expect(await check(env.claim, { ...good, wrappedAdminRootB64: b64([9]) })).toBe("wrappedAdminRoot");
      expect(await check(env.claim, { wrappedUmkB64: good.wrappedUmkB64 })).toBe("wrappedAdminRoot");
      expect(await check(env.claim, { ...good, wrappedAcmeAccountKeyB64: b64([7]) })).toBe("wrappedAcmeAccountKey");
    }
  });
});
