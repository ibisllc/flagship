import { describe, expect, it } from "vitest";
import {
  CO_MANAGER_CAPS,
  coManagerCapFor,
  coManagerCapRefusal,
  coManagerPlanOf,
  coManagerRoomFor,
} from "../src/coManagerCap.js";
import { PLAN_TIERS } from "../src/planAttestation.js";

describe("co-manager caps (owner decision 2026-11-14)", () => {
  it("Free 5, Pro 10, Pro Max 25, Enterprise unlimited", () => {
    expect(CO_MANAGER_CAPS).toEqual({ free: 5, hobby: 10, maker: 25, enterprise: null });
    expect(coManagerCapFor("free")).toBe(5);
    expect(coManagerCapFor("hobby")).toBe(10);
    expect(coManagerCapFor("maker")).toBe(25);
    expect(coManagerCapFor("enterprise")).toBeNull();
  });

  it("every plan an attestation can name has a cap; anything else counts as Free", () => {
    for (const t of PLAN_TIERS) expect(coManagerPlanOf(t)).toBe(t);
    for (const t of [null, undefined, "", "pro", "HOBBY", "unknown"]) {
      expect(coManagerPlanOf(t)).toBe("free");
      expect(coManagerCapFor(t)).toBe(5);
    }
  });

  it("an account at or over its cap adds nobody; unlimited always has room", () => {
    expect(coManagerRoomFor({ count: 4, cap: 5, plan: "free" })).toBe(true);
    expect(coManagerRoomFor({ count: 5, cap: 5, plan: "free" })).toBe(false);
    expect(coManagerRoomFor({ count: 9, cap: 5, plan: "free" })).toBe(false);
    expect(coManagerRoomFor({ count: 500, cap: null, plan: "enterprise" })).toBe(true);
  });

  it("the refusal carries the code, the count, the cap and the plan", () => {
    expect(coManagerCapRefusal({ count: 10, cap: 10, plan: "hobby" })).toEqual({
      error: "co-manager-cap",
      code: "co-manager-cap",
      count: 10,
      cap: 10,
      plan: "hobby",
    });
  });
});
