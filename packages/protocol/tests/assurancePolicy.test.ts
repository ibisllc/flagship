import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  PolicyError,
  acceptsClassicalOnly,
  adoptStoredState,
  advanceRollout,
  applyPolicyChange,
  assurancePolicyDigest,
  canonicalAssurancePolicyChange,
  classicalExchangeAllowed,
  legacyPolicyState,
  selectSignatureSuite,
  strictInForce,
  type AssurancePolicyChange,
  type PolicySignatureCheck,
  type PolicyState,
} from "../src/assurancePolicy.js";

const scope = { kind: "installation", id: "home.plucky-avocet" } as const;
const D = (c: string) => c.repeat(64);
const reentry = { verifierChecksDigest: D("1"), enrollmentDigest: D("2"), rekeyReceiptDigest: D("3"), recoveryTestDigest: D("4") };

const signed = new Set<string>();
const revoked = new Set<string>();
const check: PolicySignatureCheck = (msg, c) => ({ suiteVerified: signed.has(new TextDecoder().decode(msg)), signerActive: !revoked.has(c.signerKeyId) });
const sign = (c: AssurancePolicyChange) => (signed.add(new TextDecoder().decode(canonicalAssurancePolicyChange(c))), c);

function change(state: PolicyState, over: Partial<AssurancePolicyChange> = {}): AssurancePolicyChange {
  const next = state.profile === "strict" ? "compatibility" : "strict";
  return sign({
    account: "plucky-avocet",
    scope,
    prior: state.profile,
    next,
    generation: state.generation + 1,
    prevDigest: state.headDigest,
    affectedPeersDigest: D("a"),
    acknowledgedLoss: next === "compatibility" ? ["classical-signatures-accepted"] : [],
    signerKind: "admin-device",
    signerKeyId: "00112233445566778899aabbccddeeff",
    suite: "hybrid-ed25519-mldsa65/v1",
    issuedAt: 1_793_000_000_000,
    ...over,
  });
}

function prepared(): PolicyState {
  let s = legacyPolicyState(scope);
  s = advanceRollout(s, "capable", { capabilityAdvertised: true });
  return advanceRollout(s, "prepared", { boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true });
}

function enforced(): PolicyState {
  return applyPolicyChange(prepared(), change(prepared()), check);
}

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as PolicyError).code;
  }
  return "no error";
};

describe("rollout", () => {
  it("a capability advertisement alone changes no trust", () => {
    const s = advanceRollout(legacyPolicyState(scope), "capable", { capabilityAdvertised: true });
    expect(acceptsClassicalOnly(s)).toBe(true);
  });

  it("needs evidence for prepared and a signed change for enforced", () => {
    const s = advanceRollout(legacyPolicyState(scope), "capable", { capabilityAdvertised: true });
    expect(code(() => advanceRollout(s, "prepared", { boundPublicKeys: true, recipientsVerified: true }))).toBe("missing-evidence");
    expect(code(() => advanceRollout(prepared(), "enforced", {}))).toBe("needs-policy-change");
    expect(code(() => advanceRollout(legacyPolicyState(scope), "prepared", { boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true }))).toBe("missing-evidence");
  });

  it("enforces strict through the owner's change and never goes back", () => {
    const s = enforced();
    expect(s.rollout).toBe("enforced");
    expect(strictInForce(s)).toBe(true);
    expect(code(() => advanceRollout(s, "prepared", {}))).toBe("rollback-refused");
    expect(advanceRollout(s, "retired", { compatibilityGatePassed: true }).rollout).toBe("retired");
  });

  it("refuses strict before keys and recovery are ready", () => {
    const s = legacyPolicyState(scope);
    expect(code(() => applyPolicyChange(s, change(s), check))).toBe("not-prepared");
  });
});

describe("who can change protection", () => {
  it.each(["box", "app", "relay", "cloud", "legacy-client"] as const)("refuses a %s", (signerKind) => {
    const s = enforced();
    expect(code(() => applyPolicyChange(s, change(s, { signerKind }), check))).toBe("not-owner-authority");
  });

  it("refuses a classical-only signer leaving strict", () => {
    const s = enforced();
    expect(code(() => applyPolicyChange(s, change(s, { suite: "ed25519/v1" }), check))).toBe("classical-signer-refused");
  });

  it("refuses a revoked signer and a forged signature", () => {
    const s = enforced();
    const c = change(s, { signerKeyId: "ffeeddccbbaa99887766554433221100" });
    revoked.add(c.signerKeyId);
    expect(code(() => applyPolicyChange(s, c, check))).toBe("signer-not-active");
    const forged = { ...change(s), issuedAt: 1 };
    expect(code(() => applyPolicyChange(s, forged, check))).toBe("bad-signature");
  });

  it("requires the owner to acknowledge the loss", () => {
    const s = enforced();
    expect(code(() => applyPolicyChange(s, change(s, { acknowledgedLoss: [] }), check))).toBe("loss-not-acknowledged");
  });
});

describe("opt-out is a new epoch, not a reset", () => {
  it("chains generations and refuses replay or a skipped link", () => {
    const s1 = enforced();
    const out = change(s1);
    const s2 = applyPolicyChange(s1, out, check);
    expect(s2.profile).toBe("compatibility");
    expect(s2.generation).toBe(2);
    expect(s2.rollout).toBe("enforced");
    expect(acceptsClassicalOnly(s2)).toBe(true);
    expect(code(() => applyPolicyChange(s2, out, check))).toBe("stale-generation");
    expect(code(() => applyPolicyChange(s2, change(s2, { prevDigest: GENESIS_DIGEST }), check))).toBe("broken-chain");
    expect(code(() => applyPolicyChange(s2, change(s2, { generation: 4 }), check))).toBe("stale-generation");
  });

  it("returning to strict needs fresh checks, rekeying and recovery", () => {
    const s2 = applyPolicyChange(enforced(), change(enforced()), check);
    expect(code(() => applyPolicyChange(s2, change(s2), check))).toBe("reentry-incomplete");
    const s3 = applyPolicyChange(s2, change(s2, { reentry }), check);
    expect(strictInForce(s3)).toBe(true);
    expect(s3.generation).toBe(3);
  });

  it("a restored or copied older state cannot replace the one in force", () => {
    const s1 = enforced();
    const s2 = applyPolicyChange(s1, change(s1), check);
    expect(code(() => adoptStoredState(s2, s1))).toBe("rollback-refused");
    expect(code(() => adoptStoredState(s1, prepared()))).toBe("rollback-refused");
    expect(code(() => adoptStoredState(s1, { ...s1, headDigest: D("9") }))).toBe("rollback-refused");
    expect(adoptStoredState(s1, s2)).toEqual(s2);
  });
});

describe("negotiation", () => {
  it("stripping the hybrid suite cannot downgrade a strict scope", () => {
    expect(code(() => selectSignatureSuite(enforced(), ["ed25519/v1"]))).toBe("upgrade-required");
    expect(selectSignatureSuite(enforced(), ["ed25519/v1", "hybrid-ed25519-mldsa65/v1"])).toBe("hybrid-ed25519-mldsa65/v1");
    expect(selectSignatureSuite(legacyPolicyState(scope), ["ed25519/v1"])).toBe("ed25519/v1");
  });

  it("the stricter side decides a classical exchange", () => {
    const strict = enforced();
    const compat = legacyPolicyState({ kind: "installation", id: "other" });
    expect(classicalExchangeAllowed(compat, compat, D("c"))).toBe(true);
    expect(classicalExchangeAllowed(strict, compat, D("c"))).toBe(false);
    expect(classicalExchangeAllowed(compat, strict, D("c"), { subjectDigest: D("d"), generation: 1 })).toBe(false);
    expect(classicalExchangeAllowed(compat, strict, D("c"), { subjectDigest: D("c"), generation: 1 })).toBe(true);
  });
});

describe("canonical bytes", () => {
  it("refuses separators, unknown codes and bad digests", () => {
    const base = change(prepared());
    expect(() => canonicalAssurancePolicyChange({ ...base, account: "a|b" })).toThrow();
    expect(() => canonicalAssurancePolicyChange({ ...base, prevDigest: "00" })).toThrow();
    expect(() => canonicalAssurancePolicyChange({ ...base, acknowledgedLoss: ["nothing" as never] })).toThrow();
    expect(() => canonicalAssurancePolicyChange({ ...base, generation: 0 })).toThrow();
  });

  it("matches the shared vectors", () => {
    const vectors = JSON.parse(readFileSync(new URL("../test-vectors/assurance-policy/vectors.json", import.meta.url), "utf8")) as {
      cases: Array<{ name: string; change: AssurancePolicyChange; canonical: string; digest: string }>;
    };
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const v of vectors.cases) {
      expect(new TextDecoder().decode(canonicalAssurancePolicyChange(v.change)), v.name).toBe(v.canonical);
      expect(assurancePolicyDigest(v.change), v.name).toBe(v.digest);
    }
  });
});
