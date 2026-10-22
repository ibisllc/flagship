import { describe, expect, it } from "vitest";
import {
  PASSING_GRADE_FLOOR,
  SCAN_ERROR_GRADE,
  computeGrade,
  foldSourceFindings,
  gradeScanError,
  isPassingGrade,
  worseGrade,
  type CustomCheckResult,
  type Grade,
  type TrivyResult,
} from "../src/grade.js";

const NO_VULNS: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
const NO_CHECKS: CustomCheckResult[] = [];
const ALL_GRADES: Grade[] = ["A", "B", "C", "D", "F"];

describe("A–F policy boundaries (every threshold)", () => {
  it("0 HIGH + 0 warn ⇒ A (the only passing-clean grade)", () => {
    expect(computeGrade(NO_VULNS, NO_CHECKS).grade).toBe("A");
  });

  it("HIGH boundary 2→3 flips B→C", () => {
    expect(computeGrade({ ...NO_VULNS, HIGH: 2 }, NO_CHECKS).grade).toBe("B");
    expect(computeGrade({ ...NO_VULNS, HIGH: 3 }, NO_CHECKS).grade).toBe("C");
  });

  it("HIGH 6 with 0 warns is still C; D needs HIGH>5 AND warns>1", () => {
    // computeGrade rule: `trivy.HIGH <= 5 || warnCount <= 1` ⇒ C.
    // So 6 HIGH + 0 warns satisfies the warn arm ⇒ C, not D.
    expect(computeGrade({ ...NO_VULNS, HIGH: 5 }, NO_CHECKS).grade).toBe("C");
    expect(computeGrade({ ...NO_VULNS, HIGH: 6 }, NO_CHECKS).grade).toBe("C");
    // D requires BOTH arms false: >5 HIGH AND >1 warn.
    expect(
      computeGrade({ ...NO_VULNS, HIGH: 6 }, [
        { id: "w1", level: "warn", message: "x" },
        { id: "w2", level: "warn", message: "y" },
      ]).grade,
    ).toBe("D");
  });

  it("warns alone stay C until HIGH also exceeds 5 (worst-dominates floor)", () => {
    expect(
      computeGrade(NO_VULNS, [{ id: "w1", level: "warn", message: "x" }]).grade,
    ).toBe("C");
    // 2 warns + clean Trivy: HIGH(0) <= 5 keeps it at C, not D.
    expect(
      computeGrade(NO_VULNS, [
        { id: "w1", level: "warn", message: "x" },
        { id: "w2", level: "warn", message: "y" },
      ]).grade,
    ).toBe("C");
  });

  it("MEDIUM/LOW alone never beats A nor drops it", () => {
    expect(computeGrade({ ...NO_VULNS, MEDIUM: 99, LOW: 99 }, NO_CHECKS).grade).toBe("A");
  });
});

describe("worst-finding-dominates", () => {
  it("a single CRITICAL caps at F regardless of everything else clean", () => {
    expect(computeGrade({ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 }, NO_CHECKS).grade).toBe("F");
  });

  it("a no-ship custom check forces F even with a pristine Trivy result", () => {
    const r = computeGrade(NO_VULNS, [
      { id: "network-allowlist-wildcard", level: "no-ship", message: "wildcard host" },
    ]);
    expect(r.grade).toBe("F");
    expect(r.reasons.join(" ")).toMatch(/no-ship/);
  });

  it("CRITICAL dominates even when HIGH count would say B", () => {
    expect(computeGrade({ CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0 }, NO_CHECKS).grade).toBe("F");
  });

  it("worseGrade returns the lower of two grades", () => {
    expect(worseGrade("A", "F")).toBe("F");
    expect(worseGrade("C", "B")).toBe("C");
    expect(worseGrade("A", "A")).toBe("A");
  });
});

describe("foldSourceFindings — npm audit + semgrep merge (worst-dominates)", () => {
  it("a CRITICAL npm advisory caps the grade at F just like a Trivy CRITICAL", () => {
    const folded = foldSourceFindings(
      NO_VULNS,
      { CRITICAL: 1, HIGH: 0, MODERATE: 0, LOW: 0 },
      undefined,
      NO_CHECKS,
    );
    expect(computeGrade(folded.trivy, folded.customChecks).grade).toBe("F");
  });

  it("npm HIGH advisories add to Trivy HIGH for tiering", () => {
    const folded = foldSourceFindings(
      { ...NO_VULNS, HIGH: 2 },
      { CRITICAL: 0, HIGH: 2, MODERATE: 0, LOW: 0 },
      undefined,
      NO_CHECKS,
    );
    // 2 + 2 = 4 HIGH ⇒ C, not B.
    expect(computeGrade(folded.trivy, folded.customChecks).grade).toBe("C");
  });

  it("a semgrep ERROR is a no-ship ⇒ F", () => {
    const folded = foldSourceFindings(
      NO_VULNS,
      undefined,
      { ERROR: 1, WARNING: 0, INFO: 0 },
      NO_CHECKS,
    );
    expect(computeGrade(folded.trivy, folded.customChecks).grade).toBe("F");
  });

  it("a semgrep WARNING is a one-notch warn (A→C with clean else)", () => {
    const folded = foldSourceFindings(
      NO_VULNS,
      undefined,
      { ERROR: 0, WARNING: 1, INFO: 5 },
      NO_CHECKS,
    );
    expect(computeGrade(folded.trivy, folded.customChecks).grade).toBe("C");
  });

  it("npm MODERATE→MEDIUM, LOW→LOW do not drop a clean A", () => {
    const folded = foldSourceFindings(
      NO_VULNS,
      { CRITICAL: 0, HIGH: 0, MODERATE: 9, LOW: 9 },
      { ERROR: 0, WARNING: 0, INFO: 0 },
      NO_CHECKS,
    );
    expect(computeGrade(folded.trivy, folded.customChecks).grade).toBe("A");
  });
});

describe("FAIL-CLOSED — a scan that did not complete is NEVER a pass", () => {
  it("SCAN_ERROR_GRADE is F", () => {
    expect(SCAN_ERROR_GRADE).toBe("F");
  });

  it.each([
    "clone-failed",
    "tool-timeout",
    "clone-hash-mismatch",
    "sandbox-breach",
    "runner-threw",
  ])("gradeScanError(%s) ⇒ F and NOT a passing grade", (reason) => {
    const bd = gradeScanError(reason);
    expect(bd.grade).toBe("F");
    expect(isPassingGrade(bd.grade)).toBe(false);
    expect(bd.scanError).toBe(reason);
    expect(bd.customChecks.some((c) => c.level === "no-ship")).toBe(true);
  });

  it("gradeScanError can never return better than F for ANY string", () => {
    for (const s of ["", "ok", "A", "clean", "passed", "success", "no issues"]) {
      expect(gradeScanError(s).grade).toBe("F");
      expect(isPassingGrade(gradeScanError(s).grade)).toBe(false);
    }
  });
});

describe("passing-grade floor", () => {
  it("PASSING_GRADE_FLOOR is C", () => {
    expect(PASSING_GRADE_FLOOR).toBe("C");
  });
  it("A,B,C pass; D,F do not", () => {
    expect(ALL_GRADES.filter(isPassingGrade)).toEqual(["A", "B", "C"]);
  });
});
