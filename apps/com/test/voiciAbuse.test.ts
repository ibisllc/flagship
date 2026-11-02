/**
 * Reports, bans and takedowns (docs/voici-and-messages.md §9.2-§9.6) over a real D1-over-sqlite binding, a fake R2
 * bucket and a fake Cloudflare purge API, with the signed reports taken from chunk A's vectors.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { D1Database } from "@flagship/storage";
import { deriveVoiciOwnerSignKey, signVoiciMessageReport, type VoiciMessageReport } from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { FakeDeviceIntegrity } from "../src/deviceIntegrity.js";
import { handleVoiciAbuseRoute } from "../src/voiciAbuseRoutes.js";
import { deleteVoiciAbuseAccount, isAccountBanned, isPseudonymBanned, isTakenDown, pruneVoiciAbuse, r2PageOf, type VoiciBucket } from "../src/voiciAbuse.js";

const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/messages/vectors.json", import.meta.url), "utf8"));
const T0: number = V.t0;
const NOW = T0 + 10_000;
const PAGE_ID: string = V.derivations.pageId;
const OWNER_SIGN = deriveVoiciOwnerSignKey({ seed: new Uint8Array(32).fill(0x11) }, PAGE_ID, 1);
const OWNER_SIGN_PUB = Buffer.from(OWNER_SIGN.publicKey).toString("hex");
const ADMIN = "admin-secret-for-tests";

class FakeBucket implements VoiciBucket {
  readonly objects = new Map<string, string>();
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(o: { prefix: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(o.prefix)).sort();
    const limit = o.limit ?? 1000;
    return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit };
  }
}

async function world() {
  const db = createSqliteD1() as unknown as D1Database;
  const bucket = new FakeBucket();
  bucket.objects.set("v1/u/alice.json", JSON.stringify({ username: "alice", pageId: PAGE_ID, seq: 7, ownerSignPub: OWNER_SIGN_PUB }));
  for (let i = 0; i < 350; i++) bucket.objects.set(`v1/p/${PAGE_ID}/${i.toString(16).padStart(64, "0")}`, "x");
  bucket.objects.set(`v1/p/${"ab".repeat(16)}/other`, "someone else's");
  const purged: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache");
    const files = (JSON.parse(String(init.body)) as { files: string[] }).files;
    expect(files.length).toBeLessThanOrEqual(30);
    purged.push(...files);
    return Response.json({ success: true });
  }) as unknown as typeof fetch;
  const integrity = new FakeDeviceIntegrity();
  const page = db
    .prepare(
      "INSERT INTO voici_pages (username, page_id, seq, issued_at, accepts_messages, inbox_epoch, owner_sign_pub, index_json, published_at) VALUES ('alice', ?1, 7, 1, 1, 1, ?2, '{}', 1)",
    )
    .bind(PAGE_ID, OWNER_SIGN_PUB)
    .run();
  await page;
  const env = { DB: db, VOICI: bucket, VOICI_ENABLED: "on", FLAGSHIP_ADMIN_SECRET: ADMIN, CLOUDFLARE_PURGE_TOKEN: "t", VOICI_FILES_ZONE_ID: "zone-1" };
  let now = NOW;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handleVoiciAbuseRoute(
      new Request(`https://flagshipserver.com${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      env as never,
      undefined,
      { now: () => now, integrity, fetchFn, abuseKeys: [] },
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const admin = (method: string, sub: string, body?: unknown) => call(method, `/api/admin/voici/${sub}`, body, { "x-admin-secret": ADMIN });
  return { db, bucket, purged, integrity, call, admin, setNow: (t: number) => (now = t), };
}

const messageReport = () => ({ ...V.reports.message.report, signature: V.reports.message.signature });
const pageReport = (signer: unknown = null) => ({ ...V.reports.page.report, signer });

describe("reports", () => {
  it("takes the owner's signed message report once, with its abuse tag, and no address", async () => {
    const w = await world();
    const r = await w.call("POST", "/api/voici/reports", messageReport(), { "cf-connecting-ip": "203.0.113.7" });
    expect(r.status).toBe(200);
    const again = await w.call("POST", "/api/voici/reports", messageReport());
    expect(again.body!.reportId).toBe(r.body!.reportId);
    const row = await w.db.prepare("SELECT * FROM voici_reports").all<Record<string, unknown>>();
    expect(row.results).toHaveLength(1);
    expect(JSON.stringify(row.results)).not.toContain("203.0.113.7");
    expect(row.results[0]).toMatchObject({ kind: "message", username: "alice", pseudonym_pub: V.message.envelope.from, signed: 1, status: "open" });
    const shown = await w.admin("GET", `reports/${r.body!.reportId}`);
    expect(shown.body!.report.envelope.cred.attestation.abuseTag).toBe(V.message.envelope.cred.attestation.abuseTag);
    expect(shown.body!.report.abuseEpoch).toBe(V.attestation.signed.abuseEpoch);
  });

  it("refuses a message report not signed by the page's key, for another page, or stale", async () => {
    const w = await world();
    expect((await w.call("POST", "/api/voici/reports", { ...messageReport(), reason: "harassment" })).body!.code).toBe("bad-signature");
    expect((await w.call("POST", "/api/voici/reports", { ...messageReport(), pageId: "ab".repeat(16) })).status).toBe(404);
    expect((await w.call("POST", "/api/voici/reports", { ...pageReport(), username: "nobody" })).status).toBe(404);
    w.setNow(NOW + 20 * 60_000);
    expect((await w.call("POST", "/api/voici/reports", messageReport())).body!.code).toBe("stale");
    w.setNow(NOW);
    const rep: VoiciMessageReport = { ...V.reports.message.report };
    const signature = signVoiciMessageReport(rep, OWNER_SIGN.seed);
    expect((await w.call("POST", "/api/voici/reports", { ...rep, signature })).status).toBe(200);
  });

  it("takes anonymous and signed-in page reports, with CORS for voi.ci only", async () => {
    const w = await world();
    const anon = await w.call("POST", "/api/voici/reports", pageReport(), { origin: "https://voi.ci" });
    expect(anon.status).toBe(200);
    expect(anon.headers.get("access-control-allow-origin")).toBe("https://voi.ci");
    const signed = await w.call("POST", "/api/voici/reports", pageReport({ delegation: V.delegation.delegation, delegationSig: V.delegation.signature, sig: V.reports.page.signature }));
    expect(signed.status).toBe(200);
    const bad = await w.call("POST", "/api/voici/reports", pageReport({ delegation: V.delegation.delegation, delegationSig: V.delegation.signature, sig: V.reports.message.signature }));
    expect(bad.body!.code).toBe("bad-signature");
    const rows = await w.db.prepare("SELECT signed FROM voici_reports ORDER BY signed").all<{ signed: number }>();
    expect(rows.results.map((r) => r.signed)).toEqual([0, 1]);
    const evil = await w.call("POST", "/api/voici/reports", pageReport(), { origin: "https://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await w.call("OPTIONS", "/api/voici/reports", undefined, { origin: "https://voi.ci" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    expect((await w.call("OPTIONS", "/api/voici/reports", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await w.call("POST", "/api/voici/reports", { ...pageReport(), seq: 8 })).status).toBe(400);
    expect((await w.call("POST", "/api/voici/reports", { ...pageReport(), extra: 1 })).status).toBe(400);
  });
});

describe("admin", () => {
  it("needs the admin secret", async () => {
    const w = await world();
    expect((await w.call("GET", "/api/admin/voici/reports")).status).toBe(401);
    expect((await w.call("GET", "/api/admin/voici/reports", undefined, { "x-admin-secret": "wrong" })).status).toBe(403);
  });

  it("bans the reported account: the pseudonym at once, the device by its stored token; unban reverses it", async () => {
    const w = await world();
    const id = (await w.call("POST", "/api/voici/reports", messageReport())).body!.reportId as string;
    await w.db
      .prepare("INSERT INTO messages_enrollments (username, platform, enrolled_at, device_token, device_token_at) VALUES ('mallory', 'android', 1, 'mallory-phone', ?1)")
      .bind(NOW - 86_400_000)
      .run();
    const listed = await w.admin("GET", "reports");
    expect(listed.body!.reports.map((r: { id: string }) => r.id)).toEqual([id]);
    const ban = await w.admin("POST", "ban", { username: "mallory", reportId: id, reason: "spam" });
    expect(ban.body).toEqual({ ok: true, pseudonymBanned: true, device: "marked" });
    expect(await isAccountBanned(w.db, "mallory")).toBe(true);
    expect(await isPseudonymBanned(w.db, V.message.envelope.from)).toBe(true);
    expect(w.integrity.devices.get("mallory-phone")?.banned).toBe(true);
    expect((await w.admin("GET", "reports")).body!.reports).toEqual([]);
    expect((await w.admin("POST", "ban", { username: "mallory", reportId: "f".repeat(32), reason: "spam" })).status).toBe(404);
    expect((await w.admin("POST", "ban", { username: "mallory", reportId: id })).status).toBe(400);
    const unban = await w.admin("POST", "unban", { username: "mallory" });
    expect(unban.body).toEqual({ ok: true, device: "marked" });
    expect(await isAccountBanned(w.db, "mallory")).toBe(false);
    expect(await isPseudonymBanned(w.db, V.message.envelope.from)).toBe(false);
    expect(w.integrity.devices.get("mallory-phone")?.banned).toBe(false);
  });

  it("dismisses a report", async () => {
    const w = await world();
    const id = (await w.call("POST", "/api/voici/reports", pageReport())).body!.reportId as string;
    expect((await w.admin("POST", "dismiss", { reportId: id })).status).toBe(200);
    expect((await w.admin("POST", "dismiss", { reportId: id })).status).toBe(404);
    expect((await w.admin("GET", "reports?status=all")).body!.reports[0].status).toBe("dismissed");
  });

  it("takes a page down over several calls, purging every URL before deleting it, then restores", async () => {
    const w = await world();
    await w.call("POST", "/api/voici/reports", pageReport());
    const first = await w.admin("POST", "takedown", { username: "alice", reason: "illegal" });
    expect(first.body).toMatchObject({ ok: true, done: false, deleted: 301, purged: true });
    expect(await isTakenDown(w.db, "alice")).toEqual({ reason: "illegal" });
    expect(await w.db.prepare("SELECT takedown_reason FROM voici_pages WHERE username = 'alice'").first()).toEqual({ takedown_reason: "illegal" });
    expect(await r2PageOf(w.bucket)("alice")).toBeNull();
    const second = await w.admin("POST", "takedown", { username: "alice", reason: "illegal" });
    expect(second.body).toMatchObject({ ok: true, done: true, deleted: 50 });
    expect([...w.bucket.objects.keys()]).toEqual([`v1/p/${"ab".repeat(16)}/other`]);
    expect(w.purged).toHaveLength(351);
    expect(w.purged[0]).toBe("https://files.voi.ci/v1/u/alice.json");
    expect((await w.admin("GET", "reports?status=all")).body!.reports[0].status).toBe("taken-down");
    const stats = await w.admin("GET", "stats");
    expect(stats.body).toMatchObject({ takedowns: 1, takedownsPurgePending: 0, openReports: 0 });
    expect((await w.admin("POST", "restore", { username: "alice" })).status).toBe(200);
    expect(await isTakenDown(w.db, "alice")).toBeNull();
    expect(await w.db.prepare("SELECT taken_down_at FROM voici_pages WHERE username = 'alice'").first()).toEqual({ taken_down_at: null });
  });

  it("reports what ops needs, and prunes on the way", async () => {
    const w = await world();
    await w.call("POST", "/api/voici/reports", pageReport());
    await w.db.prepare("INSERT INTO messages_attest_counters (username, day, count) VALUES ('a', ?1, 3), ('a', '2000-01-01', 9)").bind(new Date(NOW).toISOString().slice(0, 10)).run();
    await w.db.prepare("INSERT INTO messages_enrollments (username, platform, enrolled_at, device_token, device_token_at) VALUES ('a', 'ios', 1, 'old', 1)").run();
    const s = await w.admin("GET", "stats");
    expect(s.body).toMatchObject({ enabled: true, openReports: 1, oldestOpenReportAt: NOW, newRecipientsToday: 3, enrollments: { ios: 1, android: 0, none: 0 }, abuseKey: null, purgeConfigured: true });
    const old = await w.db.prepare("SELECT COUNT(*) AS n FROM messages_attest_counters WHERE day = '2000-01-01'").first<{ n: number }>();
    expect(old?.n).toBe(0);
    const tok = await w.db.prepare("SELECT device_token FROM messages_enrollments").first<{ device_token: string | null }>();
    expect(tok?.device_token).toBeNull();
    await pruneVoiciAbuse(w.db, NOW);
    await deleteVoiciAbuseAccount(w.db, "a");
    expect(await w.db.prepare("SELECT COUNT(*) AS n FROM messages_enrollments").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
