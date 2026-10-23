// The browser's port of the assurance policy (lib/assurancePolicy.js) against the shared vectors
// packages/protocol/test-vectors/assurance-policy, and its chain replay against the TS original.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPolicyChange as tsApply,
  legacyPolicyState as tsLegacy,
  type AssurancePolicyChange,
} from "@flagship/protocol";
import {
  GENESIS_DIGEST,
  PolicyError,
  adoptStoredState,
  applyPolicyChange,
  assurancePolicyDigest,
  canonicalAssurancePolicyChange,
  legacyPolicyState,
  replayPolicyChain,
  strictInForce,
} from "../public/webapp/lib/assurancePolicy.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/assurance-policy/vectors.json"), "utf8"));
const ok = () => ({ suiteVerified: true, signerActive: true });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PolicyError) return e.code;
    throw e;
  }
  return "ok";
};

describe("assurance policy in the webapp: shared vectors", () => {
  for (const c of V.cases) {
    it(c.name, () => {
      expect(new TextDecoder().decode(canonicalAssurancePolicyChange(c.change))).toBe(c.canonical);
      expect(assurancePolicyDigest(c.change)).toBe(c.digest);
    });
  }
});

describe("applying and replaying changes", () => {
  const scope = { kind: "installation", id: "home.alice.flagship.services" };
  const one: AssurancePolicyChange = {
    account: "alice", scope: scope as AssurancePolicyChange["scope"], prior: "compatibility", next: "strict", generation: 1, prevDigest: GENESIS_DIGEST,
    affectedPeersDigest: "aa".repeat(32), acknowledgedLoss: [], signerKind: "admin-device", signerKeyId: "ab".repeat(32), suite: "hybrid-ed25519-mldsa65/v1", issuedAt: 1,
  };
  const back = { ...one, prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], issuedAt: 2 } as AssurancePolicyChange;
  const prepared = { ...legacyPolicyState(scope), rollout: "prepared" };

  it("matches the TS original step by step", () => {
    const tsPrepared = { ...tsLegacy(one.scope), rollout: "prepared" as const };
    const a = applyPolicyChange(prepared, one, ok);
    expect(a).toEqual(tsApply(tsPrepared, one, ok));
    expect(strictInForce(a)).toBe(true);
    expect(applyPolicyChange(a, back, ok)).toEqual(tsApply(tsApply(tsPrepared, one, ok), back, ok));
  });

  it("refuses what the TS original refuses", () => {
    expect(code(() => applyPolicyChange(legacyPolicyState(scope), one, ok))).toBe("not-prepared");
    expect(code(() => applyPolicyChange(prepared, { ...one, suite: "ed25519/v1" }, ok))).toBe("classical-signer-refused");
    expect(code(() => applyPolicyChange(prepared, { ...one, signerKind: "box" }, ok))).toBe("not-owner-authority");
    expect(code(() => applyPolicyChange(prepared, one, () => ({ suiteVerified: false, signerActive: true })))).toBe("bad-signature");
    expect(code(() => applyPolicyChange(prepared, { ...one, generation: 2 }, ok))).toBe("stale-generation");
    const a = applyPolicyChange(prepared, one, ok);
    expect(code(() => applyPolicyChange(a, { ...back, acknowledgedLoss: [] }, ok))).toBe("loss-not-acknowledged");
    expect(code(() => adoptStoredState(a, prepared))).toBe("rollback-refused");
  });

  it("replays a chain up to the first change that fails", () => {
    const chain = [{ change: one, signature: { suite: one.suite, signature: "" } }, { change: back, signature: { suite: back.suite, signature: "" } }];
    const all = replayPolicyChain(scope, chain, { prepared: () => true, check: ok });
    expect(all).toMatchObject({ profile: "compatibility", generation: 2, enforcedEver: true });
    const firstOnly = replayPolicyChain(scope, chain, { prepared: () => true, check: (_m: Uint8Array, c: AssurancePolicyChange) => ({ suiteVerified: c.generation === 1, signerActive: true }) });
    expect(firstOnly).toMatchObject({ profile: "strict", generation: 1 });
    expect(replayPolicyChain(scope, chain, { prepared: () => false, check: ok }).generation).toBe(0);
  });
});
