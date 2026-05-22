import { describe, expect, it } from "vitest";
import {
  PROVISION_PHASES,
  PROVISION_LADDER,
  PROVISION_STEP_GROUPS,
  provisionFraction,
  provisionStepStates,
  PROVISION_PHASE_TITLES,
} from "../src/index.js";

describe("provisionFraction", () => {
  it("is 0 for null / unknown / empty", () => {
    expect(provisionFraction(null)).toBe(0);
    expect(provisionFraction(undefined)).toBe(0);
    expect(provisionFraction("")).toBe(0);
    expect(provisionFraction("not-a-phase")).toBe(0);
  });

  it("is exactly 1 for ready", () => {
    expect(provisionFraction("ready")).toBe(1);
  });

  it("is 0 for a bare failed (no pre-failure hint)", () => {
    expect(provisionFraction("failed")).toBe(0);
  });

  it("is strictly monotonically increasing along the ladder", () => {
    let prev = -1;
    for (const phase of PROVISION_LADDER) {
      const f = provisionFraction(phase);
      expect(f).toBeGreaterThan(prev);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it("ladder excludes the terminal failed phase", () => {
    expect(PROVISION_LADDER).not.toContain("failed");
    expect(PROVISION_LADDER.length).toBe(PROVISION_PHASES.length - 1);
  });

  it("boot is the smallest non-zero fraction; ready the largest", () => {
    expect(provisionFraction("boot")).toBeCloseTo(1 / PROVISION_LADDER.length, 6);
    expect(provisionFraction("ready")).toBe(1);
  });
});

describe("PROVISION_STEP_GROUPS", () => {
  it("covers every non-terminal phase exactly once, in ladder order", () => {
    const flattened = PROVISION_STEP_GROUPS.flatMap((g) => g.phases);
    expect(flattened).toEqual([...PROVISION_LADDER]);
  });

  it("has the four expected groups in order", () => {
    expect(PROVISION_STEP_GROUPS.map((g) => g.key)).toEqual([
      "booting",
      "registering",
      "securing",
      "ready",
    ]);
    expect(PROVISION_STEP_GROUPS.map((g) => g.label)).toEqual([
      "Booting",
      "Registering",
      "Securing (TLS certificate)",
      "Ready",
    ]);
  });

  it("groups the ACME sub-phases under securing", () => {
    const securing = PROVISION_STEP_GROUPS.find((g) => g.key === "securing")!;
    expect(securing.phases).toContain("acme-order");
    expect(securing.phases).toContain("dns01-propagation-wait");
    expect(securing.phases).toContain("acme-validating");
    expect(securing.phases).toContain("cert-issued");
  });
});

describe("provisionStepStates", () => {
  it("null phase → first group active, rest pending, no detail", () => {
    const v = provisionStepStates(null);
    expect(v.map((s) => s.state)).toEqual(["active", "pending", "pending", "pending"]);
    expect(v[0]!.detail).toBeNull();
  });

  it("ready → all groups done", () => {
    const v = provisionStepStates("ready");
    expect(v.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
  });

  it("an ACME sub-phase activates securing with its fine-grained title", () => {
    const v = provisionStepStates("dns01-propagation-wait");
    expect(v.map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
    const securing = v.find((s) => s.key === "securing")!;
    expect(securing.detail).toBe(PROVISION_PHASE_TITLES["dns01-propagation-wait"]);
    expect(securing.detail).toBe("Waiting for DNS");
  });

  it("registered activates registering, booting done", () => {
    const v = provisionStepStates("registered");
    expect(v.map((s) => s.state)).toEqual(["done", "active", "pending", "pending"]);
  });

  it("failed with a prevPhase hint marks the owning group failed + carries lastError", () => {
    const v = provisionStepStates("failed", "rate limited by ACME", "acme-validating");
    expect(v.map((s) => s.state)).toEqual(["done", "done", "failed", "pending"]);
    const securing = v.find((s) => s.key === "securing")!;
    expect(securing.detail).toBe("rate limited by ACME");
  });

  it("bare failed (no hint) fails the first group conservatively", () => {
    const v = provisionStepStates("failed", "boom");
    expect(v[0]!.state).toBe("failed");
    expect(v[0]!.detail).toBe("boom");
    expect(v.slice(1).map((s) => s.state)).toEqual(["pending", "pending", "pending"]);
  });
});
