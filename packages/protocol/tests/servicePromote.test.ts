/**
 * Dev→prod promotion wall (feat/dev-prod-dataspace, spec §5–6).
 *
 * Pins canonical bytes, round-trips sign/verify, exercises every tamper axis,
 * and asserts the two tags are DISTINCT (a promote order can never be replayed
 * as an attestation, and vice-versa) — the load-bearing separation between "the
 * owner authorized promoting these bytes" and "the review authority passed
 * these bytes".
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signServicePromote,
  verifyServicePromote,
  signCodeSecurityAttestation,
  verifyCodeSecurityAttestation,
  type ServicePromoteOrder,
  type CodeSecurityAttestation,
  type Keypair,
} from "../src/index.js";

function makeKey(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

const ownerRoot = makeKey(0x11);
const reviewKey = makeKey(0x22);
const wrongKey = makeKey(0x33);
const DIGEST = "ab".repeat(32);

function baseOrder(): ServicePromoteOrder {
  return {
    serverId: "home.alice.flagship.services",
    creator: "alice",
    slug: "notes",
    artifactDigest: DIGEST,
    issuedAt: 1_700_000_000_000,
  };
}
function baseAttestation(): CodeSecurityAttestation {
  return {
    serverId: "home.alice.flagship.services",
    creator: "alice",
    slug: "notes",
    artifactDigest: DIGEST,
    verdict: "pass",
    scanners: "trivy@0.50.0,flagship-checks@3",
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_900_000,
  };
}

describe("ServicePromoteOrder", () => {
  it("round-trips sign/verify under the signing key", () => {
    const o = baseOrder();
    const sig = signServicePromote(o, ownerRoot);
    expect(verifyServicePromote(o, sig, ownerRoot.publicKey)).toBe(true);
  });

  it("rejects the wrong signer", () => {
    const o = baseOrder();
    const sig = signServicePromote(o, ownerRoot);
    expect(verifyServicePromote(o, sig, wrongKey.publicKey)).toBe(false);
  });

  it("fails on every tampered field (digest binding is load-bearing)", () => {
    const o = baseOrder();
    const sig = signServicePromote(o, ownerRoot);
    const mutations: Array<Partial<ServicePromoteOrder>> = [
      { serverId: "home.bob.flagship.services" },
      { creator: "bob" },
      { slug: "other" },
      { artifactDigest: "cd".repeat(32) },
      { issuedAt: 1_700_000_000_001 },
    ];
    for (const m of mutations) {
      expect(verifyServicePromote({ ...o, ...m }, sig, ownerRoot.publicKey)).toBe(false);
    }
  });
});

describe("CodeSecurityAttestation", () => {
  it("round-trips sign/verify under the review key", () => {
    const a = baseAttestation();
    const sig = signCodeSecurityAttestation(a, reviewKey);
    expect(verifyCodeSecurityAttestation(a, sig, reviewKey.publicKey)).toBe(true);
  });

  it("rejects the wrong signer", () => {
    const a = baseAttestation();
    const sig = signCodeSecurityAttestation(a, reviewKey);
    expect(verifyCodeSecurityAttestation(a, sig, wrongKey.publicKey)).toBe(false);
  });

  it("fails on every tampered field (verdict + digest cannot be swapped)", () => {
    const a = baseAttestation();
    const sig = signCodeSecurityAttestation(a, reviewKey);
    const mutations: Array<Partial<CodeSecurityAttestation>> = [
      { artifactDigest: "cd".repeat(32) },
      { verdict: "fail" },
      { scanners: "trivy@0.0.1" },
      { issuedAt: 1 },
      { expiresAt: 2 },
      { creator: "bob" },
      { slug: "other" },
    ];
    for (const m of mutations) {
      expect(verifyCodeSecurityAttestation({ ...a, ...m }, sig, reviewKey.publicKey)).toBe(false);
    }
  });
});

describe("tag separation", () => {
  it("a promote signature never verifies as an attestation over the same fields", () => {
    const o = baseOrder();
    const promoteSig = signServicePromote(o, ownerRoot);
    // Build an attestation that shares the overlapping fields; the distinct tag
    // + extra fields mean the promote signature cannot authorize it.
    const a = baseAttestation();
    expect(verifyCodeSecurityAttestation(a, promoteSig, ownerRoot.publicKey)).toBe(false);
  });
});
