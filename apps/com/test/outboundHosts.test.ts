import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  NEW_HOSTS_PER_DAY,
  checkOutboundHost,
  handleOutboundHosts,
  normalizeOutboundHost,
  parseReportRows,
  readOutboundHosts,
  recordOutboundReport,
  setOutboundHostStatus,
} from "../src/outboundHosts.js";

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

const env = (db: D1Database) => ({ DB: db, FLAGSHIP_ADMIN_SECRET: "admin", USAGE_REPORT_SECRET: "hub" });
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("outbound hosts", () => {
  it("accepts public DNS names and nothing else", () => {
    expect(normalizeOutboundHost(" API.OpenAI.com. ")).toBe("api.openai.com");
    for (const bad of ["10.0.0.1", "1.2.3.4", "localhost", "foo.local", "x.internal", "a", "-a.com", "a..com", "home.alice.flagship.services", "flagship.services", "flagshipserver.com", "a b.com", 5, null]) {
      expect(normalizeOutboundHost(bad), String(bad)).toBeNull();
    }
  });

  it("allows a new host by default, remembers it, and refuses it once blocked", withDb(async (db) => {
    expect(await checkOutboundHost(db, "api.new-ai.example.org")).toEqual({ allowed: true });
    const seen = await readOutboundHosts(db, 1);
    expect(seen.find((h) => h.host === "api.new-ai.example.org")?.status).toBe("allowed");
    await setOutboundHostStatus(db, "api.new-ai.example.org", "blocked", "abuse complaint");
    expect(await checkOutboundHost(db, "api.new-ai.example.org")).toEqual({ allowed: false, reason: "blocked" });
    await setOutboundHostStatus(db, "api.new-ai.example.org", "allowed", "cleared");
    expect(await checkOutboundHost(db, "api.new-ai.example.org")).toEqual({ allowed: true });
  }));

  it("comes seeded with exactly the providers baked into the apps", withDb(async (db) => {
    const names = (await readOutboundHosts(db, 1)).map((h) => h.host).sort();
    expect(names).toEqual(["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "openrouter.ai"]);
    expect(await checkOutboundHost(db, "api.anthropic.com")).toEqual({ allowed: true });
  }));

  it("stops recording new hosts past the daily cap, but still answers the ones it knows", withDb(async (db) => {
    for (let i = 0; i < NEW_HOSTS_PER_DAY; i++) {
      await db.prepare("INSERT OR IGNORE INTO outbound_hosts (host, status, first_seen_day) VALUES (?, 'allowed', ?)")
        .bind(`h${i}.example.org`, new Date().toISOString().slice(0, 10)).run();
    }
    expect(await checkOutboundHost(db, "brand-new.example.org")).toEqual({ allowed: false, reason: "new-host-cap" });
    expect(await checkOutboundHost(db, "h7.example.org")).toEqual({ allowed: true });
  }));

  it("adds the hub's totals per host and day, and the review lists them busiest first", withDb(async (db) => {
    await recordOutboundReport(db, [
      { host: "api.openai.com", streams: 3, up: 100, down: 900, refused: 0 },
      { host: "api.newhost.example.org", streams: 1, up: 10, down: 10, refused: 1 },
    ]);
    await recordOutboundReport(db, [{ host: "api.openai.com", streams: 2, up: 50, down: 50, refused: 0 }]);
    const [first, second] = await readOutboundHosts(db, 1);
    expect(first).toMatchObject({ host: "api.openai.com", streams: 5, bytesUp: 150, bytesDown: 950 });
    expect(second).toMatchObject({ host: "api.newhost.example.org", refused: 1 });
  }));

  it("keeps nothing that could name a user", withDb(async (db) => {
    for (const t of ["outbound_hosts", "outbound_host_daily"]) {
      const cols = (await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
      expect(cols.filter((c) => /user|account|server|box|device|pik|ip/i.test(c)), t).toEqual([]);
    }
  }));

  it("reads a report strictly", () => {
    expect(parseReportRows({ rows: "x" })).toBeNull();
    expect(parseReportRows({ rows: Array(501).fill({}) })).toBeNull();
    expect(parseReportRows({ rows: [{ host: "10.0.0.1", streams: 1 }, { host: "api.openai.com", streams: -4, up: "x", down: 5 }] }))
      .toEqual([{ host: "api.openai.com", streams: 0, up: 0, down: 5, refused: 0 }]);
  });

  it("answers the hub only with its secret and the owner only with theirs", withDb(async (db) => {
    const e = env(db);
    expect((await handleOutboundHosts(post("/api/outbound/check", {}, { host: "api.openai.com" }), e)).status).toBe(403);
    expect((await handleOutboundHosts(post("/api/outbound/check", { "x-admin-secret": "admin" }, { host: "api.openai.com" }), e)).status).toBe(403);
    const ok = await handleOutboundHosts(post("/api/outbound/check", { "x-usage-secret": "hub" }, { host: "api.openai.com" }), e);
    expect(await ok.json()).toEqual({ allowed: true });
    expect((await handleOutboundHosts(new Request("https://x/api/admin/outbound-hosts"), e)).status).toBe(401);
    expect((await handleOutboundHosts(new Request("https://x/api/admin/outbound-hosts", { headers: { "x-usage-secret": "hub" } }), e)).status).toBe(401);
    const block = await handleOutboundHosts(post("/api/admin/outbound-hosts", { "x-admin-secret": "admin" }, { host: "api.openai.com", status: "blocked", note: "test" }), e);
    expect(block.status).toBe(200);
    const after = await handleOutboundHosts(post("/api/outbound/check", { "x-usage-secret": "hub" }, { host: "api.openai.com" }), e);
    expect(await after.json()).toEqual({ allowed: false, reason: "blocked" });
    const bad = await handleOutboundHosts(post("/api/outbound/check", { "x-usage-secret": "hub" }, { host: "10.0.0.1" }), e);
    expect(await bad.json()).toEqual({ allowed: false, reason: "bad-host" });
  }));
});
