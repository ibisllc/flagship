import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleLateLog,
  pruneLateLogs,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_LABEL,
  type LateLogBucket,
} from "../src/lateLog.js";
import { route, type RouteEnv } from "../src/route.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

function memoryBucket(): LateLogBucket & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async put(key, value) {
      data.set(key, typeof value === "string" ? value : "<bytes>");
    },
    async list({ prefix = "", limit = 1000, cursor }) {
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
    async get(key) {
      const v = data.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

const SECRET = "s3cret";
const URL_BASE = "https://flagshipserver.com/api/dev/late-log/";

function post(label: string, body: string): Request {
  return new Request(URL_BASE + label, { method: "POST", body });
}

describe("late-log: installer log tails", () => {
  it("stores a chunk without credentials and reads it back only with the admin secret", async () => {
    const env = { ISO_TEMP_BUCKET: memoryBucket(), FLAGSHIP_ADMIN_SECRET: SECRET };
    const w = await handleLateLog(post("01ABC-wifi", "wlan0 up"), env, "01ABC-wifi");
    expect(w.status).toBe(200);
    expect(await w.text()).not.toContain("late-log/");

    const anon = await handleLateLog(new Request(URL_BASE + "01ABC-wifi"), env, "01ABC-wifi");
    expect([401, 403]).toContain(anon.status);
    expect(await anon.text()).not.toContain("wlan0");

    const wrong = await handleLateLog(
      new Request(URL_BASE + "01ABC-wifi", { headers: { "x-admin-secret": "nope" } }),
      env,
      "01ABC-wifi",
    );
    expect([401, 403]).toContain(wrong.status);

    const admin = await handleLateLog(
      new Request(URL_BASE + "01ABC-wifi", { headers: { "x-admin-secret": SECRET } }),
      env,
      "01ABC-wifi",
    );
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain("wlan0 up");
  });

  it("refuses reads when no admin secret is configured", async () => {
    const env = { ISO_TEMP_BUCKET: memoryBucket() };
    const r = await handleLateLog(
      new Request(URL_BASE + "x", { headers: { "x-admin-secret": "" } }),
      env,
      "x",
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("caps a chunk's size, whether declared or streamed", async () => {
    const env = { ISO_TEMP_BUCKET: memoryBucket(), FLAGSHIP_ADMIN_SECRET: SECRET };
    const big = "x".repeat(MAX_CHUNK_BYTES + 1);
    const r = await handleLateLog(post("lbl", big), env, "lbl");
    expect(r.status).toBe(413);
    const streamed = new Request(URL_BASE + "lbl", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      // @ts-expect-error duplex is required by undici for a stream body
      duplex: "half",
    });
    expect((await handleLateLog(streamed, env, "lbl")).status).toBe(413);
    expect(env.ISO_TEMP_BUCKET.data.size).toBe(0);
  });

  it("keeps only the newest chunks of a label", async () => {
    const bucket = memoryBucket();
    const env = { ISO_TEMP_BUCKET: bucket, FLAGSHIP_ADMIN_SECRET: SECRET };
    const start = 1_760_000_000_000;
    for (let i = 0; i < MAX_CHUNKS_PER_LABEL + 5; i++) {
      await handleLateLog(post("lbl", `chunk ${i}`), env, "lbl", start + i);
    }
    expect(bucket.data.size).toBe(MAX_CHUNKS_PER_LABEL);
    const kept = [...bucket.data.values()];
    expect(kept).toContain(`chunk ${MAX_CHUNKS_PER_LABEL + 4}`);
    expect(kept).not.toContain("chunk 0");
  });

  it("refuses bad labels and other methods", async () => {
    const env = { ISO_TEMP_BUCKET: memoryBucket(), FLAGSHIP_ADMIN_SECRET: SECRET };
    expect((await handleLateLog(post("a%2Fb", "x"), env, "a%2Fb")).status).toBe(400);
    expect((await handleLateLog(new Request(URL_BASE + "a", { method: "PUT", body: "x" }), env, "a")).status).toBe(405);
  });

  it("prunes chunks past the TTL", async () => {
    const bucket = memoryBucket();
    const now = new Date("2026-10-16T00:00:00Z");
    const old = now.getTime() - 8 * 86_400_000;
    const fresh = now.getTime() - 86_400_000;
    bucket.data.set(`late-log/a/${old}-abc.txt`, "old");
    bucket.data.set(`late-log/b/${fresh}-def.txt`, "fresh");
    bucket.data.set("other/thing", "kept");
    expect(await pruneLateLogs(bucket, now)).toBe(1);
    expect([...bucket.data.keys()].sort()).toEqual([`late-log/b/${fresh}-def.txt`, "other/thing"]);
  });
});

describe("late-log: per-address budget at the edge", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("ok")) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses the 11th post from one address in a minute, and budgets per label", async () => {
    const { ns, calls } = memoryRateLimits();
    const env: RouteEnv = {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: { fetch: async () => new Response("asset") },
      RATE_LIMITS: ns,
    };
    const send = (label: string) =>
      route(
        new Request(URL_BASE + label, { method: "POST", body: "x", headers: { "cf-connecting-ip": "203.0.113.9" } }),
        env,
      );
    for (let i = 0; i < 10; i++) expect((await send("lbl")).status).not.toBe(429);
    const refused = await send("lbl");
    expect(refused.status).toBe(429);
    expect(calls.some((k) => k === "dev-late-log|subject|lbl")).toBe(true);
  });
});
