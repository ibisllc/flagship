import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkIdentityAssertion } from "../src/identityAssertion.js";

const vectors = JSON.parse(readFileSync(join(__dirname, "../test-vectors/identity-assertion/vectors.json"), "utf8")) as {
  cases: { msg: string; expect: string | null }[];
};

describe("identity assertions the box may sign", () => {
  it.each(vectors.cases)("$msg → $expect", ({ msg, expect: want }) => {
    expect(checkIdentityAssertion(msg)).toBe(want);
    expect(checkIdentityAssertion(new TextEncoder().encode(msg))).toBe(want);
  });
});
