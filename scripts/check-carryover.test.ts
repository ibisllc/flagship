import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { atOrAbove, openCarryovers } from "./check-carryover.mjs";

describe("carry-over runbooks", () => {
  it("compares product versions", () => {
    expect(atOrAbove("0.5", "0.5")).toBe(true);
    expect(atOrAbove("0.10", "0.5")).toBe(true);
    expect(atOrAbove("0.4", "0.5")).toBe(false);
    expect(atOrAbove("1.0", "0.5")).toBe(true);
  });

  it("no runbook due for this product version is still open", () => {
    const open = openCarryovers() as { file: string; before: string; status: string }[];
    expect(open.map((o) => `${o.file} (before ${o.before}, ${o.status})`)).toEqual([]);
  });
});
