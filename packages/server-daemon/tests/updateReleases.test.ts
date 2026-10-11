import { describe, expect, it } from "vitest";
import type { ReleaseEndorsement } from "@ibisllc/maintainers";
import { buildReleaseCatalog } from "../src/updateReleases.js";
import type { ReleaseStatus } from "../src/releaseVerifier.js";

const c = (ch: string) => ch.repeat(40);
const HEAD = c("b");
// Linear history: a (oldest) → b (running) → d → e (newest); x is on another branch.
const order = [c("a"), c("b"), c("d"), c("e")];

function endorsement(commit: string, day: number): ReleaseEndorsement {
  return {
    kind: "ReleaseEndorsement", version: 1, releaseId: `rel-${commit[0]}`,
    semverTag: `v0.0.0-2026-10-${String(day).padStart(2, "0")}-${commit.slice(0, 8)}`,
    commitHash: commit, previousReleaseId: null, previousCommitHash: null,
    intermediateCommits: [], intermediateMerkleRoot: "", endorsedNotes: null,
    issuedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, signedBy: "", signatures: [],
  } as unknown as ReleaseEndorsement;
}

function fakeGit(opts: { fetchOk?: boolean; calls?: string[][] } = {}) {
  return async (args: string[]) => {
    opts.calls?.push(args);
    if (args[0] === "fetch") return { ok: opts.fetchOk ?? true, stdout: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, stdout: HEAD + "\n" };
    if (args[0] === "rev-parse") return { ok: true, stdout: "false\n" };
    if (args[0] === "merge-base") {
      const [, , older, newer] = args;
      const i = order.indexOf(older!), j = order.indexOf(newer!);
      return { ok: i >= 0 && j >= 0 && i < j, stdout: "" };
    }
    return { ok: false, stdout: "" };
  };
}

const status = (es: ReleaseEndorsement[]): ReleaseStatus =>
  ({ validEndorsements: es } as unknown as ReleaseStatus);

describe("release catalog", () => {
  const all = [endorsement(c("a"), 1), endorsement(c("b"), 2), endorsement(c("d"), 3), endorsement(c("e"), 4), endorsement(c("x"), 5)];

  it("places each endorsed release relative to the running commit and picks the newest newer one", async () => {
    const cat = await buildReleaseCatalog({
      repoPath: "/opt/flagship",
      git: fakeGit(),
      statusForWorktree: () => status(all.slice(0, 2)),
      statusForRef: () => status(all),
      verifyWalk: () => ({ ok: true }),
    }).get();
    expect(cat.currentCommit).toBe(HEAD);
    expect(cat.latest?.commit).toBe(c("e"));
    expect(cat.releases.map((r) => [r.commit[0], r.relation])).toEqual([
      ["x", "unrelated"], ["e", "newer"], ["d", "newer"], ["b", "current"], ["a", "older"],
    ]);
    expect(cat.stale).toBeUndefined();
  });

  it("drops a newer release that would fail the gate's lineage walk", async () => {
    const cat = await buildReleaseCatalog({
      repoPath: "/opt/flagship",
      git: fakeGit(),
      statusForWorktree: () => null,
      statusForRef: () => status(all),
      verifyWalk: (e) => ({ ok: e.commitHash !== c("e") }),
    }).get();
    expect(cat.latest?.commit).toBe(c("d"));
    expect(cat.releases.some((r) => r.commit === c("e"))).toBe(false);
  });

  it("caches between looks, refetches on demand, and marks a failed fetch stale", async () => {
    const calls: string[][] = [];
    let t = 0;
    const source = buildReleaseCatalog({
      repoPath: "/opt/flagship",
      git: fakeGit({ calls, fetchOk: false }),
      statusForWorktree: () => status(all),
      statusForRef: () => null,
      verifyWalk: () => ({ ok: true }),
      now: () => t,
    });
    const first = await source.get();
    expect(first.stale).toBe(true);
    const fetches = () => calls.filter((a) => a[0] === "fetch").length;
    expect(fetches()).toBe(1);
    t = 60_000;
    await source.get();
    expect(fetches()).toBe(1);
    await source.get({ refresh: true });
    expect(fetches()).toBe(2);
  });
});
