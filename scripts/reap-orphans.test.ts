import { describe, expect, it } from "vitest";
import { applyPlan, confirmationPhrase, formatPlan, parseArgs, selectOrphans } from "./reap-orphans.mjs";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const SRV = "00000000-0000-4000-8000-0000000000a1";
const NOW = Date.parse("2026-10-18T12:00:00Z");

const dns = (n: number, name: string, type: string, owner: string | null, action = "orphan") => ({
  id: hex(n), name, type, owner, action, reason: action === "orphan" ? "no account of this name in D1" : "kept",
});

function plan(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: "2026-10-18T11:00:00Z",
    apex: "flagship.services",
    zoneRecords: 6,
    knownAccounts: 2,
    protectedAccounts: ["playstore-test-0725"],
    serversChecked: true,
    summary: { dnsTotal: 6, dnsKeep: 3, dnsOrphan: 3, serversTotal: 1, serversKeep: 0, serversOrphan: 1, zoneRecordsAfter: 3 },
    accounts: [
      { owner: "bob", status: "orphan", dnsOrphans: 3, serverOrphans: 1, dnsKept: 0 },
      { owner: "alice", status: "kept", dnsOrphans: 0, serverOrphans: 0, dnsKept: 1 },
    ],
    dns: [
      dns(1, "flagship.services", "A", null, "keep"),
      dns(2, "alice.flagship.services", "CAA", "alice", "keep"),
      dns(3, "bob.flagship.services", "CAA", "bob"),
      dns(4, "*.home.bob.flagship.services", "A", "bob"),
      dns(5, "_acme-challenge.home.bob.flagship.services", "TXT", "bob"),
      dns(6, "mystery.flagship.services", "A", null, "keep"),
    ],
    servers: [{ serverId: SRV, title: "t", state: "started", labels: {}, action: "orphan", owner: "bob", reason: "x" }],
    ...over,
  };
}

describe("parseArgs", () => {
  it("is a dry run by default and --apply needs a plan", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(() => parseArgs(["--apply"])).toThrow(/--plan/);
    expect(() => parseArgs(["--plan", "x"])).toThrow(/only used with --apply/);
    expect(() => parseArgs(["--apply", "--plan", "x", "--out", "y"])).toThrow(/dry run/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown/);
    expect(parseArgs(["--apply", "--plan", "p.json"])).toMatchObject({ apply: true, plan: "p.json" });
  });
});

describe("formatPlan", () => {
  it("prints per-account counts and the zone projection", () => {
    const text = formatPlan(plan(), { show: true });
    expect(text).toContain("3 orphaned");
    expect(text).toMatch(/bob\s+3\s+1/);
    expect(text).toContain("zone after the reap: 3 of 200");
    expect(text).toContain("alice (1)");
    expect(text).toContain("dns    TXT   _acme-challenge.home.bob.flagship.services");
  });
  it("says so when servers were not checked or nothing is left", () => {
    expect(formatPlan(plan({ serversChecked: false }))).toContain("NOT CHECKED");
    expect(formatPlan(plan({ accounts: [] }))).toContain("Nothing to reap.");
  });
});

describe("selectOrphans", () => {
  it("takes only the orphans, servers and records", () => {
    const sel = selectOrphans(plan(), NOW);
    expect(sel.dns.map((d: { id: string }) => d.id)).toEqual([hex(3), hex(4), hex(5)]);
    expect(sel.servers).toHaveLength(1);
    expect(sel.refused).toEqual([]);
    expect(confirmationPhrase(sel)).toBe("delete 3 records and 1 servers");
  });

  it("refuses an old, foreign or future-dated plan", () => {
    expect(() => selectOrphans(plan({ generatedAt: "2026-10-16T11:00:00Z" }), NOW)).toThrow(/older than 24 hours/);
    expect(() => selectOrphans({ version: 2 }, NOW)).toThrow(/not a reap plan/);
    expect(() => selectOrphans(plan({ generatedAt: "nonsense" }), NOW)).toThrow(/valid time/);
    expect(() => selectOrphans(plan({ generatedAt: "2026-10-19T11:00:00Z" }), NOW)).toThrow(/valid time/);
  });

  it("refuses edited entries: the apex, a protected account, an owner that does not match the name, a bad id", () => {
    const bad = plan({
      dns: [
        dns(1, "flagship.services", "A", "bob"),
        dns(2, "x.playstore-test-0725.flagship.services", "A", "playstore-test-0725"),
        dns(3, "home.alice.flagship.services", "A", "bob"),
        { ...dns(4, "bob.flagship.services", "CAA", "bob"), id: "../../zones" },
        dns(5, "bob.example.org", "A", "bob"),
        dns(6, "bob.flagship.services", "MX", "bob"),
        dns(7, "bob.flagship.services", "CAA", "BOB!"),
        dns(8, "ok.bob.flagship.services", "A", "bob"),
      ],
      servers: [
        { serverId: "../../x", action: "orphan", owner: "bob", title: "" },
        { serverId: SRV, action: "orphan", owner: "playstore-test-0725", title: "" },
      ],
    });
    const sel = selectOrphans(bad, NOW);
    expect(sel.dns.map((d: { id: string }) => d.id)).toEqual([hex(8)]);
    expect(sel.servers).toEqual([]);
    expect(sel.refused).toHaveLength(9);
  });

  it("never selects a keep entry, whatever else it says", () => {
    const sel = selectOrphans(plan({ dns: [dns(3, "bob.flagship.services", "CAA", "bob", "keep")], servers: [] }), NOW);
    expect(sel.dns).toEqual([]);
  });
});

describe("applyPlan", () => {
  const fastOpts = (post: (b: unknown) => Promise<{ status: number; body: Record<string, unknown> }>, events: unknown[], sleeps: number[]) => ({
    post,
    sleep: async (ms: number) => void sleeps.push(ms),
    log: (e: unknown) => void events.push(e),
    pauseMs: 0,
  });

  it("deletes servers and records one by one and logs each", async () => {
    const sel = selectOrphans(plan(), NOW);
    const sent: unknown[] = [];
    const events: { event: string }[] = [];
    const out = await applyPlan(sel, fastOpts(async (b) => (sent.push(b), { status: 200, body: { result: "deleted" } }), events, []));
    expect(out).toMatchObject({ deleted: 4, failed: 0, skipped: 0, aborted: null });
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({ kind: "server", id: SRV, owner: "bob" });
    expect(events.map((e) => e.event)).toEqual(["deleted", "deleted", "deleted", "deleted"]);
  });

  it("waits 30 seconds and retries a failed call, then moves on after the attempts run out", async () => {
    const sel = selectOrphans(plan({ servers: [] }), NOW);
    const sleeps: number[] = [];
    const events: { event: string }[] = [];
    const calls: Record<string, number> = {};
    const out = await applyPlan(
      sel,
      fastOpts(async (b) => {
        const id = (b as { id: string }).id;
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === hex(3)) return calls[id]! < 3 ? { status: 502, body: { error: "rate limited" } } : { status: 200, body: { result: "deleted" } };
        if (id === hex(4)) throw new Error("socket hang up");
        return { status: 200, body: { result: "gone" } };
      }, events, sleeps),
    );
    expect(out).toMatchObject({ deleted: 1, gone: 1, failed: 1 });
    expect(calls[hex(3)]).toBe(3);
    expect(calls[hex(4)]).toBe(6);
    expect(sleeps.filter((s) => s === 30_000)).toHaveLength(2 + 5);
    expect(events.filter((e) => e.event === "retry")).toHaveLength(7);
  });

  it("counts a re-check refusal as skipped and carries on", async () => {
    const sel = selectOrphans(plan({ servers: [] }), NOW);
    const out = await applyPlan(
      sel,
      fastOpts(async (b) => ((b as { id: string }).id === hex(3) ? { status: 409, body: { code: "not-orphan", reason: "account still exists in D1" } } : { status: 200, body: { result: "deleted" } }), [], []),
    );
    expect(out).toMatchObject({ deleted: 2, skipped: 1 });
  });

  it("stops at once on a wrong secret or missing configuration", async () => {
    const sel = selectOrphans(plan(), NOW);
    let n = 0;
    const out = await applyPlan(sel, fastOpts(async () => (n++, { status: 403, body: { error: "x-admin-secret rejected" } }), [], []));
    expect(n).toBe(1);
    expect(out.aborted).toContain("403");
    expect(out.deleted).toBe(0);
  });
});
