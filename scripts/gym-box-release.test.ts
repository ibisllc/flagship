import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain script module
import { GYM_ARTIFACT_BASE, plan, sequenceFor, writeRelease } from "./gym-box-release.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const NOW = new Date(Date.UTC(2026, 9, 23, 21, 5));

describe("the gym's box release", () => {
  it("a sequence that grows with time", () => {
    expect(sequenceFor(NOW)).toBe(202610232105);
    expect(sequenceFor(new Date(NOW.getTime() + 60_000))).toBeGreaterThan(sequenceFor(NOW));
  });

  it("builds for a tip whose artifact does not exist, with a sequence above the last", () => {
    const p = plan({ head: B, parent: A, changedByHead: ["apps/web/public/webapp/app.js"], current: { commit: A, sequence: 202610231200 }, now: NOW });
    expect(p).toMatchObject({ action: "build", commit: B, sequence: 202610232105 });
    const later = plan({ head: B, parent: A, changedByHead: ["x.ts"], current: { commit: A, sequence: 999999999999999 }, now: NOW });
    expect(later.sequence).toBe(1_000_000_000_000_000);
  });

  it("skips when the tip is its own release commit naming its parent", () => {
    const p = plan({ head: B, parent: A, changedByHead: ["release/box-release.json", "packages/protocol/src/boxReleaseConfig.ts", "apps/mobile/shared/Sources/FlagshipCore/BoxRelease.swift"], current: { commit: A, sequence: 5 }, now: NOW });
    expect(p.action).toBe("skip");
  });

  it("does not skip a release-looking tip that names some other commit, or one that also changed code", () => {
    expect(plan({ head: B, parent: A, changedByHead: ["release/box-release.json"], current: { commit: C, sequence: 5 }, now: NOW }).action).toBe("build");
    expect(plan({ head: B, parent: A, changedByHead: ["release/box-release.json", "packages/server-daemon/src/index.ts"], current: { commit: A, sequence: 5 }, now: NOW }).action).toBe("build");
  });

  it("writes the commit, the sequence and the gym's artifact base, and refuses a branch name", () => {
    const wt = mkdtempSync(join(tmpdir(), "gymrel-"));
    mkdirSync(join(wt, "release"));
    writeFileSync(join(wt, "release/box-release.json"), JSON.stringify({ schema: 1, about: "x", commit: A, sequence: 1, artifactBase: "https://flagshipserver.com/build/iso" }));
    const out = writeRelease(wt, { commit: B, sequence: 77 });
    expect(out).toMatchObject({ commit: B, sequence: 77, artifactBase: GYM_ARTIFACT_BASE });
    expect(JSON.parse(readFileSync(join(wt, "release/box-release.json"), "utf8")).commit).toBe(B);
    expect(() => writeRelease(wt, { commit: "gym", sequence: 1 })).toThrow();
    expect(() => writeRelease(wt, { commit: B, sequence: 0 })).toThrow();
  });
});
