import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { checkRateLimit, rateLimitedMessage, retryAfterPhrase } from "../src/rateLimit.js";
import { hitWindows, nearMark } from "../src/rateLimitCounter.js";
import { hourBucket, pruneRateLimitLog, readRateLimitLog, recordRateLimitEvents } from "../src/rateLimitLog.js";
import { buildRateLimitReport, handleRateLimitReport } from "../src/rateLimitReport.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

function withDb(fn: (db: D1Database) => Promise<void>) {
  return async () => {
    const sqlite = createSqliteD1();
    try {
      await fn(sqlite as unknown as D1Database);
    } finally {
      sqlite.close();
    }
  };
}

const today = () => new Date().toISOString().slice(0, 10);

describe("rate-limit signals from the counter", () => {
  it("marks the pass that reaches 80% of a budget, or its last slot under 5", () => {
    expect(nearMark(10)).toBe(8);
    expect(nearMark(30)).toBe(24);
    expect(nearMark(3)).toBe(3);
    expect(nearMark(1)).toBe(1);
    let logs = {};
    const nears: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const out = hitWindows(logs, [{ limit: 10, windowSec: 60 }], 1000 + i);
      logs = out.logs;
      nears.push(out.result.near === true);
    }
    expect(nears.map((n, i) => (n ? i + 1 : 0)).filter(Boolean)).toEqual([8]);
  });

  it("flags only the first refusal of a run, and again after a pass", async () => {
    let t = 1_000_000;
    const { ns } = memoryRateLimits({ now: () => t });
    const env = { RATE_LIMITS: ns };
    const hit = () => checkRateLimit(env, { endpoint: "llm-promo-issue", ip: "1.1.1.1" });
    for (let i = 0; i < 5; i++) expect((await hit()).limited).toBe(false);
    const stub = ns.get(ns.idFromName("llm-promo-issue|ip|1.1.1.1") as never);
    const raw = async () =>
      (await (
        await stub.fetch(
          new Request("https://x/hit", { method: "POST", body: JSON.stringify({ rules: [{ limit: 5, windowSec: 3600 }] }) }),
        )
      ).json()) as { ok: boolean; firstRefusal?: boolean };
    expect(await raw()).toMatchObject({ ok: false, firstRefusal: true });
    expect((await raw()).firstRefusal).toBeUndefined();
    t += 3601 * 1000;
    expect((await raw()).ok).toBe(true);
    for (let i = 0; i < 4; i++) await raw();
    expect(await raw()).toMatchObject({ ok: false, firstRefusal: true });
  });
});

describe("rate-limit log", () => {
  it(
    "counts refusals, refused sources and near passes per endpoint and axis",
    withDb(async (db) => {
      const { ns } = memoryRateLimits();
      const env = { RATE_LIMITS: ns, DB: db };
      for (let i = 0; i < 8; i++) await checkRateLimit(env, { endpoint: "llm-promo-issue", ip: "1.1.1.1" });
      for (let i = 0; i < 6; i++) await checkRateLimit(env, { endpoint: "llm-promo-issue", ip: "2.2.2.2" });
      const rows = await readRateLimitLog(db, today());
      expect(rows).toEqual([
        { day: today(), endpoint: "llm-promo-issue", axis: "ip", refused: 4, sources: 2, near: 2, unreachable: 0 },
      ]);
    }),
  );

  it(
    "records through waitUntil when given a context, so the request doesn't wait",
    withDb(async (db) => {
      const { ns } = memoryRateLimits();
      const waits: Promise<unknown>[] = [];
      for (let i = 0; i < 6; i++) {
        await checkRateLimit({ RATE_LIMITS: ns, DB: db }, { endpoint: "llm-promo-issue", ip: "1.1.1.1" }, {
          waitUntil: (p) => waits.push(p),
        });
      }
      expect(waits).toHaveLength(2);
      await Promise.all(waits);
      expect((await readRateLimitLog(db, today()))[0]).toMatchObject({ refused: 1, sources: 1, near: 1 });
    }),
  );

  it(
    "counts an unreachable counter whether the endpoint fails open or closed",
    withDb(async (db) => {
      const { ns } = memoryRateLimits({ fail: true });
      const env = { RATE_LIMITS: ns, DB: db };
      expect((await checkRateLimit(env, { endpoint: "free-ai", ip: "1.1.1.1" })).limited).toBe(false);
      expect((await checkRateLimit(env, { endpoint: "totp-verify", ip: "1.1.1.1", usernameHash: "x" })).limited).toBe(true);
      const rows = await readRateLimitLog(db, today());
      expect(rows.map((r) => [r.endpoint, r.axis, r.unreachable, r.refused])).toEqual([
        ["free-ai", "counter", 1, 0],
        ["totp-verify", "counter", 1, 0],
      ]);
    }),
  );

  it(
    "never fails the request when the log can't be written",
    async () => {
      const { ns } = memoryRateLimits();
      const broken = { batch: async () => { throw new Error("D1 down"); }, prepare: () => ({ bind: () => ({}) }) };
      const env = { RATE_LIMITS: ns, DB: broken as unknown as D1Database };
      for (let i = 0; i < 6; i++) await checkRateLimit(env, { endpoint: "llm-promo-issue", ip: "1.1.1.1" });
    },
  );

  it(
    "drops hours older than 90 days",
    withDb(async (db) => {
      const now = new Date("2026-10-15T12:00:00Z");
      await recordRateLimitEvents(db, [{ endpoint: "free-ai", axis: "ip", kind: "near" }], new Date("2026-07-01T00:00:00Z"));
      await recordRateLimitEvents(db, [{ endpoint: "free-ai", axis: "ip", kind: "near" }], now);
      await pruneRateLimitLog(db, now);
      expect((await readRateLimitLog(db, "2026-01-01")).map((r) => r.day)).toEqual(["2026-10-15"]);
      expect(hourBucket(now)).toBe("2026-10-15T12");
    }),
  );
});

describe("GET /api/admin/rate-limits", () => {
  const get = (q = "", secret?: string) =>
    new Request(`https://flagshipserver.com/api/admin/rate-limits${q}`, {
      headers: secret ? { "x-admin-secret": secret } : {},
    });

  it(
    "needs the admin secret and lists every budget, busiest first",
    withDb(async (db) => {
      const env = { DB: db, FLAGSHIP_ADMIN_SECRET: "adm" };
      expect((await handleRateLimitReport(get(), env)).status).toBe(401);
      await recordRateLimitEvents(db, [
        { endpoint: "username-claim", axis: "ip", kind: "first-refusal" },
        { endpoint: "username-claim", axis: "ip", kind: "refusal" },
        { endpoint: "free-ai", axis: "ip", kind: "near" },
      ]);
      const res = await handleRateLimitReport(get("?days=3", "adm"), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as ReturnType<typeof buildRateLimitReport>;
      expect(body.days).toBe(3);
      expect(body.endpoints[0]).toMatchObject({
        endpoint: "username-claim",
        refused: 2,
        sources: 1,
        rules: [
          { axis: "ip", limit: 5, windowSec: 3600 },
          { axis: "irk", limit: 1, windowSec: 60 },
        ],
        byAxis: { ip: { refused: 2, sources: 1, near: 0, unreachable: 0 } },
        daily: [{ day: today(), refused: 2, sources: 1, near: 0, unreachable: 0 }],
      });
      expect(body.endpoints[1]).toMatchObject({ endpoint: "free-ai", near: 1 });
      expect(body.endpoints.some((e) => e.endpoint === "totp-verify" && e.refused === 0)).toBe(true);
    }),
  );

  it("shows limits as the gym scales them", () => {
    const r = buildRateLimitReport([], 7, "2026-10-09", 10);
    expect(r.endpoints.find((e) => e.endpoint === "username-claim")!.rules[0]!.limit).toBe(50);
  });

  it(
    "clamps the day range",
    withDb(async (db) => {
      const env = { DB: db, FLAGSHIP_ADMIN_SECRET: "adm" };
      const days = async (q: string) => ((await (await handleRateLimitReport(get(q, "adm"), env)).json()) as { days: number }).days;
      expect(await days("?days=400")).toBe(90);
      expect(await days("?days=0")).toBe(7);
      expect(await days("?days=abc")).toBe(7);
    }),
  );
});

describe("the 429's words", () => {
  it("names who is limited and roughly when to come back", () => {
    expect(rateLimitedMessage("ip", 30)).toBe("Too many tries from your network. Try again in a minute.");
    expect(rateLimitedMessage("irk", 61)).toBe("Too many tries from this account. Try again in about 2 minutes.");
    expect(rateLimitedMessage("usernameHash", 900)).toBe(
      "Too many tries for this account name. Try again in about 15 minutes.",
    );
    expect(retryAfterPhrase(3540)).toBe("in about 59 minutes");
    expect(retryAfterPhrase(3600)).toBe("in about 1 hour");
    expect(retryAfterPhrase(5400)).toBe("in about 2 hours");
  });
});
