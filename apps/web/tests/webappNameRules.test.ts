// The webapp's copy of the voi.ci namespace format (lib/nameRules.js, docs/voici-namespace-spec.md D12) against the
// shared vectors, and the one set of refusal sentences the username and link-name fields use.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidName, nameProblemText, nameRefusalText, nameTakenText, voiciNameKey, voiciNameProblem } from "../public/webapp/lib/nameRules.js";

const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/voici-name/vectors.json", import.meta.url), "utf8"));

describe("webapp name rules", () => {
  it("give the pinned answers (problem and safety key)", () => {
    for (const n of V.names) {
      expect(voiciNameProblem(n.typed), n.typed).toBe(n.problem);
      if (n.problem === null) expect(voiciNameKey(n.typed), n.typed).toBe(n.key);
    }
  });

  it("take a canonical name only (lower case, D12)", () => {
    expect(isValidName("50cent")).toBe(true);
    expect(isValidName("plucky-avocet")).toBe(true);
    expect(isValidName("Plucky-Avocet")).toBe(false);
    expect(isValidName("a".repeat(64))).toBe(false);
  });

  it("turn .com's refusals into the shared sentences", () => {
    expect(nameRefusalText({ code: "taken" })).toBe("Taken or too similar to an existing name");
    expect(nameRefusalText({ code: "reserved" })).toBe(nameTakenText());
    expect(nameRefusalText({ code: "invalid", problem: "too-short" })).toBe("At least 3 characters");
    expect(nameRefusalText({ code: "invalid", problem: "too-long" })).toBe("At most 63 characters");
    expect(nameRefusalText({ code: "invalid", problem: "hyphens" })).toBe("No hyphen at the start or end, or two in a row");
    expect(nameRefusalText({ code: "invalid", problem: "characters" })).toBe("Letters, numbers and hyphens only");
    expect(nameRefusalText({ code: "rate-limited" })).toBeNull();
    expect(nameProblemText(undefined)).toBe("Letters, numbers and hyphens only");
  });
});
