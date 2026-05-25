import { describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetProvisionStatus,
  handlePostProvisionStatus,
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
      label: "Owner phone",
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

  it("unknown order (no owner) → still returns ok, no push", async () => {
    const storage = new InMemoryStorage();
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
    expect(pushFanout).not.toHaveBeenCalled();
    // The phase was still stored.
    const get = await handleGetProvisionStatus(
      { storage: storage.provisionStatus },
      SERIAL,
    );
    expect((get.body as { phase: string }).phase).toBe("live");
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
});
