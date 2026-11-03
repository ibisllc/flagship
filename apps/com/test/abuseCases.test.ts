/**
 * Abuse reports of links and apps, notices and suspensions (docs/abuse-handling.md) over a real D1-over-sqlite
 * binding: intake for each kind, resolution, the rate-limit bucket, who may read notices and mark them done, and the
 * suspension's deadline, urgent categories and un-suspend.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  deriveIRK,
  ed,
  signAbuseNoticeDone,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
} from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { handleAbuseRoute, hostOf, pruneAbuseCases, suspensionGuard, suspensionOf, voiciNameOf, type AbusePushForward } from "../src/abuseCases.js";
import { endpointFor, LIMITS } from "../src/rateLimit.js";

const ORIGIN = "https://flagshipserver.com";
const ADMIN = "admin-secret-for-tests";
const T0 = Date.UTC(2026, 10, 3, 12);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const adminSeed = new Uint8Array(32).fill(7);
const adminPub = hex(ed.getPublicKey(adminSeed));
const stkSeed = new Uint8Array(32).fill(9);
const stk = hex(ed.getPublicKey(stkSeed));

async function world(opts: { adminRoot?: boolean } = {}) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1, ...(opts.adminRoot ? { adminRootPubHex: adminPub } : {}) });
  await storage.usernames.put({ username: "bob", irkPubHex: hex(deriveIRK({ seed: new Uint8Array(32).fill(6) }).publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: stk, registeredAt: 1 });
  await storage.servers.put({ serverDomain: "lost.alice.flagship.services", username: "alice", identityPubKeyHex: "ab".repeat(32), registeredAt: 1 });
  await storage.servers.revoke("lost.alice.flagship.services", "lost", 2);
  const name = (n: string, kind: string, extra: Record<string, unknown> = {}) =>
    db
      .prepare("INSERT INTO names (name, safety_key, kind, status, owner, service_id, target, created_at, status_changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1)")
      .bind(n, n.replace(/-/g, ""), kind, (extra.status as string) ?? "active", (extra.owner as string) ?? "alice", (extra.serviceId as string) ?? null, (extra.target as string) ?? null)
      .run();
  await name("chesspage", "code", { serviceId: "alice--chess", target: "https://chess.alice.flagship.services" });
  await db.prepare("INSERT INTO user_service_aliases (username, service_id, display_label, created_at, updated_at) VALUES ('alice', 'alice--quiz', 'trivia', 1, 1)").run();
  await db
    .prepare("INSERT INTO voici_pages (username, page_id, seq, issued_at, accepts_messages, inbox_epoch, owner_sign_pub, index_json, published_at) VALUES ('alice', ?1, 1, 1, 1, 1, ?2, '{}', 1)")
    .bind("cd".repeat(8), "ef".repeat(32))
    .run();
  const pushes: { category: string; targets: number; data: Record<string, string> | undefined }[] = [];
  const forward: AbusePushForward = async (a) => {
    pushes.push({ category: a.category, targets: a.targets.length, data: a.displayData });
  };
  let now = T0;
  const env = { DB: db, FLAGSHIP_ADMIN_SECRET: ADMIN, ACCOUNT_READ_TOKEN_SECRET: "route-secret", VOICI_ENABLED: "on" };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handleAbuseRoute(
      new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      env as never,
      { now: () => now, forward },
    );
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const admin = (method: string, sub: string, body?: unknown) => call(method, `/api/admin/abuse/${sub}`, body, { "x-admin-secret": ADMIN });
  const report = (kind: string, subject: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/abuse/reports", { kind, subject, reason: "phishing", note: "fake bank login", contact: null, ...extra });
  const cpEnv: ControlPlaneEnv = { DB: db, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  const irkToken = async () => {
    const t = Date.now();
    const claim = { username: "alice", endpointLabel: ACCOUNT_READ_TOKEN_LABEL, phoneIrkPub: irk.publicKey, issuedAt: t, expiresAt: t + 60_000, nonce: crypto.getRandomValues(new Uint8Array(32)) };
    const res = await tryControlPlane(
      new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) }, authSignature: hex(signDeviceEndpointClaim(claim, irk)) }),
      }),
      cpEnv,
    );
    return ((await res!.json()) as { token: string }).token;
  };
  const boxToken = async () => {
    const r = { username: "alice", serverDomain: "home.alice.flagship.services", stkPubHex: stk, issuedAt: Date.now(), nonceHex: "12".repeat(16) };
    const res = await tryControlPlane(
      new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ box: r, signature: signBoxReadTokenRequest(r, { publicKey: ed.getPublicKey(stkSeed), privateKey: stkSeed }) }),
      }),
      cpEnv,
    );
    return ((await res!.json()) as { token: string }).token;
  };
  const issueNotice = async (hours = 72) =>
    (await admin("POST", "notice", { account: "alice", subjectKind: "app", subject: "chess.alice.flagship.services", category: "phishing", action: "take-down", deadlineHours: hours, detail: "A login form copies a bank." })).body!;
  const markDone = (noticeId: string, seed: Uint8Array, note = "Removed the form.", issuedAt = now) => {
    const done = { username: "alice", noticeId, note, issuedAt };
    return call("POST", `/api/users/alice/abuse-notices/${noticeId}/done`, { request: done, signature: hex(signAbuseNoticeDone(done, seed)) });
  };
  return { db, storage, pushes, call, admin, report, irkToken, boxToken, issueNotice, markDone, setNow: (t: number) => (now = t), close: () => sqlite.close() };
}

describe("parsing what a reporter typed", () => {
  it("reads voi.ci addresses in every spelling and nothing else", () => {
    expect(voiciNameOf("https://voi.ci/ChessPage", "voi.ci")).toBe("chesspage");
    expect(voiciNameOf("voi.ci/alice/", "voi.ci")).toBe("alice");
    expect(voiciNameOf("@alice", "voi.ci")).toBe("@alice");
    expect(voiciNameOf("https://evil.example/alice", "voi.ci")).toBeNull();
    expect(voiciNameOf("voi.ci/a/b", "voi.ci")).toBeNull();
  });
  it("reads hosts under the services apex only, one or two labels deep", () => {
    expect(hostOf("https://Chess.Alice.flagship.services/login?x=1", "flagship.services")).toBe("chess.alice.flagship.services");
    expect(hostOf("alice.flagship.services", "flagship.services")).toBe("alice.flagship.services");
    expect(hostOf("a.b.alice.flagship.services", "flagship.services")).toBeNull();
    expect(hostOf("flagship.services.evil.com", "flagship.services")).toBeNull();
  });
});

describe("intake and resolution", () => {
  it("resolves a voi.ci code to the app it redirects to and its account, and keeps no address", async () => {
    const w = await world();
    try {
      const r = await w.report("link", "https://voi.ci/chesspage", { contact: "me@example.org" });
      expect(r.status).toBe(200);
      const shown = await w.admin("GET", `reports/${r.body!.reportId}`);
      expect(shown.body!.report).toMatchObject({ kind: "link", subject: "voi.ci/chesspage", account: "alice", targetKind: "link", target: "https://chess.alice.flagship.services", serviceId: "alice--chess", contact: "me@example.org", status: "open" });
      const cols = (await w.db.prepare("PRAGMA table_info(abuse_reports)").all<{ name: string }>()).results!.map((c) => c.name);
      expect(cols.some((c) => /ip|address/.test(c))).toBe(false);
    } finally {
      w.close();
    }
  });

  it("resolves a user page, an app by alias, a slug--author label, a box and the bare account", async () => {
    const w = await world();
    try {
      const cases: [string, string, Record<string, unknown>][] = [
        ["link", "voi.ci/alice", { targetKind: "page", target: "https://voi.ci/alice", account: "alice" }],
        ["app", "trivia.alice.flagship.services", { targetKind: "app", serviceId: "alice--quiz" }],
        ["app", "https://chess--bob.alice.flagship.services/", { targetKind: "app", serviceId: "bob--chess", account: "alice" }],
        ["app", "blog.alice.flagship.services", { targetKind: "app", serviceId: "alice--blog" }],
        ["app", "home.alice.flagship.services", { targetKind: "box", serverDomain: "home.alice.flagship.services" }],
        ["app", "alice.flagship.services", { targetKind: "account", account: "alice" }],
      ];
      for (const [kind, subject, want] of cases) {
        const r = await w.report(kind, subject);
        expect(r.status, subject).toBe(200);
        expect((await w.admin("GET", `reports/${r.body!.reportId}`)).body!.report, subject).toMatchObject(want);
      }
      expect((await w.admin("GET", "reports")).body!.reports).toHaveLength(cases.length);
    } finally {
      w.close();
    }
  });

  it("refuses what isn't Flagship's and what is malformed", async () => {
    const w = await world();
    try {
      expect((await w.report("app", "chess.nobody.flagship.services")).body!.code).toBe("not-flagship");
      expect((await w.report("app", "example.com")).status).toBe(404);
      expect((await w.report("link", "voi.ci/unknown")).status).toBe(404);
      expect((await w.report("link", "voi.ci/chesspage", { reason: "boring" })).status).toBe(400);
      expect((await w.report("link", "voi.ci/chesspage", { contact: "not an email" })).status).toBe(400);
      expect((await w.report("link", "voi.ci/chesspage", { note: "x".repeat(2001) })).status).toBe(400);
      expect((await w.call("POST", "/api/abuse/reports", { kind: "app", subject: "alice.flagship.services", reason: "spam", note: "", contact: null, extra: 1 })).status).toBe(400);
    } finally {
      w.close();
    }
  });

  it("is metered per address, 10 an hour, like voi.ci reports", () => {
    expect(endpointFor("POST", "/api/abuse/reports")).toBe("abuse-report");
    expect(LIMITS["abuse-report"]).toEqual([{ axis: "ip", limit: 10, windowSec: 3600 }]);
    expect(endpointFor("GET", "/api/users/alice/abuse-notices")).toBe("abuse-notices");
    expect(endpointFor("POST", `/api/users/alice/abuse-notices/${"a".repeat(32)}/done`)).toBe("abuse-notice-done");
  });
});

describe("notices", () => {
  it("only the account's devices read them, never a server's token or a stranger", async () => {
    const w = await world();
    try {
      const n = await w.issueNotice();
      expect(n.noticeId).toMatch(/^[0-9a-f]{32}$/);
      const path = "/api/users/alice/abuse-notices";
      expect((await w.call("GET", path)).status).toBe(401);
      expect((await w.call("GET", path, undefined, { authorization: `Bearer ${await w.boxToken()}` })).status).toBe(401);
      const read = await w.call("GET", path, undefined, { authorization: `Bearer ${await w.irkToken()}` });
      expect(read.status).toBe(200);
      expect(read.body!.suspension).toBeNull();
      expect(read.body!.notices).toEqual([
        expect.objectContaining({ id: n.noticeId, subjectKind: "app", subject: "chess.alice.flagship.services", category: "phishing", action: "take-down", deadlineAt: T0 + 72 * 3_600_000, doneAt: null }),
      ]);
      expect((await w.call("GET", "/api/users/nobody/abuse-notices")).body!.code).toBe("account-not-found");
    } finally {
      w.close();
    }
  });

  it("pushes the admin devices a content-free abuse-notice", async () => {
    const w = await world();
    try {
      await w.db.prepare("PRAGMA foreign_keys = OFF").run();
      await w.storage.pushTokens.put({ tokenId: "t1", username: "alice", deviceId: "d1", platform: "apns", providerToken: "p", pushX25519PubHex: "00".repeat(32), registrationSignatureHex: "", registeredAt: 1, lastSeenAt: 1 } as never);
      await w.issueNotice();
      expect(w.pushes).toEqual([{ category: "abuse-notice", targets: 1, data: { kind: "abuse-notice" } }]);
    } finally {
      w.close();
    }
  });

  it("only an admin device marks one done; the operator sees the note", async () => {
    const w = await world({ adminRoot: true });
    try {
      const n = await w.issueNotice();
      expect((await w.markDone(n.noticeId, irk.privateKey)).body!.code).toBe("not-admin");
      expect((await w.markDone(n.noticeId, new Uint8Array(32).fill(1))).status).toBe(403);
      expect((await w.markDone(n.noticeId, adminSeed, "Removed.", T0 - 10 * 60_000)).body!.code).toBe("stale");
      const ok = await w.markDone(n.noticeId, adminSeed);
      expect(ok.body).toEqual({ ok: true, doneAt: T0 });
      w.setNow(T0 + 1000);
      expect((await w.markDone(n.noticeId, adminSeed, "Again")).body!.doneAt).toBe(T0);
      const list = await w.admin("GET", "notices?account=alice");
      expect(list.body!.notices[0]).toMatchObject({ doneAt: T0, doneNote: "Removed the form.", doneSigner: adminPub });
    } finally {
      w.close();
    }
  });

  it("an account that pins no admin root marks done with its IRK; a withdrawn notice can't be", async () => {
    const w = await world();
    try {
      const n = await w.issueNotice();
      expect((await w.markDone(n.noticeId, irk.privateKey)).status).toBe(200);
      const m = await w.issueNotice();
      expect((await w.admin("POST", "notice-withdraw", { noticeId: m.noticeId })).status).toBe(200);
      expect((await w.markDone(m.noticeId, irk.privateKey)).status).toBe(404);
    } finally {
      w.close();
    }
  });

  it("links the report, which moves to noticed, and refuses a report of another account", async () => {
    const w = await world();
    try {
      const r = (await w.report("app", "chess.alice.flagship.services")).body!.reportId as string;
      const ok = await w.admin("POST", "notice", { account: "alice", reportId: r, subjectKind: "app", subject: "chess.alice.flagship.services", category: "phishing", action: "modify", deadlineHours: 24 });
      expect(ok.status).toBe(200);
      expect((await w.admin("GET", `reports/${r}`)).body!.report.status).toBe("noticed");
      const wrong = await w.admin("POST", "notice", { account: "bob", reportId: r, subjectKind: "app", subject: "x", category: "spam", action: "modify", deadlineHours: 24 });
      expect(wrong.body!.code).toBe("wrong-account");
      expect((await w.admin("POST", "notice", { account: "alice", subjectKind: "app", subject: "x", category: "spam", action: "modify", deadlineHours: 0 })).status).toBe(400);
      expect((await w.call("POST", "/api/admin/abuse/notice", {}, { "x-admin-secret": "wrong" })).status).toBe(403);
    } finally {
      w.close();
    }
  });
});

describe("suspension", () => {
  it("is refused before the deadline unless urgent with csam, active-phishing or malware", async () => {
    const w = await world();
    try {
      const n = await w.issueNotice(24);
      const suspend = (b: Record<string, unknown>) => w.admin("POST", "suspend", { account: "alice", category: "phishing", reason: "Fake bank login", ...b });
      expect((await suspend({})).body!.code).toBe("before-deadline");
      expect((await suspend({ noticeId: n.noticeId })).body!.code).toBe("before-deadline");
      expect((await suspend({ urgent: true })).body!.code).toBe("not-urgent-category");
      expect((await suspend({ urgent: true, category: "spam" })).body!.code).toBe("not-urgent-category");
      const urgent = await suspend({ urgent: true, category: "active-phishing" });
      expect(urgent.status).toBe(200);
      expect(urgent.body!.serversRevoked).toEqual(["home.alice.flagship.services"]);
    } finally {
      w.close();
    }
  });

  it("after the deadline revokes the servers, takes the page down, holds the names, and un-suspend restores", async () => {
    const w = await world();
    try {
      const n = await w.issueNotice(24);
      w.setNow(T0 + 25 * 3_600_000);
      const res = await w.admin("POST", "suspend", { account: "alice", noticeId: n.noticeId, category: "phishing", reason: "The fake bank login is still up." });
      expect(res.body).toMatchObject({ ok: true, serversRevoked: ["home.alice.flagship.services"], pageTakenDown: true });
      expect((await w.storage.servers.get("home.alice.flagship.services"))!.revocationReason).toBe("suspended");
      expect((await w.storage.servers.get("lost.alice.flagship.services"))!.revocationReason).toBe("lost");
      expect(await w.db.prepare("SELECT reason FROM voici_takedowns WHERE username = 'alice'").first()).toEqual({ reason: "illegal" });
      expect((await w.admin("POST", "suspend", { account: "alice", category: "phishing", reason: "again" })).body!.code).toBe("already-suspended");

      const read = await w.call("GET", "/api/users/alice/abuse-notices", undefined, { authorization: `Bearer ${await w.irkToken()}` });
      expect(read.body!.suspension).toMatchObject({ category: "phishing", reason: "The fake bank login is still up.", appealEmail: "abuse@flagship.services" });

      const held = (path: string, body: unknown) =>
        suspensionGuard(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), w.db);
      expect((await held("/api/account/self-delete", { accountSelfDelete: { request: { username: "alice" } } }))!.status).toBe(403);
      expect((await held("/api/auth-code/issue", { code: { username: "alice" } }))!.status).toBe(403);
      expect((await held("/api/server/register", { request: { authCode: { username: "alice" } } }))!.status).toBe(403);
      expect((await held("/api/server/release", { request: { username: "alice" } }))!.status).toBe(403);
      expect((await held("/api/server/home.alice.flagship.services/transfer/offer", {}))!.status).toBe(403);
      expect(await held("/api/auth-code/issue", { code: { username: "bob" } })).toBeNull();

      const back = await w.admin("POST", "unsuspend", { account: "alice" });
      expect(back.body).toEqual({ ok: true, serversRestored: ["home.alice.flagship.services"], pageRestored: true });
      expect((await w.storage.servers.get("home.alice.flagship.services"))!.revokedAt).toBeUndefined();
      expect((await w.storage.servers.get("lost.alice.flagship.services"))!.revocationReason).toBe("lost");
      expect(await w.db.prepare("SELECT 1 AS x FROM voici_takedowns WHERE username = 'alice'").first()).toBeNull();
      expect(await suspensionOf(w.db, "alice")).toBeNull();
      expect(await held("/api/account/self-delete", { accountSelfDelete: { request: { username: "alice" } } })).toBeNull();
    } finally {
      w.close();
    }
  });

  it("a page the operator took down earlier stays down after un-suspend", async () => {
    const w = await world();
    try {
      await w.db.prepare("INSERT INTO voici_takedowns (username, reason, taken_down_at) VALUES ('alice', 'spam', 1)").run();
      await w.admin("POST", "suspend", { account: "alice", urgent: true, category: "malware", reason: "Serves malware." });
      expect((await w.admin("POST", "unsuspend", { account: "alice" })).body!.pageRestored).toBe(false);
      expect(await w.db.prepare("SELECT reason FROM voici_takedowns WHERE username = 'alice'").first()).toEqual({ reason: "spam" });
    } finally {
      w.close();
    }
  });
});

describe("retention", () => {
  it("drops resolved reports (with their contact) and closed notices after a year", async () => {
    const w = await world();
    try {
      const r = (await w.report("link", "voi.ci/chesspage", { contact: "me@example.org" })).body!.reportId as string;
      await w.admin("POST", "dismiss", { reportId: r });
      const n = await w.issueNotice();
      await w.admin("POST", "notice-withdraw", { noticeId: n.noticeId });
      await pruneAbuseCases(w.db, T0 + 364 * 86_400_000);
      expect(await w.db.prepare("SELECT COUNT(*) AS n FROM abuse_reports").first()).toEqual({ n: 1 });
      await pruneAbuseCases(w.db, T0 + 366 * 86_400_000);
      expect(await w.db.prepare("SELECT COUNT(*) AS n FROM abuse_reports").first()).toEqual({ n: 0 });
      expect(await w.db.prepare("SELECT COUNT(*) AS n FROM abuse_notices").first()).toEqual({ n: 0 });
    } finally {
      w.close();
    }
  });
});
