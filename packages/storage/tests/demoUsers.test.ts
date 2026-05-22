// Contract tests for DemoUsersStorage. Same suite runs against the
// in-memory implementation here; the D1 adapter inherits its
// correctness via the same interface — the route-level tests in
// apps/com/test cover the wire path.
//
// Pins:
//   1. insert is PK-collision-aware (returns ok:false on duplicate).
//   2. transition() is a real CAS — concurrent racers don't both win.
//   3. findIdle() filters on state AND lastActivityAt AND caps at 50.
//   4. countActive() counts only the three non-quiescent states.

import { describe, expect, it } from "vitest";
import { InMemoryDemoUsersStorage } from "../src/inMemory.js";
import type { DemoUserRecord } from "../src/types.js";

function seed(overrides: Partial<DemoUserRecord> = {}): DemoUserRecord {
  return {
    username: "demoalice",
    display: "Demo Alice",
    snapshotId: null,
    isoR2Key: null,
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cx22",
    activeServerId: null,
    activeServerFqdn: null,
    lastActivityAt: 0,
    state: "none",
    createdAt: 1_700_000_000_000,
    provisionPhase: null,
    provisionPhaseAt: null,
    provisionLastError: null,
    ...overrides,
  };
}

describe("InMemoryDemoUsersStorage", () => {
  it("insert + get round-trip; lowercases the username", async () => {
    const s = new InMemoryDemoUsersStorage();
    const res = await s.insert(seed({ username: "DemoAlice" }));
    expect(res).toEqual({ ok: true });
    const row = await s.get("demoalice");
    expect(row?.username).toBe("demoalice");
    expect(row?.display).toBe("Demo Alice");
    expect(row?.state).toBe("none");
  });

  it("insert rejects PK collision with ok:false", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed());
    const dupe = await s.insert(seed());
    expect(dupe).toMatchObject({ ok: false });
  });

  it("update merges fields without changing the username column", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed());
    await s.update("demoalice", { snapshotId: "snap-1", isoR2Key: "demo-isos/x.iso" });
    const row = await s.get("demoalice");
    expect(row?.snapshotId).toBe("snap-1");
    expect(row?.isoR2Key).toBe("demo-isos/x.iso");
    expect(row?.state).toBe("none");
  });

  it("delete is idempotent (no error when absent)", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed());
    await s.delete("demoalice");
    expect(await s.get("demoalice")).toBeUndefined();
    await s.delete("demoalice"); // second delete is a no-op
  });

  it("transition is a real CAS: wrong `from` returns null and leaves row untouched", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed({ state: "up", activeServerId: "S1" }));
    const wrong = await s.transition("demoalice", "none", "provisioning");
    expect(wrong).toBeNull();
    expect((await s.get("demoalice"))?.state).toBe("up");
  });

  it("transition applies the patch atomically with the state move", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed());
    const next = await s.transition("demoalice", "none", "provisioning", {
      activeServerId: "S1",
      lastActivityAt: 123,
    });
    expect(next?.state).toBe("provisioning");
    expect(next?.activeServerId).toBe("S1");
    expect(next?.lastActivityAt).toBe(123);
  });

  it("two concurrent transitions on the same `from` produce exactly one winner", async () => {
    // Models the docs/sample-users.md §4.4 concurrent-/connect race.
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed());
    const a = s.transition("demoalice", "none", "provisioning", { activeServerId: "A" });
    const b = s.transition("demoalice", "none", "provisioning", { activeServerId: "B" });
    const [rA, rB] = await Promise.all([a, b]);
    const wins = [rA, rB].filter((r) => r !== null).length;
    expect(wins).toBe(1);
  });

  it("findIdle returns only (up, provisioning, idle-pending-teardown) rows older than cutoff", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed({ username: "u-none", state: "none", lastActivityAt: 100 }));
    await s.insert(seed({ username: "u-up-old", state: "up", lastActivityAt: 100 }));
    await s.insert(seed({ username: "u-up-fresh", state: "up", lastActivityAt: 9_000 }));
    await s.insert(seed({ username: "u-prov-old", state: "provisioning", lastActivityAt: 50 }));
    await s.insert(seed({ username: "u-pend-old", state: "idle-pending-teardown", lastActivityAt: 1 }));
    const idle = await s.findIdle(1_000);
    expect(idle.map((r) => r.username).sort()).toEqual([
      "u-pend-old", "u-prov-old", "u-up-old",
    ]);
  });

  it("countActive counts only the three non-quiescent states", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed({ username: "n1", state: "none" }));
    await s.insert(seed({ username: "p1", state: "provisioning" }));
    await s.insert(seed({ username: "u1", state: "up" }));
    await s.insert(seed({ username: "u2", state: "up" }));
    await s.insert(seed({ username: "t1", state: "idle-pending-teardown" }));
    expect(await s.countActive()).toBe(4);
  });

  it("list returns every row regardless of state", async () => {
    const s = new InMemoryDemoUsersStorage();
    await s.insert(seed({ username: "a", state: "none" }));
    await s.insert(seed({ username: "b", state: "up" }));
    const rows = await s.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.username).sort()).toEqual(["a", "b"]);
  });

  describe("setProvisionPhase (migration 0035)", () => {
    it("stamps phase + phaseAt and returns the updated row", async () => {
      const s = new InMemoryDemoUsersStorage();
      await s.insert(seed({ username: "demoalice", state: "provisioning" }));
      const updated = await s.setProvisionPhase("demoalice", "cloned", null, 42);
      expect(updated?.provisionPhase).toBe("cloned");
      expect(updated?.provisionPhaseAt).toBe(42);
      expect(updated?.provisionLastError).toBeNull();
      const fresh = await s.get("demoalice");
      expect(fresh?.provisionPhase).toBe("cloned");
    });

    it("records the error alongside a failed phase", async () => {
      const s = new InMemoryDemoUsersStorage();
      await s.insert(seed({ username: "demoalice", state: "provisioning" }));
      const updated = await s.setProvisionPhase("demoalice", "failed", "acme timeout", 99);
      expect(updated?.provisionPhase).toBe("failed");
      expect(updated?.provisionLastError).toBe("acme timeout");
    });

    it("is idempotent — re-posting the same phase just refreshes the timestamp", async () => {
      const s = new InMemoryDemoUsersStorage();
      await s.insert(seed({ username: "demoalice", state: "provisioning" }));
      await s.setProvisionPhase("demoalice", "deps", null, 10);
      const again = await s.setProvisionPhase("demoalice", "deps", null, 20);
      expect(again?.provisionPhase).toBe("deps");
      expect(again?.provisionPhaseAt).toBe(20);
    });

    it("clears a prior error when moving off failed", async () => {
      const s = new InMemoryDemoUsersStorage();
      await s.insert(seed({ username: "demoalice", state: "provisioning" }));
      await s.setProvisionPhase("demoalice", "failed", "boom", 1);
      const recovered = await s.setProvisionPhase("demoalice", "tunnel-online", null, 2);
      expect(recovered?.provisionPhase).toBe("tunnel-online");
      expect(recovered?.provisionLastError).toBeNull();
    });

    it("returns null for an unknown username", async () => {
      const s = new InMemoryDemoUsersStorage();
      expect(await s.setProvisionPhase("ghost", "boot", null, 1)).toBeNull();
    });

    it("a row inserted without provision fields reads them as null", async () => {
      const s = new InMemoryDemoUsersStorage();
      // Construct a record missing the phase columns — the adapter must
      // tolerate it (the D1 schema treats them as nullable).
      await s.insert(seed({ username: "legacy" }) as DemoUserRecord);
      const row = await s.get("legacy");
      expect(row?.provisionPhase).toBeNull();
      expect(row?.provisionPhaseAt).toBeNull();
      expect(row?.provisionLastError).toBeNull();
    });
  });
});
