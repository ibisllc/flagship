import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptSecurityNotice, parseSecurityNotice, verifySecurityNotice } from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/security-notice/pq-vectors.json", import.meta.url), "utf8"));

const verdict = (notice: unknown, pin: string[]): string => {
  const n = parseSecurityNotice(notice);
  if (!n) return "malformed";
  const v = verifySecurityNotice(n, V.authorityKeys, pin);
  return v.ok ? "ok" : v.reason;
};

describe("security notice PQ half", () => {
  for (const c of V.cases) {
    it(`${c.name}: ${c.expect.emptyPin} with the pin empty, ${c.expect.pinned} once it is set`, () => {
      expect(verdict(c.notice, [])).toBe(c.expect.emptyPin);
      expect(verdict(c.notice, V.pinnedKeyIds)).toBe(c.expect.pinned);
    });
  }

  it("a pinned client keeps its store when only a classical notice arrives", () => {
    const store = { highestSeq: 0, notice: null };
    const classical = V.cases.find((c: { name: string }) => c.name === "classical-only").notice;
    expect(acceptSecurityNotice(store, classical, V.authorityKeys, V.pinnedKeyIds)).toEqual({ store, refused: "pq-missing" });
    const hybrid = V.cases.find((c: { name: string }) => c.name === "hybrid").notice;
    expect(acceptSecurityNotice(store, hybrid, V.authorityKeys, V.pinnedKeyIds).refused).toBeNull();
  });

  it("parsing keeps the PQ half so a stored notice is re-verified with it", () => {
    const hybrid = V.cases.find((c: { name: string }) => c.name === "hybrid").notice;
    expect(parseSecurityNotice(hybrid)?.pq?.binding.role).toBe("release-key");
  });
});
