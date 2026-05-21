/**
 * Tests for the Plan-A demo-user handlers + cron helpers.
 *
 * The pattern follows the rest of packages/control-plane/tests/: pure
 * handlers + InMemory storage adapters + a tiny in-process Hetzner
 * fake. No real network. The fake Hetzner records every call so
 * assertions can pin the exact wire shape.
 *
 * Coverage:
 *   - create idempotency + real-account-username collision
 *   - install-complete updates snapshot_id
 *   - delete tears down Hetzner + D1 in order; idempotent on absent
 *   - connect state-machine transitions (none → provisioning, up
 *     no-op, idle-pending-teardown surfaces as provisioning,
 *     concurrency cap returns 429, Hetzner failure rolls reservation
 *     back)
 *   - heartbeat updates last_activity_at only when state=up
 *   - GET / LIST shapes
 *   - the idle reaper picks rows past their per-row ttl
 *   - the provisioning poller promotes provisioning → up when both
 *     Hetzner says running AND isRegistered returns true
 *   - demoServerBlockFromRow maps state → public status
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  InMemoryDemoUsersStorage,
  InMemoryUsernameStorage,
  InMemoryAuditEventStorage,
} from "@flagship/storage";

import {
  handleCreateDemoUser,
  handleDeleteDemoUser,
  handleDemoUserConnect,
  handleDemoUserHeartbeat,
  handleDemoUserInstallComplete,
  handleGetDemoUser,
  handleListDemoUsers,
  runDemoIdleReaper,
  runDemoProvisioningPoller,
  runDemoW11SnapshotPoller,
  demoServerBlockFromRow,
  demoServerFqdn,
  type DemoUsersDeps,
  type HetznerProvisioner,
  type HetznerSnapshotter,
} from "../src/demoUsers.js";

import type { DemoUserRecord } from "@flagship/storage";

// ──────────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────────

interface FakeHetznerCalls {
  create: Array<{ snapshotId: string; username: string; location: string }>;
  status: Array<string>;
  destroy: Array<string>;
}

function makeFakeHetzner(): {
  client: HetznerProvisioner;
  calls: FakeHetznerCalls;
  setStatus(s: string): void;
  failNextCreate(reason?: string): void;
  failNextDestroy(): void;
} {
  const calls: FakeHetznerCalls = { create: [], status: [], destroy: [] };
  let currentStatus = "starting";
  let nextCreateFails: string | null = null;
  let nextDestroyFails = false;
  let nextId = 1;
  const client: HetznerProvisioner = {
    async createServerFromSnapshot(args) {
      if (nextCreateFails) {
        const r = nextCreateFails;
        nextCreateFails = null;
        throw new Error(r);
      }
      calls.create.push({
        snapshotId: args.snapshotId,
        username: args.username,
        location: args.location,
      });
      return { serverId: String(100 + nextId++), ipv4: "5.6.7.8" };
    },
    async getServerStatus(id) {
      calls.status.push(id);
      return { status: currentStatus, ipv4: "5.6.7.8" };
    },
    async destroyServer(id) {
      if (nextDestroyFails) {
        nextDestroyFails = false;
        throw new Error("destroy boom");
      }
      calls.destroy.push(id);
    },
  };
  return {
    client,
    calls,
    setStatus(s) {
      currentStatus = s;
    },
    failNextCreate(r = "create boom") {
      nextCreateFails = r;
    },
    failNextDestroy() {
      nextDestroyFails = true;
    },
  };
}

interface Harness {
  deps: DemoUsersDeps;
  hetzner: ReturnType<typeof makeFakeHetzner>;
  clock: { now: number };
}

function mkHarness(): Harness {
  const clock = { now: 1_000_000 };
  const hetzner = makeFakeHetzner();
  const deps: DemoUsersDeps = {
    storage: new InMemoryDemoUsersStorage(),
    usernames: new InMemoryUsernameStorage(),
    hetzner: hetzner.client,
    sshKeyId: 42,
    audit: new InMemoryAuditEventStorage(),
    now: () => clock.now,
  };
  return { deps, hetzner, clock };
}

async function seedDemoUser(
  deps: DemoUsersDeps,
  overrides: Partial<DemoUserRecord> = {},
): Promise<DemoUserRecord> {
  const row: DemoUserRecord = {
    username: "demoalice",
    display: "Demo Alice",
    snapshotId: "12345",
    isoR2Key: "demo-isos/demoalice-abc.iso",
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cx22",
    activeServerId: null,
    activeServerFqdn: null,
    lastActivityAt: 0,
    state: "none",
    createdAt: 1_000_000,
    ...overrides,
  };
  await deps.storage.insert(row);
  return row;
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe("handleCreateDemoUser", () => {
  let h: Harness;
  beforeEach(() => {
    h = mkHarness();
  });

  it("creates a new row with default region/size/ttl", async () => {
    const res = await handleCreateDemoUser(h.deps, {
      username: "DemoAlice",
      display: "Demo Alice",
    });
    expect(res.status).toBe(200);
    const row = await h.deps.storage.get("demoalice");
    expect(row).toBeDefined();
    expect(row?.region).toBe("fsn1");
    expect(row?.size).toBe("cx22");
    expect(row?.ttlIdleMinutes).toBe(30);
    expect(row?.state).toBe("none");
    expect(row?.snapshotId).toBeNull();
  });

  it("rejects non-conforming username", async () => {
    const res = await handleCreateDemoUser(h.deps, {
      username: "AB", // < 3 chars (after lower)
      display: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects reserved usernames", async () => {
    const res = await handleCreateDemoUser(h.deps, {
      username: "admin",
      display: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects when a real account already claimed the name", async () => {
    await h.deps.usernames.put({
      username: "demoalice",
      irkPubHex: "00".repeat(32),
      claimedAt: 1,
    });
    const res = await handleCreateDemoUser(h.deps, {
      username: "demoalice",
      display: "x",
    });
    expect(res.status).toBe(409);
  });

  it("is idempotent on second call for the same name", async () => {
    await handleCreateDemoUser(h.deps, {
      username: "demoalice",
      display: "Demo Alice",
    });
    const res = await handleCreateDemoUser(h.deps, {
      username: "demoalice",
      display: "Demo Alice",
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).reused).toBe(true);
  });

  it("respects custom region/size/ttl", async () => {
    await handleCreateDemoUser(h.deps, {
      username: "demoalice",
      display: "Demo Alice",
      region: "ash",
      size: "cx32",
      ttlIdleMinutes: 60,
    });
    const row = await h.deps.storage.get("demoalice");
    expect(row?.region).toBe("ash");
    expect(row?.size).toBe("cx32");
    expect(row?.ttlIdleMinutes).toBe(60);
  });
});

describe("handleDemoUserInstallComplete", () => {
  it("updates snapshot_id + iso_r2_key on an existing row", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { snapshotId: null });
    const res = await handleDemoUserInstallComplete(h.deps, "demoalice", {
      snapshot_id: "99999",
      iso_r2_key: "demo-isos/demoalice-xyz.iso",
    });
    expect(res.status).toBe(200);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.snapshotId).toBe("99999");
    expect(row?.isoR2Key).toBe("demo-isos/demoalice-xyz.iso");
  });

  it("404s on absent row", async () => {
    const h = mkHarness();
    const res = await handleDemoUserInstallComplete(h.deps, "demoalice", {
      snapshot_id: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("handleDeleteDemoUser", () => {
  it("destroys Hetzner server then removes the row", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { activeServerId: "555", state: "up" });
    const res = await handleDeleteDemoUser(h.deps, { username: "demoalice" });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).deleted).toBe(true);
    expect(h.hetzner.calls.destroy).toEqual(["555"]);
    expect(await h.deps.storage.get("demoalice")).toBeUndefined();
  });

  it("is idempotent on absent row", async () => {
    const h = mkHarness();
    const res = await handleDeleteDemoUser(h.deps, { username: "nothere" });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).deleted).toBe(false);
  });

  it("keeps the row on Hetzner-destroy failure so cron can retry", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { activeServerId: "555", state: "up" });
    h.hetzner.failNextDestroy();
    const res = await handleDeleteDemoUser(h.deps, { username: "demoalice" });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).deleted).toBe(false);
    const row = await h.deps.storage.get("demoalice");
    expect(row).toBeDefined();
    expect(row?.state).toBe("idle-pending-teardown");
  });
});

describe("handleDemoUserConnect", () => {
  it("404s on absent demo user", async () => {
    const h = mkHarness();
    const res = await handleDemoUserConnect(h.deps, "nothere");
    expect(res.status).toBe(404);
  });

  it("409s on state=none without a snapshotId", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { snapshotId: null });
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(409);
  });

  it("transitions none → provisioning + calls Hetzner with snapshotId", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps);
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("provisioning");
    expect(body.fqdn).toBe(demoServerFqdn("demoalice"));
    expect(h.hetzner.calls.create).toHaveLength(1);
    expect(h.hetzner.calls.create[0]!.snapshotId).toBe("12345");
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("provisioning");
    expect(row?.activeServerId).toMatch(/^\d+$/);
  });

  it("on subsequent connect while provisioning, no-ops and surfaces provisioning", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps);
    await handleDemoUserConnect(h.deps, "demoalice");
    const before = h.hetzner.calls.create.length;
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe("provisioning");
    expect(h.hetzner.calls.create.length).toBe(before); // no new provision
  });

  it("on connect to up, just refreshes lastActivityAt", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "up",
      activeServerId: "555",
      activeServerFqdn: demoServerFqdn("demoalice"),
      lastActivityAt: 1,
    });
    h.clock.now = 9_999;
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe("up");
    const row = await h.deps.storage.get("demoalice");
    expect(row?.lastActivityAt).toBe(9_999);
  });

  it("surfaces idle-pending-teardown as 'provisioning' so clients retry", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "idle-pending-teardown",
      activeServerId: "555",
    });
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe("provisioning");
  });

  it("rolls reservation back on Hetzner failure", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps);
    h.hetzner.failNextCreate("upstream boom");
    const res = await handleDemoUserConnect(h.deps, "demoalice");
    expect(res.status).toBe(502);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("none");
    expect(row?.activeServerId).toBeNull();
  });

  it("enforces MAX_CONCURRENT_DEMO_VPS soft cap (429)", async () => {
    const h = mkHarness();
    h.deps.maxConcurrent = 2;
    await seedDemoUser(h.deps, { username: "u1", state: "up", activeServerId: "1" });
    await seedDemoUser(h.deps, { username: "u2", state: "provisioning", activeServerId: "2" });
    await seedDemoUser(h.deps, { username: "u3" }); // state=none
    const res = await handleDemoUserConnect(h.deps, "u3");
    expect(res.status).toBe(429);
    expect(res.headers?.["retry-after"]).toBe("60");
  });
});

describe("handleDemoUserHeartbeat", () => {
  it("only updates lastActivityAt when state=up", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { state: "up", activeServerId: "5", lastActivityAt: 1 });
    h.clock.now = 555;
    const res = await handleDemoUserHeartbeat(h.deps, "demoalice");
    expect(res.status).toBe(200);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.lastActivityAt).toBe(555);
  });

  it("409s when state!=up", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps);
    const res = await handleDemoUserHeartbeat(h.deps, "demoalice");
    expect(res.status).toBe(409);
  });
});

describe("handleGetDemoUser + handleListDemoUsers", () => {
  it("GET returns row + live Hetzner status when activeServerId set", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { state: "up", activeServerId: "555" });
    h.hetzner.setStatus("running");
    const res = await handleGetDemoUser(h.deps, "demoalice");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect((body.hetznerLive as Record<string, unknown>).status).toBe("running");
    expect(h.hetzner.calls.status).toEqual(["555"]);
  });

  it("GET skips live status when no activeServerId", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps);
    const res = await handleGetDemoUser(h.deps, "demoalice");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).hetznerLive).toBeNull();
    expect(h.hetzner.calls.status).toEqual([]);
  });

  it("LIST returns every row's headline fields", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, { username: "a" });
    await seedDemoUser(h.deps, { username: "b", state: "up", activeServerId: "1" });
    const res = await handleListDemoUsers(h.deps);
    const body = res.body as { demoUsers: Array<{ username: string }> };
    expect(body.demoUsers).toHaveLength(2);
    expect(body.demoUsers.map((r) => r.username).sort()).toEqual(["a", "b"]);
  });
});

describe("runDemoIdleReaper", () => {
  it("destroys rows past their per-row ttl", async () => {
    const h = mkHarness();
    h.clock.now = 100_000_000;
    await seedDemoUser(h.deps, {
      state: "up",
      activeServerId: "555",
      lastActivityAt: 100_000_000 - 31 * 60_000,
      ttlIdleMinutes: 30,
    });
    const { reaped } = await runDemoIdleReaper(h.deps);
    expect(reaped).toBe(1);
    expect(h.hetzner.calls.destroy).toEqual(["555"]);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("none");
    expect(row?.activeServerId).toBeNull();
  });

  it("leaves rows alone within their per-row ttl", async () => {
    const h = mkHarness();
    h.clock.now = 100_000_000;
    await seedDemoUser(h.deps, {
      state: "up",
      activeServerId: "555",
      lastActivityAt: 100_000_000 - 5 * 60_000, // 5 min ago
      ttlIdleMinutes: 30,
    });
    const { reaped } = await runDemoIdleReaper(h.deps);
    expect(reaped).toBe(0);
    expect(h.hetzner.calls.destroy).toEqual([]);
  });

  it("stays in idle-pending-teardown on destroy failure", async () => {
    const h = mkHarness();
    h.clock.now = 100_000_000;
    await seedDemoUser(h.deps, {
      state: "up",
      activeServerId: "555",
      lastActivityAt: 100_000_000 - 60 * 60_000,
      ttlIdleMinutes: 30,
    });
    h.hetzner.failNextDestroy();
    const { reaped } = await runDemoIdleReaper(h.deps);
    expect(reaped).toBe(0);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("idle-pending-teardown");
  });
});

describe("runDemoProvisioningPoller", () => {
  it("promotes provisioning → up when Hetzner=running AND isRegistered=true", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "555",
    });
    h.hetzner.setStatus("running");
    const { promoted } = await runDemoProvisioningPoller(h.deps, async () => true);
    expect(promoted).toBe(1);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("up");
    expect(row?.activeServerFqdn).toBe(demoServerFqdn("demoalice"));
  });

  it("does NOT promote when Hetzner=starting", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "555",
    });
    h.hetzner.setStatus("starting");
    const { promoted } = await runDemoProvisioningPoller(h.deps, async () => true);
    expect(promoted).toBe(0);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("provisioning");
  });

  it("does NOT promote when isRegistered=false", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "555",
    });
    h.hetzner.setStatus("running");
    const { promoted } = await runDemoProvisioningPoller(h.deps, async () => false);
    expect(promoted).toBe(0);
  });
});

describe("runDemoProvisioningPoller — W11 carve-out", () => {
  it("SKIPS rows whose snapshotId is null (those go through the W11 snapshot poller)", async () => {
    const h = mkHarness();
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "555",
      snapshotId: null, // W11 row, has no snapshot yet
      isoR2Key: "demo-isos/demoalice-xyz.iso",
    });
    h.hetzner.setStatus("running");
    const { promoted } = await runDemoProvisioningPoller(
      h.deps,
      async () => true,
    );
    expect(promoted).toBe(0);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("provisioning"); // unchanged
  });
});

// ──────────────────────────────────────────────────────────────────────
// W11 snapshot poller
// ──────────────────────────────────────────────────────────────────────

interface W11Calls {
  snapshot: Array<{ serverId: string; description: string }>;
  imageStatus: Array<string>;
  destroy: Array<string>;
}

function makeW11Hetzner(): {
  client: HetznerSnapshotter;
  calls: W11Calls;
  imageStatuses: Map<string, "creating" | "available" | "unknown">;
  failNextDestroy: () => void;
} {
  const calls: W11Calls = { snapshot: [], imageStatus: [], destroy: [] };
  const imageStatuses = new Map<string, "creating" | "available" | "unknown">();
  let nextDestroyFails = false;
  let nextImage = 1;
  const client: HetznerSnapshotter = {
    async createImageSnapshot(serverId, description) {
      calls.snapshot.push({ serverId, description });
      const id = `img-${nextImage++}`;
      imageStatuses.set(id, "creating");
      return { imageId: id };
    },
    async getImageStatus(imageId) {
      calls.imageStatus.push(imageId);
      return { status: imageStatuses.get(imageId) ?? "unknown" };
    },
    async destroyServer(serverId) {
      if (nextDestroyFails) {
        nextDestroyFails = false;
        throw new Error("destroy boom");
      }
      calls.destroy.push(serverId);
    },
  };
  return {
    client,
    calls,
    imageStatuses,
    failNextDestroy: () => {
      nextDestroyFails = true;
    },
  };
}

describe("runDemoW11SnapshotPoller", () => {
  it("skips rows still within the pre-snapshot grace window", async () => {
    const h = mkHarness();
    h.clock.now = 1_000_000 + 10_000; // 10s after createdAt
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "srv-1",
      snapshotId: null,
      isoR2Key: "demo-isos/demoalice.iso",
      createdAt: 1_000_000,
    });
    const w11 = makeW11Hetzner();
    const { snapshotted } = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
        preSnapshotGraceMs: 3 * 60_000,
      },
      async () => true,
    );
    expect(snapshotted).toBe(0);
    expect(w11.calls.snapshot).toEqual([]);
  });

  it("kicks off snapshot when daemon registered + past grace, then finalizes on 'available'", async () => {
    const h = mkHarness();
    h.clock.now = 1_000_000 + 5 * 60_000;
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "srv-1",
      snapshotId: null,
      isoR2Key: "demo-isos/demoalice.iso",
      createdAt: 1_000_000,
    });
    const w11 = makeW11Hetzner();

    const r1 = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
      },
      async () => true,
    );
    expect(r1.snapshotted).toBe(1);
    expect(w11.calls.snapshot).toHaveLength(1);
    const row1 = await h.deps.storage.get("demoalice");
    expect(row1?.snapshotId).toMatch(/^img-/);
    expect(row1?.state).toBe("provisioning");

    // Next tick: image still 'creating' → no finalize.
    const r2 = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
      },
      async () => true,
    );
    expect(r2.finalized).toBe(0);

    // Flip the image to available; next tick: destroy + state=none.
    w11.imageStatuses.set(row1!.snapshotId!, "available");
    const r3 = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
      },
      async () => true,
    );
    expect(r3.finalized).toBe(1);
    expect(w11.calls.destroy).toEqual(["srv-1"]);
    const row3 = await h.deps.storage.get("demoalice");
    expect(row3?.state).toBe("none");
    expect(row3?.activeServerId).toBeNull();
    expect(row3?.snapshotId).toBe(row1?.snapshotId); // snapshot preserved
  });

  it("declares failure + destroys VPS after failTimeoutMs with no registration", async () => {
    const h = mkHarness();
    h.clock.now = 1_000_000 + 30 * 60_000;
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "srv-1",
      snapshotId: null,
      isoR2Key: "demo-isos/demoalice.iso",
      createdAt: 1_000_000,
    });
    const w11 = makeW11Hetzner();
    const r = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
        failTimeoutMs: 20 * 60_000,
        preSnapshotGraceMs: 3 * 60_000,
      },
      async () => false,
    );
    expect(r.failed).toBe(1);
    expect(w11.calls.destroy).toEqual(["srv-1"]);
    const row = await h.deps.storage.get("demoalice");
    expect(row?.state).toBe("none");
    expect(row?.activeServerId).toBeNull();
    expect(row?.isoR2Key).toBeNull();
    expect(row?.snapshotId).toBeNull();
  });

  it("SKIPS non-W11 rows (snapshotId set from the beginning)", async () => {
    const h = mkHarness();
    h.clock.now = 1_000_000 + 5 * 60_000;
    await seedDemoUser(h.deps, {
      state: "provisioning",
      activeServerId: "srv-1",
      snapshotId: "pre-existing-snap-from-on-connect",
      isoR2Key: null, // distinguishes from W11 — they have isoR2Key set
    });
    const w11 = makeW11Hetzner();
    const r = await runDemoW11SnapshotPoller(
      {
        storage: h.deps.storage,
        hetzner: w11.client,
        now: () => h.clock.now,
      },
      async () => true,
    );
    expect(r.snapshotted).toBe(0);
    expect(r.finalized).toBe(0);
    expect(r.failed).toBe(0);
    expect(w11.calls.snapshot).toEqual([]);
  });
});

describe("demoServerBlockFromRow", () => {
  it("maps each state to its public status", async () => {
    const row: DemoUserRecord = {
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: "12345",
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1,
    };
    expect(demoServerBlockFromRow({ ...row, state: "none" }).status).toBe("none");
    expect(demoServerBlockFromRow({ ...row, state: "provisioning" }).status).toBe("provisioning");
    expect(demoServerBlockFromRow({ ...row, state: "up" }).status).toBe("up");
    expect(demoServerBlockFromRow({ ...row, state: "idle-pending-teardown" }).status).toBe("provisioning");
  });
});
