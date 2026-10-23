import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecuritySliver } from "../src/securitySliver.js";
import { OFFLINE_REPLICA_AFTER_MS, applySliverPlan, offlineReplicaSliverPlan, recoverySliverPlan } from "../src/sliverFeeds.js";
import type { RePairWatcherState } from "../src/postRecovery/rePairWatcher.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const NEW = "b".repeat(64);
const state = (over: Partial<RePairWatcherState> = {}): RePairWatcherState => ({
  lastSeen: { newIrkPub: NEW, oldIrkPub: "a".repeat(64), initiatedAt: NOW - HOUR, completesAt: NOW + 23 * HOUR, objectedAt: null },
  lastSwapTo: null,
  lastSwapAt: null,
  lastPolledAt: NOW,
  lastError: null,
  ...over,
});

function sliver(now: { t: number }) {
  return new SecuritySliver(join(mkdtempSync(join(tmpdir(), "sliver-feeds-")), "sliver.json"), () => now.t);
}

describe("the sliver's recovery lines", () => {
  it("shows a pending recovery as critical with its deadline, and resolves it on a veto or a verified swap", async () => {
    const clock = { t: NOW };
    const s = sliver(clock);
    await applySliverPlan(s, recoverySliverPlan("alice", state(), NOW));
    let [line] = s.lines();
    expect(line).toMatchObject({ kind: "recovery-attempt", severity: "critical", target: "alice", state: "active", deadline: NOW + 23 * HOUR, remainingMs: 23 * HOUR });
    expect(line!.action).toMatch(/refuse the recovery/);

    clock.t += HOUR;
    const vetoed = state({ lastSeen: { ...state().lastSeen!, objectedAt: clock.t } });
    await applySliverPlan(s, recoverySliverPlan("alice", vetoed, clock.t));
    [line] = s.lines();
    expect(line).toMatchObject({ state: "resolved", severity: "critical" });

    const swapped = recoverySliverPlan("alice", state({ lastSwapTo: NEW }), NOW);
    expect(swapped.raise).toEqual([]);
    expect(swapped.resolve).toContain("recovery-attempt");
  });

  it("raises one high line for a recovery the box could not verify, for a week", () => {
    const plan = recoverySliverPlan("alice", state({ lastSwapTo: NEW, unverified: { row: state().lastSeen!, seenAt: NOW } }), NOW);
    expect(plan.raise).toHaveLength(1);
    expect(plan.raise[0]).toMatchObject({ issueKey: "recovery-unverified", severity: "high", deadline: NOW + 7 * 24 * HOUR });
    expect(recoverySliverPlan("alice", state({ lastSwapTo: NEW, unverified: { row: state().lastSeen!, seenAt: NOW } }), NOW + 8 * 24 * HOUR).resolve).toContain("recovery-unverified");
  });

  it("re-raising an unchanged condition does not notify again", async () => {
    const s = sliver({ t: NOW });
    const plan = recoverySliverPlan("alice", state(), NOW);
    const first = await s.raise(plan.raise[0]!);
    const again = await s.raise(plan.raise[0]!);
    expect(first.notify).toBe(true);
    expect(again.notify).toBe(false);
    expect(s.lines()).toHaveLength(1);
  });
});

describe("the sliver's offline-replica lines", () => {
  const p = (peer: string, ref: string, since: number) => ({ peer, serviceRef: ref, entries: 1, since });

  it("waits out a blip, then shows one line per app naming every server still missing the change", () => {
    expect(offlineReplicaSliverPlan([p("home2.alice.flagship.services", "chess--alice", NOW - 60_000)], [], NOW).raise).toEqual([]);
    const plan = offlineReplicaSliverPlan(
      [p("home2.alice.flagship.services", "chess--alice", NOW - OFFLINE_REPLICA_AFTER_MS), p("cabin.alice.flagship.services", "chess--alice", NOW - HOUR), p("home2.alice.flagship.services", "notes--alice", NOW - HOUR)],
      [],
      NOW,
    );
    expect(plan.raise.map((r) => r.issueKey).sort()).toEqual(["offline-replicas:chess--alice", "offline-replicas:notes--alice"]);
    const chess = plan.raise.find((r) => r.target === "chess--alice")!;
    expect(chess.summary).toContain("2 other servers");
    expect(chess.summary).toContain("cabin.alice.flagship.services, home2.alice.flagship.services");
    expect(chess.severity).toBe("moderate");
  });

  it("resolves an app's line once every server has the change", () => {
    const plan = offlineReplicaSliverPlan([], ["chess--alice"], NOW);
    expect(plan).toEqual({ raise: [], resolve: ["offline-replicas:chess--alice"] });
  });
});
