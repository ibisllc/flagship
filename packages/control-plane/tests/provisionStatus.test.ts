import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetProvisionStatus,
  handlePostProvisionStatus,
} from "../src/provisionStatus.js";

const SERIAL = "01HXAFORDER0001";

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
});
