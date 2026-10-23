import { describe, expect, it } from "vitest";
import { assertNodeFloor, nodeMeetsFloor } from "../src/nodeFloor.js";

describe("nodeMeetsFloor", () => {
  it("compares major, minor and patch numerically", () => {
    expect(nodeMeetsFloor("24.22.1", "24.22.1")).toBe(true);
    expect(nodeMeetsFloor("v24.22.2", "24.22.1")).toBe(true);
    expect(nodeMeetsFloor("24.100.0", "24.22.1")).toBe(true);
    expect(nodeMeetsFloor("25.0.0", "24.22.1")).toBe(true);
    expect(nodeMeetsFloor("24.22.0", "24.22.1")).toBe(false);
    expect(nodeMeetsFloor("24.9.9", "24.22.1")).toBe(false);
    expect(nodeMeetsFloor("20.19.0", "24.22.1")).toBe(false);
  });
  it("fails closed on anything it cannot parse", () => {
    expect(nodeMeetsFloor("", "24.22.1")).toBe(false);
    expect(nodeMeetsFloor("24", "24.22.1")).toBe(false);
    expect(nodeMeetsFloor("24.x.1", "24.22.1")).toBe(false);
  });
});

describe("assertNodeFloor", () => {
  it("passes at the floor and refuses below it", () => {
    expect(() => assertNodeFloor("24.22.1", "24.22.1", {})).not.toThrow();
    expect(() => assertNodeFloor("20.18.0", "24.22.1", {})).toThrow(/below the security floor/);
  });
  it("lets only the explicit developer override through, and says so", () => {
    const logs: string[] = [];
    expect(() => assertNodeFloor("20.18.0", "24.22.1", { FLAGSHIP_ALLOW_OLD_NODE: "1" }, (m) => logs.push(m))).not.toThrow();
    expect(logs.join()).toContain("developer machines only");
    expect(() => assertNodeFloor("20.18.0", "24.22.1", { FLAGSHIP_ALLOW_OLD_NODE: "true" })).toThrow();
  });
});
