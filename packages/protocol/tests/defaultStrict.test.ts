import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRICT_ACKNOWLEDGED_LOSS,
  advanceRollout,
  applyPolicyChange,
  defaultStrictChange,
  defaultStrictEligible,
  legacyPolicyState,
  strictInForce,
  type PolicyState,
} from "../src/assurancePolicy.js";

const scope = { kind: "installation", id: "home.plucky-avocet" } as const;
const ok = () => ({ suiteVerified: true, signerActive: true });
const prepared = (): PolicyState => {
  const ev = { capabilityAdvertised: true, boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true };
  return advanceRollout(advanceRollout(legacyPolicyState(scope), "capable", ev), "prepared", ev);
};
const args = (state: PolicyState) => ({ account: "Plucky-Avocet", state, affectedPeersDigest: "a".repeat(64), signerKind: "admin-root" as const, signerKeyId: "B".repeat(64), issuedAt: 1 });

describe("strict by default", () => {
  it("signs strict with only the browser exception, and the box's rules accept it", () => {
    const c = defaultStrictChange(args(prepared()))!;
    expect(c.acknowledgedLoss).toEqual(["browser-without-pq-authentication"]);
    expect(DEFAULT_STRICT_ACKNOWLEDGED_LOSS).toEqual(c.acknowledgedLoss);
    expect(c.account).toBe("plucky-avocet");
    expect(c.signerKeyId).toBe("b".repeat(64));
    expect(c.suite).toBe("hybrid-ed25519-mldsa65/v1");
    const s = applyPolicyChange(prepared(), c, ok);
    expect(strictInForce(s)).toBe(true);
  });

  it("is refused before the server is prepared, so readiness decides", () => {
    const c = defaultStrictChange(args(legacyPolicyState(scope)))!;
    expect(() => applyPolicyChange(legacyPolicyState(scope), c, ok)).toThrow(/not ready/);
  });

  it("never touches a scope an owner already changed", () => {
    const on = applyPolicyChange(prepared(), defaultStrictChange(args(prepared()))!, ok);
    expect(defaultStrictEligible(on)).toBe(false);
    expect(defaultStrictChange(args(on))).toBeNull();
    const left = { ...on, profile: "compatibility" as const, generation: 2 };
    expect(defaultStrictEligible(left)).toBe(false);
    expect(defaultStrictEligible(prepared())).toBe(true);
  });
});
