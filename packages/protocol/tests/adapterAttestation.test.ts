import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adapterFileCapabilityDigest,
  adapterIndexDigest,
  adapterStanding,
  attestationDigest,
  canonicalAdapterAttestation,
  canonicalAdapterIndex,
  ed,
  signAdapterAttestation,
  signAdapterIndex,
  verifyAdapterAttestation,
  verifyAdapterIndex,
  type AdapterAttestation,
  type AdapterIndexBody,
  type SignedAdapterAttestation,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/adapter-attestation/vectors.json", import.meta.url), "utf8"));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const vet = { privateKey: bytes(V.keys.vetSeedHex), publicKey: bytes(V.keys.vetPubHex) };
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("adapter attestation vectors", () => {
  it("derives the pinned vetting key and the file's digests", () => {
    expect(Buffer.from(ed.getPublicKey(vet.privateKey)).toString("hex")).toBe(V.keys.vetPubHex);
    expect(adapterFileCapabilityDigest(V.file.text)).toBe(V.file.capabilityDigestHex);
    expect(adapterFileCapabilityDigest("{}")).toBeNull();
  });

  it("reproduces each attestation's bytes, digest and signature, and verifies it", () => {
    for (const name of ["pass", "revoked"]) {
      const a = V.attestations[name];
      expect(text(canonicalAdapterAttestation(a.fields))).toBe(a.canonical);
      expect(attestationDigest(a.fields)).toBe(a.digestHex);
      const signed = signAdapterAttestation(a.fields, vet);
      expect(signed.signatureHex).toBe(a.signatureHex);
      expect(verifyAdapterAttestation(signed, V.keys.pinned)).toBe(true);
    }
  });

  it("refuses every tampered, unpinned or out-of-window attestation", () => {
    for (const r of V.attestationRejects) expect(verifyAdapterAttestation(r.signed, V.keys.pinned), r.why).toBe(false);
  });

  it("reproduces the index chain and every verdict", () => {
    for (const name of ["one", "two"]) {
      const i = V.indexes[name];
      expect(text(canonicalAdapterIndex(i.fields))).toBe(i.canonical);
      expect(adapterIndexDigest(i.fields)).toBe(i.digestHex);
      expect(signAdapterIndex(i.fields, vet).signatureHex).toBe(i.signatureHex);
    }
    for (const c of V.indexChecks) {
      const i = V.indexes[c.index];
      const signed = { index: i.fields, signerPubHex: V.keys.vetPubHex, signatureHex: i.signatureHex };
      expect(verifyAdapterIndex(signed, V.keys.pinned, c.highWater, c.now), c.why).toEqual(c.expect);
    }
  });

  it("works out each digest's standing; a revocation is final", () => {
    const named: Record<string, AdapterAttestation> = { pass: V.attestations.pass.fields, revoked: V.attestations.revoked.fields, laterPass: V.laterPass };
    for (const s of V.standing) {
      const got = adapterStanding(s.attestations.map((n: string) => named[n]!), V.file.sha256Hex, s.now);
      expect(got.state, s.why).toBe(s.expect);
    }
  });
});

describe("adapter attestation rules", () => {
  const pass: AdapterAttestation = V.attestations.pass.fields;

  it("refuses fields that would break the canonical form", () => {
    const bad: Array<Partial<AdapterAttestation>> = [
      { repo: "https://github.com/a|b" },
      { repo: "github.com/a/b" },
      { baseRevision: "main" },
      { modelVersion: "m|1" },
      { policyVersion: "" },
      { reviewerModel: "x".repeat(129) },
      { expiresAt: pass.issuedAt },
      { outcome: "safe" as never },
      { adapterDigestHex: "A".repeat(64) },
    ];
    for (const over of bad) expect(() => canonicalAdapterAttestation({ ...pass, ...over }), JSON.stringify(over)).toThrow();
  });

  it("a key past its window signs no index, whatever issuedAt it claims", () => {
    const body: AdapterIndexBody = V.indexes.one.fields;
    const signed = signAdapterIndex(body, vet);
    const retired = [{ ...V.keys.pinned[0], notAfter: body.issuedAt + 1000 }];
    expect(verifyAdapterIndex(signed, retired, null, body.issuedAt + 500)).toMatchObject({ ok: true });
    expect(verifyAdapterIndex(signed, retired, null, body.issuedAt + 2000)).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("an equal-time tie goes to the more cautious outcome", () => {
    const fail = { ...pass, outcome: "fail" as const };
    expect(adapterStanding([pass, fail], pass.adapterDigestHex, pass.issuedAt + 1).state).toBe("failed");
    expect(adapterStanding([fail, pass], pass.adapterDigestHex, pass.issuedAt + 1).state).toBe("failed");
    const signed: SignedAdapterAttestation = signAdapterAttestation(fail, vet);
    expect(verifyAdapterAttestation(signed, V.keys.pinned)).toBe(true);
  });

  it("malformed signer or signature hex is a refusal, not a throw", () => {
    const s = signAdapterAttestation(pass, vet);
    expect(verifyAdapterAttestation({ ...s, signatureHex: "zz" }, V.keys.pinned)).toBe(false);
    expect(verifyAdapterIndex({ index: V.indexes.one.fields, signerPubHex: V.keys.vetPubHex, signatureHex: "q" }, V.keys.pinned, null, V.indexes.one.fields.issuedAt)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
});
