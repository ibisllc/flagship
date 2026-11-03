import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { endpointFor, LIMITS } from "../src/rateLimit.js";
import {
  buildCanaryReport,
  handleCanaryReport,
  handleUpdateReceipt,
  MAX_NEW_COUNT_ROWS_PER_DAY,
  MAX_RECEIPTS_PER_DAY,
  pruneUpdateReceipts,
} from "../src/updateReceipts.js";
import { cronPlan, SIX_HOURLY_CRON } from "../src/cronPlan.js";

const A = "0123456789abcdef0123456789abcdef01234567";
const B = "fedcba9876543210fedcba9876543210fedcba98";
let n = 0;
const receipt = (o: Record<string, unknown> = {}) => ({
  format: 1,
  release: A,
  cohort: "5",
  healthGate: "pass",
  rolledBack: false,
  arch: "amd64",
  stack: "classic",
  nonce: (n++).toString(16).padStart(32, "1"),
  ...o,
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://flagshipserver.com/api/update-receipts", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function withDb(fn: (db: D1Database, raw: ReturnType<typeof createSqliteD1>) => Promise<void>) {
  return async () => {
    const sqlite = createSqliteD1();
    try {
      await fn(sqlite as unknown as D1Database, sqlite);
    } finally {
      sqlite.close();
    }
  };
}

describe("POST /api/update-receipts", () => {
  it("is metered per network and nothing else", () => {
    expect(endpointFor("POST", "/api/update-receipts")).toBe("update-receipt");
    expect(LIMITS["update-receipt"].every((r) => r.axis === "ip")).toBe(true);
  });

  it(
    "counts a receipt and stores nothing about the caller",
    withDb(async (db, raw) => {
      const r = await handleUpdateReceipt(post(receipt()), { DB: db });
      expect(r.status).toBe(202);
      const rows = raw.raw.prepare("SELECT * FROM update_receipt_counts").all();
      expect(rows).toEqual([{ release_commit: A, cohort: "5", arch: "amd64", stack: "classic", day: new Date().toISOString().slice(0, 10), passed: 1, rolled_back: 0, stuck: 0 }]);
      const dump = JSON.stringify(raw.raw.prepare("SELECT * FROM update_receipt_nonces").all()) + JSON.stringify(rows);
      expect(dump).not.toContain("203.0.113.9");
    }),
  );

  it(
    "counts a resend once",
    withDb(async (db, raw) => {
      const one = receipt({ healthGate: "fail", rolledBack: true });
      expect((await handleUpdateReceipt(post(one), { DB: db })).status).toBe(202);
      const again = await handleUpdateReceipt(post(one), { DB: db });
      expect(await again.json()).toMatchObject({ duplicate: true });
      expect(raw.raw.prepare("SELECT rolled_back FROM update_receipt_counts").get()).toEqual({ rolled_back: 1 });
    }),
  );

  it(
    "refuses anything that is not exactly a receipt",
    withDb(async (db) => {
      for (const bad of [receipt({ server: "home.alice" }), receipt({ rolledBack: true }), receipt({ release: "main" }), "{", "x".repeat(2000)]) {
        const r = await handleUpdateReceipt(post(bad), { DB: db });
        expect([400, 413]).toContain(r.status);
      }
      expect((await handleUpdateReceipt(new Request("https://x/api/update-receipts"), { DB: db })).status).toBe(405);
      expect((await handleUpdateReceipt(post(receipt()), {})).status).toBe(503);
    }),
  );

  it(
    "prunes old nonces and counts",
    withDb(async (db, raw) => {
      await handleUpdateReceipt(post(receipt()), { DB: db }, new Date("2025-01-01T00:00:00Z"));
      await pruneUpdateReceipts(db, new Date("2026-10-24T00:00:00Z"));
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_nonces").get()).toEqual({ c: 0 });
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts").get()).toEqual({ c: 0 });
    }),
  );
});

describe("B2 #11: pruning and storage are not the caller's to steer", () => {
  it(
    "a caller's nonce never triggers pruning: receipts are pruned by the cron, by day, exactly",
    withDb(async (db, raw) => {
      const old = new Date("2025-01-01T00:00:00Z");
      await handleUpdateReceipt(post(receipt()), { DB: db }, old);
      // A receipt whose nonce starts with "0" used to run the prune inline.
      const r = await handleUpdateReceipt(post(receipt({ nonce: "0".repeat(32) })), { DB: db });
      expect(r.status).toBe(202);
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts WHERE day = '2025-01-01'").get()).toEqual({ c: 1 });
      expect(cronPlan(SIX_HOURLY_CRON, Date.UTC(2026, 10, 2, 6)).jobs).toContain("prune-update-receipts");
      // The cron's prune removes exactly what is past retention and nothing newer.
      await pruneUpdateReceipts(db, new Date("2026-10-24T00:00:00Z"));
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts WHERE day = '2025-01-01'").get()).toEqual({ c: 0 });
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts").get()).toEqual({ c: 1 });
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_nonces WHERE nonce = ?").get("0".repeat(32))).toEqual({ c: 1 });
    }),
  );

  it(
    "stops taking receipts for the day once the day's cap is reached, without counting them",
    withDb(async (db, raw) => {
      const today = new Date().toISOString().slice(0, 10);
      const ins = raw.raw.prepare("INSERT INTO update_receipt_nonces (nonce, day) VALUES (?, ?)");
      for (let i = 0; i < MAX_RECEIPTS_PER_DAY; i++) ins.run(i.toString(16).padStart(32, "0"), today);
      const r = await handleUpdateReceipt(post(receipt()), { DB: db });
      expect(r.status).toBe(503);
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts").get()).toEqual({ c: 0 });
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_nonces").get()).toEqual({ c: MAX_RECEIPTS_PER_DAY });
    }),
  );

  it(
    "bounds the new count rows a day can add (made-up releases), while known ones still count",
    withDb(async (db, raw) => {
      const today = new Date().toISOString().slice(0, 10);
      expect((await handleUpdateReceipt(post(receipt()), { DB: db })).status).toBe(202);
      const ins = raw.raw.prepare("INSERT INTO update_receipt_counts (release_commit, cohort, arch, stack, day, passed) VALUES (?, '5', 'amd64', 'classic', ?, 1)");
      for (let i = 1; i < MAX_NEW_COUNT_ROWS_PER_DAY; i++) ins.run(i.toString(16).padStart(40, "0"), today);
      const fresh = await handleUpdateReceipt(post(receipt({ release: B })), { DB: db });
      expect(fresh.status).toBe(503);
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_counts WHERE release_commit = ?").get(B)).toEqual({ c: 0 });
      // The refused receipt's nonce is not spent, so the box's retry tomorrow still counts.
      expect(raw.raw.prepare("SELECT COUNT(*) AS c FROM update_receipt_nonces").get()).toEqual({ c: 1 });
      const known = await handleUpdateReceipt(post(receipt()), { DB: db });
      expect(known.status).toBe(202);
      expect(raw.raw.prepare("SELECT passed FROM update_receipt_counts WHERE release_commit = ?").get(A)).toEqual({ passed: 2 });
    }),
  );
});

describe("through the Worker router", () => {
  it(
    "reaches the receipt handler behind the per-network limiter, and the admin view behind its secret",
    withDb(async (db, raw) => {
      const { route } = await import("../src/route.js");
      const { memoryRateLimits } = await import("./rateLimitFakes.js");
      const rl = memoryRateLimits();
      const env = {
        SERVICES_BASE_URL: "https://flagship.services",
        ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
        DB: db,
        RATE_LIMITS: rl.ns,
        FLAGSHIP_ADMIN_SECRET: "s3cret",
      } as unknown as Parameters<typeof route>[1];
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await route(post(receipt()), env)).status);
      // 6 an hour per network: the 7th and 8th are refused before anything is counted
      expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 429, 429]);
      expect(rl.calls.some((c) => c.startsWith("update-receipt|ip|"))).toBe(true);
      expect(raw.raw.prepare("SELECT SUM(passed) AS n FROM update_receipt_counts").get()).toEqual({ n: 6 });
      const view = await route(new Request("https://flagshipserver.com/api/admin/canary", { headers: { "x-admin-secret": "s3cret" } }), env);
      expect(view.status).toBe(200);
      expect(((await view.json()) as { releases: unknown[] }).releases).toHaveLength(1);
    }),
  );
});

describe("GET /api/admin/canary", () => {
  const get = (q = "", secret = "s3cret") => new Request(`https://flagshipserver.com/api/admin/canary${q}`, { headers: { "x-admin-secret": secret } });

  it(
    "needs the admin secret and reports per release, cohort and profile",
    withDb(async (db) => {
      expect((await handleCanaryReport(get("", "wrong"), { DB: db, FLAGSHIP_ADMIN_SECRET: "s3cret" })).status).toBe(403);
      await handleUpdateReceipt(post(receipt()), { DB: db });
      await handleUpdateReceipt(post(receipt({ cohort: "1", arch: "arm64", stack: "arch-v2", healthGate: "fail", rolledBack: true })), { DB: db });
      await handleUpdateReceipt(post(receipt({ release: B, healthGate: "fail", rolledBack: false })), { DB: db });
      const r = await handleCanaryReport(get("?days=7"), { DB: db, FLAGSHIP_ADMIN_SECRET: "s3cret" });
      expect(r.status).toBe(200);
      const body = (await r.json()) as ReturnType<typeof buildCanaryReport>;
      const a = body.releases.find((x) => x.release === A)!;
      expect(a.totals).toEqual({ passed: 1, rolledBack: 1, stuck: 0 });
      expect(a.byCohort).toEqual({ "5": { passed: 1, rolledBack: 0, stuck: 0 }, "1": { passed: 0, rolledBack: 1, stuck: 0 } });
      expect(a.byProfile["arm64/arch-v2"]).toEqual({ passed: 0, rolledBack: 1, stuck: 0 });
      expect(body.releases.find((x) => x.release === B)!.totals.stuck).toBe(1);
      const only = (await (await handleCanaryReport(get(`?release=${B}`), { DB: db, FLAGSHIP_ADMIN_SECRET: "s3cret" })).json()) as ReturnType<typeof buildCanaryReport>;
      expect(only.releases.map((x) => x.release)).toEqual([B]);
      expect((await handleCanaryReport(get("?release=main"), { DB: db, FLAGSHIP_ADMIN_SECRET: "s3cret" })).status).toBe(400);
    }),
  );
});
