import { describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetProvisionStatus,
  handlePostProvisionStatus,
  PROVISION_STATUS_PHASES,
} from "../src/provisionStatus.js";

const SERIAL = "01HXAFORDER0001";

/** Seed an auth-code (the order record) owned by `username` so the status
 *  handler can resolve SERIAL → owner, plus one registered push token. */
async function seedOrderWithOwner(
  storage: InMemoryStorage,
  serial: string,
  username: string,
  opts: { withToken: boolean } = { withToken: true },
): Promise<void> {
  await storage.authCodes.put({
    serial,
    username,
    serverName: "home",
    serverDomain: `home.${username}.flagship.services`,
    delegatedPubKeyHex: "aa".repeat(32),
    userPubKeyHex: "bb".repeat(32),
    userSignatureHex: "cc".repeat(64),
    issuedAt: 1_000,
    expiresAt: 1_000 + 24 * 3_600_000,
    status: "active",
    recordedAt: 1_000,
  });
  if (opts.withToken) {
    await storage.pushTokens.put({
      tokenId: "tok-1",
      username,
      platform: "webpush",
      providerToken: "https://push.example/endpoint",
      pushX25519PubHex: "dd".repeat(32),
      registrationSignatureHex: "ee".repeat(64),
      deviceId: "d1".repeat(16),
      registeredAt: 2_000,
      lastSeenAt: 2_000,
    });
  }
}

describe("provision status channel", () => {
  it("put → get round-trip surfaces the latest phase + detail", async () => {
    const storage = new InMemoryStorage();
    const now = 1_700_000_000_000;
    const post = await handlePostProvisionStatus(
      { storage: storage.provisionStatus, now: () => now },
      SERIAL,
      { phase: "installing", detail: "42%" },
    );
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ ok: true });

    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect(get.status).toBe(200);
    const body = get.body as {
      serial: string;
      phase: string;
      detail?: string;
      updatedAt: number;
      history: Array<{ phase: string; detail?: string; ts: number }>;
    };
    expect(body.serial).toBe(SERIAL);
    expect(body.phase).toBe("installing");
    expect(body.detail).toBe("42%");
    expect(body.updatedAt).toBe(now);
    expect(body.history).toEqual([{ phase: "installing", detail: "42%", ts: now }]);
  });

  it("appends history across multiple posts, latest fields track the newest", async () => {
    const storage = new InMemoryStorage();
    let t = 1_000;
    const phases: Array<[string, string | undefined]> = [
      ["booting", undefined],
      ["downloading", "fetching image"],
      ["partitioning", undefined],
      ["installing", "kernel"],
      ["registering", undefined],
      ["sealing", undefined],
      ["pairing", undefined],
      ["live", "ready"],
    ];
    for (const [phase, detail] of phases) {
      t += 100;
      const res = await handlePostProvisionStatus(
        { storage: storage.provisionStatus, now: () => t },
        SERIAL,
        detail !== undefined ? { phase, detail } : { phase },
      );
      expect(res.status).toBe(200);
    }
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    const body = get.body as {
      phase: string;
      detail?: string;
      updatedAt: number;
      history: Array<{ phase: string; detail?: string; ts: number }>;
    };
    expect(body.phase).toBe("live");
    expect(body.detail).toBe("ready");
    expect(body.updatedAt).toBe(t);
    expect(body.history).toHaveLength(phases.length);
    expect(body.history.map((h) => h.phase)).toEqual(phases.map(([p]) => p));
    // detail is omitted from history entries that didn't carry one.
    expect(body.history[0]).toEqual({ phase: "booting", ts: 1_100 });
    expect(body.history[1]).toEqual({
      phase: "downloading",
      detail: "fetching image",
      ts: 1_200,
    });
  });

  it("rejects a phase outside the allowlist (400)", async () => {
    const storage = new InMemoryStorage();
    const res = await handlePostProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
      { phase: "frobnicating" },
    );
    expect(res.status).toBe(400);
    // Nothing was stored.
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect(get.status).toBe(404);
  });

  it("rejects a missing phase (400)", async () => {
    const storage = new InMemoryStorage();
    const res = await handlePostProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
      {},
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed serial (400)", async () => {
    const storage = new InMemoryStorage();
    const res = await handlePostProvisionStatus(
      { storage: storage.provisionStatus },
      "x",
      { phase: "booting" },
    );
    expect(res.status).toBe(400);
  });

  it("GET returns 404 when no status was ever posted", async () => {
    const storage = new InMemoryStorage();
    const res = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      "01HXAFABSENT001",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no status" });
  });

  it("error phase carries failure detail through to the record", async () => {
    const storage = new InMemoryStorage();
    await handlePostProvisionStatus(
      { storage: storage.provisionStatus, now: () => 5 },
      SERIAL,
      { phase: "installing" },
    );
    await handlePostProvisionStatus(
      { storage: storage.provisionStatus, now: () => 6 },
      SERIAL,
      { phase: "error", detail: "disk write failed" },
    );
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    const body = get.body as { phase: string; detail?: string };
    expect(body.phase).toBe("error");
    expect(body.detail).toBe("disk write failed");
  });

  it("a 'live' status POST pushes the resolved owner", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice");
    const pushFanout = vi.fn(async () => {});

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
        now: () => 10,
      },
      SERIAL,
      { phase: "live" },
    );

    expect(res.status).toBe(200);
    expect(pushFanout).toHaveBeenCalledTimes(1);
    const arg = pushFanout.mock.calls[0]![0] as {
      username: string;
      targets: Array<{ tokenId: string; platform: string }>;
      payload: { category: string; title: string; meta?: Record<string, unknown> };
    };
    expect(arg.username).toBe("alice");
    expect(arg.targets.map((t) => t.tokenId)).toEqual(["tok-1"]);
    expect(arg.payload.category).toBe("provision-status");
    expect(arg.payload.meta).toMatchObject({ serial: SERIAL, phase: "live" });
  });

  it("the canonical order is MONOTONIC + matches the box's real emission timeline", () => {
    const phases = PROVISION_STATUS_PHASES as readonly string[];
    // The true wire order the box emits (ground-truth from a real box's status
    // history): booting → partitioning → installing → downloading →
    // registering → sealing → installed → pairing → live.
    expect(phases).toEqual([
      "booting",
      "partitioning",
      "installing",
      "downloading",
      "registering",
      "sealing",
      "installed",
      "pairing",
      "live",
      "error",
    ]);
    const idx = (p: string) => phases.indexOf(p);
    // `downloading` (the flagship bootstrap fetch) comes AFTER `installing`
    // (the base-system install) — the bug this fix closes (it used to be before).
    expect(idx("downloading")).toBeGreaterThan(idx("installing"));
    // `installed` (the final pre-poweroff checkpoint) comes AFTER `sealing`.
    expect(idx("installed")).toBeGreaterThan(idx("sealing"));
    expect(idx("installed")).toBeGreaterThan(idx("registering"));
    // `error` stays terminal/off-ladder (last).
    expect(phases[phases.length - 1]).toBe("error");
  });

  it("an 'installed' status POST pushes 'Install complete' + the unplug body (ACTION-NEEDED, not success)", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice");
    const pushFanout = vi.fn(async () => {});

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
      },
      SERIAL,
      { phase: "installed" },
    );

    expect(res.status).toBe(200);
    // `installed` IS a push milestone — the user must act even backgrounded.
    expect(pushFanout).toHaveBeenCalledTimes(1);
    const arg = pushFanout.mock.calls[0]![0] as {
      payload: { title: string; body: string; meta?: Record<string, unknown> };
    };
    expect(arg.payload.title).toBe("Install complete");
    expect(arg.payload.body).toBe("Unplug the USB stick, then power the box back on.");
    expect(arg.payload.meta).toMatchObject({ serial: SERIAL, phase: "installed" });
  });

  it("an 'error' status POST pushes with the failure detail", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice");
    const pushFanout = vi.fn(async () => {});

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
      },
      SERIAL,
      { phase: "error", detail: "disk write failed" },
    );

    expect(res.status).toBe(200);
    expect(pushFanout).toHaveBeenCalledTimes(1);
    const arg = pushFanout.mock.calls[0]![0] as {
      payload: { body: string; meta?: Record<string, unknown> };
    };
    expect(arg.payload.body).toContain("disk write failed");
    expect(arg.payload.meta).toMatchObject({ phase: "error", detail: "disk write failed" });
  });

  it("no subscription → still returns ok and never calls the fan-out", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice", { withToken: false });
    const pushFanout = vi.fn(async () => {});

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
      },
      SERIAL,
      { phase: "live" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pushFanout).not.toHaveBeenCalled();
  });

  it("unknown serial under a wired auth-code gate → 403, nothing stored, no push", async () => {
    const storage = new InMemoryStorage();
    const pushFanout = vi.fn(async () => {});

    // With AuthCodeStorage wired (production), the POST is gated on the serial
    // mapping to a real auth-code. No order seeded → reject.
    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
      },
      SERIAL,
      { phase: "live" },
    );

    expect(res.status).toBe(403);
    expect(pushFanout).not.toHaveBeenCalled();
    // Nothing was stored — the gate ran before the write.
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect(get.status).toBe(404);
  });

  it("without an auth-code gate (dev) any serial-shaped POST is accepted", async () => {
    const storage = new InMemoryStorage();
    // No `authCodes` dep → the gate is off; the phase still stores.
    const res = await handlePostProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
      { phase: "live" },
    );
    expect(res.status).toBe(200);
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect((get.body as { phase: string }).phase).toBe("live");
  });

  it("only milestone phases ring a push; the rest update the polled stream silently", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice");
    const pushFanout = vi.fn(async () => {});
    const deps = {
      storage: storage.provisionStatus,
      authCodes: storage.authCodes,
      pushTokens: storage.pushTokens,
      pushFanout,
    };

    // Non-milestone phases store but do NOT push.
    for (const phase of ["booting", "downloading", "partitioning", "installing", "pairing"]) {
      const r = await handlePostProvisionStatus(deps, SERIAL, { phase });
      expect(r.status).toBe(200);
    }
    expect(pushFanout).not.toHaveBeenCalled();

    // Milestone phases push.
    for (const phase of ["registering", "sealing", "live", "error"]) {
      await handlePostProvisionStatus(deps, SERIAL, { phase });
    }
    expect(pushFanout).toHaveBeenCalledTimes(4);
  });

  it("mirrors the canonical phase onto a provisioning demo_users row", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice", { withToken: false });
    // A provisioning demo row owned by the same user.
    await storage.demoUsers.insert({
      username: "alice",
      idempotencyKey: "provision-status-alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: "srv-1",
      activeServerIp: null,
      image: null,
      activeServerFqdn: "home.alice.flagship.services",
      lastActivityAt: 1_000,
      state: "provisioning",
      createdAt: 1_000,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        demoUsers: storage.demoUsers,
        now: () => 42,
      },
      SERIAL,
      { phase: "installing" },
    );
    expect(res.status).toBe(200);
    const row = await storage.demoUsers.get("alice");
    expect(row?.provisionPhase).toBe("installing");
    expect(row?.provisionPhaseAt).toBe(42);
  });

  it("lets live replace an error after registration already promoted the demo row", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice", { withToken: false });
    await storage.demoUsers.insert({
      username: "alice",
      idempotencyKey: "provision-status-alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: "srv-1",
      activeServerIp: null,
      image: null,
      activeServerFqdn: "home.alice.flagship.services",
      lastActivityAt: 1_000,
      state: "ready",
      createdAt: 1_000,
      provisionPhase: "error",
      provisionPhaseAt: 41,
      provisionLastError: "transient ACME failure",
    });

    await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        demoUsers: storage.demoUsers,
        now: () => 42,
      },
      SERIAL,
      { phase: "live" },
    );
    expect(await storage.demoUsers.get("alice")).toMatchObject({
      state: "ready",
      provisionPhase: "live",
      provisionPhaseAt: 42,
      provisionLastError: null,
    });

    await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        demoUsers: storage.demoUsers,
        now: () => 43,
      },
      SERIAL,
      { phase: "installing" },
    );
    expect((await storage.demoUsers.get("alice"))?.provisionPhase).toBe("live");
  });

  it("a push-fan-out failure does not fail the status POST", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice");
    const pushFanout = vi.fn(async () => {
      throw new Error("provider down");
    });

    const res = await handlePostProvisionStatus(
      {
        storage: storage.provisionStatus,
        authCodes: storage.authCodes,
        pushTokens: storage.pushTokens,
        pushFanout,
      },
      SERIAL,
      { phase: "live" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pushFanout).toHaveBeenCalledTimes(1);
    // The phase still landed despite the push throw.
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect((get.body as { phase: string }).phase).toBe("live");
  });

  it("emits a 'server-online' audit row on the FIRST live report, deduped on replay", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice", { withToken: false });
    const deps = {
      storage: storage.provisionStatus,
      authCodes: storage.authCodes,
      auditEvents: storage.auditEvents,
      now: () => 5_000,
    };
    await handlePostProvisionStatus(deps, SERIAL, { phase: "registering" });
    await handlePostProvisionStatus(deps, SERIAL, { phase: "live" });
    // A replayed/retried `live` POST must NOT append a duplicate row.
    await handlePostProvisionStatus(deps, SERIAL, { phase: "live" });

    const rows = await storage.auditEvents.list("alice", 0, 50);
    const online = rows.filter((r) => r.eventKind === "server-online");
    expect(online).toHaveLength(1);
    expect(online[0]!.detail).toBe("home");
  });

  it("emits no 'server-online' row when auditEvents is not wired", async () => {
    const storage = new InMemoryStorage();
    await seedOrderWithOwner(storage, SERIAL, "alice", { withToken: false });
    const res = await handlePostProvisionStatus(
      { storage: storage.provisionStatus, authCodes: storage.authCodes, now: () => 5_000 },
      SERIAL,
      { phase: "live" },
    );
    expect(res.status).toBe(200);
    expect(await storage.auditEvents.list("alice", 0, 50)).toHaveLength(0);
  });
});
