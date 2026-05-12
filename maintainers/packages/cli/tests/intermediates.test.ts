import { describe, expect, it } from "vitest";
import { _internal } from "../src/commands/endorsement.js";

const { resolveIntermediates, expectCommitHash } = _internal;

describe("resolveIntermediates", () => {
  it("inline csv yields the parsed list", () => {
    const out = resolveIntermediates("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      previousCommit: null,
    });
    expect(out).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("`auto` without previousCommit returns [commit]", () => {
    const out = resolveIntermediates("auto", {
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      previousCommit: null,
    });
    expect(out).toEqual(["cccccccccccccccccccccccccccccccccccccccc"]);
  });

  it("`auto` with previousCommit shells to git via the injected runner", () => {
    const out = resolveIntermediates("auto", {
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      previousCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gitRunner: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ncccccccccccccccccccccccccccccccccccccccc\n",
    });
    expect(out).toEqual([
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccccccccccc",
    ]);
  });

  it("normalizes uppercase hex to lowercase", () => {
    const out = resolveIntermediates("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", {
      commit: "x",
      previousCommit: null,
    });
    expect(out).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });
});

describe("expectCommitHash", () => {
  it("accepts 40 lower-case hex chars after normalization", () => {
    expect(expectCommitHash("ABCDEF" + "0".repeat(34), "x")).toBe("abcdef" + "0".repeat(34));
  });

  it("rejects short input", () => {
    expect(() => expectCommitHash("abc", "x")).toThrow();
  });

  it("rejects non-hex input", () => {
    expect(() => expectCommitHash("z".repeat(40), "x")).toThrow();
  });
});
