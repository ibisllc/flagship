import { describe, expect, it } from "vitest";
import {
  CANARY_STAGES,
  canaryCohort,
  canaryVerdict,
  inRolloutCohort,
  nextCanaryStage,
  parseUpdateReceipt,
  receiptArch,
  receiptOutcome,
  type UpdateReceipt,
} from "../src/index.js";

const C = "0123456789abcdef0123456789abcdef01234567";
const good: UpdateReceipt = {
  format: 1,
  release: C,
  cohort: "5",
  healthGate: "pass",
  rolledBack: false,
  arch: "amd64",
  stack: "classic",
  nonce: "00112233445566778899aabbccddeeff",
};

describe("update receipts", () => {
  it("parses exactly the fixed fields", () => {
    expect(parseUpdateReceipt(good)).toEqual(good);
    expect(parseUpdateReceipt({ ...good, healthGate: "fail", rolledBack: true })).not.toBeNull();
    expect(parseUpdateReceipt({ ...good, healthGate: "fail", rolledBack: false })).not.toBeNull();
  });

  it("refuses an extra field, so nothing identifying can ride along", () => {
    for (const extra of ["server", "username", "ip", "previousCommit", "at", "bootAttempts"]) {
      expect(parseUpdateReceipt({ ...good, [extra]: "x" }), extra).toBeNull();
    }
  });

  it("refuses malformed values and the impossible pass-and-rolled-back", () => {
    expect(parseUpdateReceipt({ ...good, rolledBack: true })).toBeNull();
    expect(parseUpdateReceipt({ ...good, release: "main" })).toBeNull();
    expect(parseUpdateReceipt({ ...good, release: C.slice(0, 12) })).toBeNull();
    expect(parseUpdateReceipt({ ...good, cohort: "7" })).toBeNull();
    expect(parseUpdateReceipt({ ...good, nonce: "short" })).toBeNull();
    expect(parseUpdateReceipt({ ...good, format: 2 })).toBeNull();
    expect(parseUpdateReceipt({ ...good, arch: "riscv" })).toBeNull();
    expect(parseUpdateReceipt({ ...good, stack: "docker" })).toBeNull();
    expect(parseUpdateReceipt({ ...good, rolledBack: "no" })).toBeNull();
    expect(parseUpdateReceipt(null)).toBeNull();
    expect(parseUpdateReceipt([good])).toBeNull();
  });

  it("maps a receipt to passed, rolled back or stuck", () => {
    expect(receiptOutcome(good)).toBe("passed");
    expect(receiptOutcome({ healthGate: "fail", rolledBack: true })).toBe("rolled-back");
    expect(receiptOutcome({ healthGate: "fail", rolledBack: false })).toBe("stuck");
  });

  it("puts a box in the smallest stage that already admits it, matching the catalog gate", () => {
    for (let i = 0; i < 400; i++) {
      const salt = `box-secret-${i}`;
      const cohort = Number(canaryCohort(salt, C));
      expect(CANARY_STAGES).toContain(cohort);
      // the gate admits this box at its own stage and never at the stage below
      expect(inRolloutCohort(salt, { commit: C, rolloutPercent: cohort })).toBe(true);
      const below = CANARY_STAGES[CANARY_STAGES.indexOf(cohort as (typeof CANARY_STAGES)[number]) - 1];
      if (below !== undefined) expect(inRolloutCohort(salt, { commit: C, rolloutPercent: below })).toBe(false);
    }
  });

  it("gives one box unrelated cohorts for different releases (no cross-release linkage)", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    let same = 0;
    for (let i = 0; i < 400; i++) if (canaryCohort(`s${i}`, C) === canaryCohort(`s${i}`, other)) same++;
    // both are mostly "100"; what matters is that they are not the same function of the box
    expect(same).toBeLessThan(400);
  });

  it("reads the CPU architecture coarsely", () => {
    expect(receiptArch("x64")).toBe("amd64");
    expect(receiptArch("arm64")).toBe("arm64");
    expect(receiptArch("ppc64")).toBe("other");
  });
});

describe("canary verdict", () => {
  const H = 3_600_000;
  const base = { percent: 5, openedAt: 0, now: 49 * H };
  it("widens along the ladder once the stage is old enough and has receipts", () => {
    expect(canaryVerdict({ ...base, totals: { passed: 3, rolledBack: 0, stuck: 0 } })).toMatchObject({ action: "widen", next: 20 });
    expect(nextCanaryStage(0)).toBe(1);
    expect(nextCanaryStage(50)).toBe(100);
    expect(nextCanaryStage(100)).toBeNull();
  });

  it("waits for time and for a denominator", () => {
    expect(canaryVerdict({ ...base, now: 10 * H, totals: { passed: 9, rolledBack: 0, stuck: 0 } }).action).toBe("wait");
    expect(canaryVerdict({ ...base, totals: { passed: 2, rolledBack: 0, stuck: 0 } }).action).toBe("wait");
    expect(canaryVerdict({ ...base, openedAt: null, totals: { passed: 9, rolledBack: 0, stuck: 0 } }).action).toBe("wait");
  });

  it("holds on one rollback and stops on two, or on a box that could not roll back", () => {
    expect(canaryVerdict({ ...base, totals: { passed: 9, rolledBack: 1, stuck: 0 } }).action).toBe("hold");
    expect(canaryVerdict({ ...base, totals: { passed: 9, rolledBack: 2, stuck: 0 } }).action).toBe("stop");
    expect(canaryVerdict({ ...base, totals: { passed: 90, rolledBack: 0, stuck: 1 } }).action).toBe("stop");
  });

  it("stops on a rollback share above the bound once the denominator is large", () => {
    const policy = { minReceipts: 3, minHours: 48, stopRollbacks: 100, stopRollbackRate: 0.05 };
    expect(canaryVerdict({ ...base, policy, totals: { passed: 30, rolledBack: 3, stuck: 0 } }).action).toBe("stop");
    expect(canaryVerdict({ ...base, policy, totals: { passed: 10, rolledBack: 3, stuck: 0 } }).action).toBe("hold");
  });

  it("judges each profile on its own, so arm64 failures cannot hide behind amd64", () => {
    const v = canaryVerdict({
      ...base,
      totals: { passed: 1000, rolledBack: 25, stuck: 0 },
      byProfile: { "amd64/classic": { passed: 990, rolledBack: 0, stuck: 0 }, "arm64/arch-v2": { passed: 10, rolledBack: 25, stuck: 0 } },
      policy: { minReceipts: 3, minHours: 48, stopRollbacks: 100, stopRollbackRate: 0.05 },
    });
    expect(v.action).toBe("stop");
    expect(v.reason).toContain("arm64/arch-v2");
  });

  it("is complete at 100 percent with nothing wrong", () => {
    expect(canaryVerdict({ ...base, percent: 100, totals: { passed: 3, rolledBack: 0, stuck: 0 } }).action).toBe("complete");
  });
});
