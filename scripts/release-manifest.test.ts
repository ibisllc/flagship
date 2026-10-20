import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { checks, evaluate, globToRegExp, LUKS_FIX_COMMIT, matches, publishedBuildCheck } from "./release-manifest.mjs";
import map from "../release/freeze-map.json";

describe("release-manifest", () => {
  it("matches globs the way the freeze map is written", () => {
    expect(matches(["apps/builder-windows/**"], "apps/builder-windows/src/a/b.ts")).toBe(true);
    expect(matches(["apps/builder-windows/**"], "apps/builder-mac/src/a.ts")).toBe(false);
    expect(matches(["apps/mobile/shared/Sources/**/*Pairing*"], "apps/mobile/shared/Sources/FlagshipCore/DevicePairingClient.swift")).toBe(true);
    expect(matches(["fly.toml"], "fly.toml")).toBe(true);
    expect(matches(["fly.toml"], "fly.gym.toml")).toBe(false);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
  });

  it("says missing, ok and stale per receipt, naming the files that changed", () => {
    const m = { receipts: { a: { label: "A", paths: ["x/**"] }, b: { label: "B", paths: ["y/**"] }, c: { label: "C", paths: ["z/**"], optional: true } } };
    const receipts = [{ id: "a", commit: "c1", at: "2026-10-01T00:00:00Z" }, { id: "b", commit: "c1", at: "2026-10-01T00:00:00Z" }];
    const rows = evaluate(m, receipts, () => ["x/one.ts", "elsewhere.md"]);
    expect(rows.map((r: { id: string; state: string }) => `${r.id}:${r.state}`)).toEqual(["a:STALE", "b:ok", "c:MISSING"]);
    expect(rows[0].changed).toEqual(["x/one.ts"]);
    expect(rows[2].optional).toBe(true);
    // The newest receipt of an id wins.
    const again = evaluate(m, [...receipts, { id: "a", commit: "c2", at: "2026-10-05T00:00:00Z" }], (c: string) => (c === "c2" ? [] : ["x/one.ts"]));
    expect(again[0].state).toBe("ok");
  });

  it("every receipt in the freeze map has a label and at least one path", () => {
    for (const [id, spec] of Object.entries(map.receipts as Record<string, { label: string; paths: string[] }>)) {
      expect(spec.label, id).toBeTruthy();
      expect(spec.paths.length, id).toBeGreaterThan(0);
    }
  });

  it("checks the lease horizon, the schema ledger and the version file from the tree", () => {
    const c = checks(new Date("2026-10-20T00:00:00Z"));
    expect(c.map((x: { id: string }) => x.id)).toEqual(["ca-lease", "schema-ledger", "versions", "published-builds"]);
    expect(c.find((x: { id: string }) => x.id === "schema-ledger").ok).toBe(true);
    expect(checks(new Date("2030-01-01T00:00:00Z")).find((x: { id: string }) => x.id === "ca-lease").ok).toBe(false);
  });

  it("every path in the freeze map matches at least one tracked file (a dead glob would let a change go unnoticed)", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
    const dead: string[] = [];
    for (const [id, spec] of Object.entries(map.receipts as Record<string, { paths: string[] }>)) {
      for (const g of spec.paths) if (!files.some((f) => globToRegExp(g).test(f))) dead.push(`${id}: ${g}`);
    }
    expect(dead).toEqual([]);
  });

  it("fails while a published Studio or appliance was built before the LUKS passphrase fix", () => {
    const after = new Set(["new-tag", "newsha"]);
    const isAncestor = (fix: string, c: string) => fix === LUKS_FIX_COMMIT && after.has(c);
    const ok = publishedBuildCheck([{ what: "Mac", commit: "newsha" }, { what: "Win", commit: "new-tag" }], isAncestor);
    expect(ok.ok).toBe(true);
    const bad = publishedBuildCheck([{ what: "Mac", commit: "oldsha" }, { what: "Win", commit: "new-tag" }, { what: "arm64 appliance", commit: null }], isAncestor);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("Mac");
    expect(bad.detail).toContain("arm64 appliance");
    expect(bad.detail).not.toContain("Win,");
  });
});
