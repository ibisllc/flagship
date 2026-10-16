import { describe, expect, it } from "vitest";
import { applyAssignments, parseArgs } from "./inference-settings.mjs";

const IDS = ["low", "medium", "medium-vision", "high"];

describe("inference-settings CLI", () => {
  it("needs a note for every change", () => {
    expect(parseArgs([])).toMatchObject({ command: "show" });
    expect(() => parseArgs(["set", "high.multiplier=4"])).toThrow(/--note/);
    expect(parseArgs(["set", "high.multiplier=4", "--note", "why", "--dry-run"])).toMatchObject({
      command: "set",
      assignments: ["high.multiplier=4"],
      note: "why",
      dryRun: true,
    });
    expect(() => parseArgs(["frob"])).toThrow(/unknown command/);
  });

  it("applies set and unset to the stored settings, credits as tokens", () => {
    const stored = { models: { low: { enabled: false } }, allowance: { starterTokens: 3_000_000 } };
    const next = applyAssignments(
      stored,
      ["default=high", "low.enabled=true", "high.multiplier=4.5", "high.descriptor=Strongest", "weeklyCredits=750", "endsAt=none"],
      "set",
      IDS,
    );
    expect(next).toEqual({
      defaultModel: "high",
      models: { low: { enabled: true }, high: { multiplier: 4.5, descriptor: "Strongest" } },
      allowance: { starterTokens: 3_000_000, weeklyTokens: 750_000, endsAt: null },
    });
    expect(stored.models.low.enabled).toBe(false);
    expect(applyAssignments(next, ["low.enabled", "high.multiplier", "high.descriptor", "starterCredits", "weeklyTokens", "endsAt"], "unset", IDS)).toEqual({
      defaultModel: "high",
    });
  });

  it("refuses unknown keys and models", () => {
    expect(() => applyAssignments({}, ["gpt.enabled=true"], "set", IDS)).toThrow(/no model "gpt"/);
    expect(() => applyAssignments({}, ["high.price=1"], "set", IDS)).toThrow(/not "price"/);
    expect(() => applyAssignments({}, ["monthly=5"], "set", IDS)).toThrow(/unknown key/);
    expect(() => applyAssignments({}, ["high.enabled=maybe"], "set", IDS)).toThrow(/true or false/);
    expect(() => applyAssignments({}, ["weeklyCredits"], "set", IDS)).toThrow(/key=value/);
  });
});
