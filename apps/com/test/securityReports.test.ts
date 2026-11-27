/**
 * The website's vulnerability report form (securityReports.ts) over a real D1-over-sqlite binding: a report is
 * stored only as an OpenPGP message to the pinned key (decrypted here with a throwaway key), the size caps and
 * severity check, the rate limit through the Worker router, the owner's email (skipped when unconfigured, never
 * failing the submission, carrying no report content) and the admin reader's gate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decrypt, generateKey, readKey, readMessage, readPrivateKey, type PrivateKey } from "openpgp";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { bindingSubject, endpointFor, LIMITS, SECURITY_REPORTS_PER_DAY } from "../src/rateLimit.js";
import {
  BUNDLED_KEY,
  DETAILS_MAX,
  encryptReport,
  handleSecurityReportRoute,
  SECURITY_REPORT_FORMAT,
  SUMMARY_MAX,
  type SecurityReportDeps,
  type SecurityReportKeyPin,
} from "../src/securityReports.js";
import { SECURITY_KEY_ARMORED } from "../src/securityReportKey.js";

const ORIGIN = "https://flagshipserver.com";
const ADMIN = "s3cret";
const T0 = Date.UTC(2026, 10, 27, 12);

async function throwawayKey(): Promise<{ pin: SecurityReportKeyPin; priv: PrivateKey }> {
  const { privateKey, publicKey } = await generateKey({ date: new Date(T0 - 86_400_000), type: "curve25519", userIDs: [{ name: "Test", email: "t@example.com" }], format: "armored" });
  const pub = await readKey({ armoredKey: publicKey });
  const enc = await pub.getEncryptionKey(undefined, new Date(T0));
  return {
    pin: { armored: publicKey, fingerprint: pub.getFingerprint(), encryptionSubkeyFingerprint: enc.getFingerprint() },
    priv: await readPrivateKey({ armoredKey: privateKey }),
  };
}

const KEY = await throwawayKey();

const report = (o: Record<string, unknown> = {}) => ({
  email: "researcher@example.com",
  severity: "low",
  component: "Webapp",
  summary: "The form drops reports",
  details: "POST /api/security/report answers 404.",
  ...o,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/security/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const adminGet = (secret?: string) =>
  new Request(`${ORIGIN}/api/admin/security-reports`, { headers: secret ? { "x-admin-secret": secret } : {} });

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

async function openReport(armored: string, key: PrivateKey = KEY.priv): Promise<Record<string, unknown>> {
  const { data } = await decrypt({ message: await readMessage({ armoredMessage: armored }), decryptionKeys: key });
  return JSON.parse(data as string) as Record<string, unknown>;
}

const deps = (o: Partial<SecurityReportDeps> = {}): SecurityReportDeps => ({ key: KEY.pin, now: () => T0, ...o });

describe("the bundled security key", () => {
  it("is the published key, pinned by fingerprint", async () => {
    const published = readFileSync(resolve(__dirname, "../../web/public/.well-known/pgp-key.txt"), "utf8");
    expect(SECURITY_KEY_ARMORED.trim()).toBe(published.trim());
    const k = await readKey({ armoredKey: SECURITY_KEY_ARMORED });
    expect(k.isPrivate()).toBe(false);
    expect(k.getFingerprint()).toBe(BUNDLED_KEY.fingerprint);
    expect((await k.getEncryptionKey(undefined, new Date(T0))).getFingerprint()).toBe(BUNDLED_KEY.encryptionSubkeyFingerprint);
  });

  it("encrypts to it as one SEIPD v1 message for the pinned subkey", async () => {
    const { armored, triage } = await encryptReport(
      { format: SECURITY_REPORT_FORMAT, id: "FLG-00", receivedAt: "x", severity: "low", component: "c", email: null, summary: "s", details: "d" },
      BUNDLED_KEY,
      new Date(T0),
    );
    const msg = await readMessage({ armoredMessage: armored });
    expect(msg.getEncryptionKeyIDs().map((k) => k.toHex())).toEqual([BUNDLED_KEY.encryptionSubkeyFingerprint.slice(-16)]);
    expect(armored).not.toContain("FLG-00");
    expect(triage).toBe(false);
  });

  it("refuses a key that is not the pinned one", async () => {
    const other = await throwawayKey();
    await expect(
      encryptReport(
        { format: SECURITY_REPORT_FORMAT, id: "FLG-00", receivedAt: "x", severity: "low", component: "c", email: null, summary: "s", details: "d" },
        { ...BUNDLED_KEY, armored: other.pin.armored },
        new Date(T0),
      ),
    ).rejects.toThrow(/fingerprint/);
    await expect(
      encryptReport(
        { format: SECURITY_REPORT_FORMAT, id: "FLG-00", receivedAt: "x", severity: "low", component: "c", email: null, summary: "s", details: "d" },
        { ...other.pin, encryptionSubkeyFingerprint: "00".repeat(20) },
        new Date(T0),
      ),
    ).rejects.toThrow(/subkey/);
  });
});

describe("POST /api/security/report", () => {
  it(
    "stores the report only as ciphertext, decryptable with the key, and answers its id",
    withDb(async (db, raw) => {
      const res = await handleSecurityReportRoute(post(report()), { DB: db }, deps());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reportId: string; status: string };
      expect(body.status).toBe("received");
      expect(body.reportId).toMatch(/^FLG-[0-9A-F]{16}$/);
      const rows = raw.raw.prepare("SELECT * FROM security_reports").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ id: body.reportId, received_at: T0, severity: "low", notify_status: "skipped", notify_at: null, triage: 0 });
      expect(Object.keys(row).sort()).toEqual(["ciphertext", "id", "notify_at", "notify_status", "received_at", "severity", "size_bytes", "triage"]);
      const dump = JSON.stringify(rows);
      for (const secret of ["researcher@example.com", "Webapp", "drops reports", "answers 404", "203.0.113.9"]) expect(dump).not.toContain(secret);
      const opened = await openReport(row.ciphertext as string);
      expect(opened).toEqual({
        format: SECURITY_REPORT_FORMAT,
        id: body.reportId,
        receivedAt: new Date(T0).toISOString(),
        severity: "low",
        component: "Webapp",
        email: "researcher@example.com",
        summary: "The form drops reports",
        details: "POST /api/security/report answers 404.",
      });
      expect(row.size_bytes).toBe(new TextEncoder().encode(JSON.stringify(opened)).length);
    }),
  );

  it(
    "takes a report without email or component",
    withDb(async (db, raw) => {
      const res = await handleSecurityReportRoute(post(report({ email: "", component: undefined })), { DB: db }, deps());
      expect(res.status).toBe(200);
      const row = raw.raw.prepare("SELECT ciphertext FROM security_reports").get() as { ciphertext: string };
      expect(await openReport(row.ciphertext)).toMatchObject({ email: null, component: "Other" });
    }),
  );

  it(
    "refuses a bad severity, bad lengths, a bad email, unknown fields and an oversized body, storing nothing",
    withDb(async (db, raw) => {
      const cases: [unknown, number, string][] = [
        [report({ severity: "urgent" }), 400, "bad-severity"],
        [report({ severity: undefined }), 400, "bad-severity"],
        [report({ summary: "" }), 400, "summary-length"],
        [report({ summary: "x".repeat(SUMMARY_MAX + 1) }), 400, "summary-length"],
        [report({ details: "   " }), 400, "details-length"],
        [report({ details: "x".repeat(DETAILS_MAX + 1) }), 400, "details-length"],
        [report({ component: "x".repeat(101) }), 400, "component-length"],
        [report({ email: "not an email" }), 400, "bad-email"],
        [report({ remoteAddr: "1.2.3.4" }), 400, "malformed"],
        [report({ summary: 5 }), 400, "malformed"],
        ["not json", 400, "malformed"],
        ["[]", 400, "malformed"],
        [report({ details: "x".repeat(200_000) }), 413, "too-large"],
      ];
      for (const [body, status, code] of cases) {
        const res = await handleSecurityReportRoute(post(body), { DB: db }, deps());
        expect(res.status, code).toBe(status);
        expect(((await res.json()) as { code: string }).code).toBe(code);
      }
      expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 0 });
      const max = await handleSecurityReportRoute(post(report({ summary: "x".repeat(SUMMARY_MAX), details: "é".repeat(DETAILS_MAX) })), { DB: db }, deps());
      expect(max.status).toBe(200);
    }),
  );

  it(
    "fails closed with 503 when the bundled key does not match its pin",
    withDb(async (db, raw) => {
      const res = await handleSecurityReportRoute(post(report()), { DB: db }, deps({ key: { ...KEY.pin, fingerprint: "11".repeat(20) } }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("unavailable");
      expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 0 });
    }),
  );

  it(
    "answers a filled honeypot like a success and stores nothing",
    withDb(async (db, raw) => {
      const res = await handleSecurityReportRoute(post(report({ website: "https://spam.example" })), { DB: db }, deps());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { reportId: string }).reportId).toMatch(/^FLG-[0-9A-F]{16}$/);
      expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 0 });
    }),
  );

  describe("Turnstile", () => {
    const tsEnv = { TURNSTILE_SITE_KEY: "0x4AAAAAAAtest", TURNSTILE_SECRET_KEY: "ts-secret" };
    const siteverify = (answer: () => Promise<Response>) => {
      const calls: { url: string; body: string }[] = [];
      const fetchFn = (async (u: string, init: RequestInit) => {
        calls.push({ url: u, body: String(init.body) });
        return answer();
      }) as unknown as typeof fetch;
      return { calls, fetchFn };
    };

    it(
      "is skipped while the secret or the site key is unset",
      withDb(async (db) => {
        const sv = siteverify(async () => Response.json({ success: false }));
        for (const env of [{ TURNSTILE_SITE_KEY: "0x4AAAAAAAtest" }, { TURNSTILE_SECRET_KEY: "ts-secret" }]) {
          const res = await handleSecurityReportRoute(post(report()), { DB: db, ...env }, deps({ fetchFn: sv.fetchFn }));
          expect(res.status).toBe(200);
        }
        expect(sv.calls).toEqual([]);
      }),
    );

    it(
      "stores a report only after Siteverify passes its token",
      withDb(async (db, raw) => {
        const pass = siteverify(async () => Response.json({ success: true, action: "security-report" }));
        const ok = await handleSecurityReportRoute(post(report({ turnstileToken: "tok-1" })), { DB: db, ...tsEnv }, deps({ fetchFn: pass.fetchFn }));
        expect(ok.status).toBe(200);
        expect(pass.calls).toHaveLength(1);
        expect(pass.calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
        expect(new URLSearchParams(pass.calls[0]!.body).get("response")).toBe("tok-1");
        expect(new URLSearchParams(pass.calls[0]!.body).get("secret")).toBe("ts-secret");
        expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 1 });

        const cases: [() => Promise<Response>, Record<string, unknown>, number, string][] = [
          [async () => Response.json({ success: false }), { turnstileToken: "bad" }, 403, "challenge-failed"],
          [async () => Response.json({ success: true, action: "login" }), { turnstileToken: "other" }, 403, "challenge-failed"],
          [async () => Response.json({ success: true }), {}, 403, "challenge-failed"],
          [async () => new Response("down", { status: 502 }), { turnstileToken: "t" }, 503, "challenge-unavailable"],
          [async () => { throw new Error("offline"); }, { turnstileToken: "t" }, 503, "challenge-unavailable"],
        ];
        for (const [answer, extra, status, code] of cases) {
          const sv = siteverify(answer);
          const res = await handleSecurityReportRoute(post(report(extra)), { DB: db, ...tsEnv }, deps({ fetchFn: sv.fetchFn }));
          expect(res.status, code).toBe(status);
          expect(((await res.json()) as { code: string }).code).toBe(code);
        }
        expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 1 });
      }),
    );

    it(
      "the form reads the site key only while the check is on",
      withDb(async (db) => {
        const get = () => new Request(`${ORIGIN}/api/security/report-config`);
        const on = await handleSecurityReportRoute(get(), { DB: db, ...tsEnv });
        expect(await on.json()).toEqual({ turnstileSiteKey: "0x4AAAAAAAtest" });
        const off = await handleSecurityReportRoute(get(), { DB: db, TURNSTILE_SITE_KEY: "0x4AAAAAAAtest" });
        expect(await off.json()).toEqual({ turnstileSiteKey: null });
      }),
    );
  });

  describe("the AI triage copy", () => {
    it(
      "is one message to both keys when the pinned triage key is set, and the row says so",
      withDb(async (db, raw) => {
        const triage = await throwawayKey();
        const env = { DB: db, SECURITY_REPORT_TRIAGE_KEY: triage.pin.armored, SECURITY_REPORT_TRIAGE_FINGERPRINT: triage.pin.fingerprint.toUpperCase() };
        const res = await handleSecurityReportRoute(post(report()), env, deps());
        expect(res.status).toBe(200);
        const row = raw.raw.prepare("SELECT ciphertext, triage FROM security_reports").get() as { ciphertext: string; triage: number };
        expect(row.triage).toBe(1);
        const msg = await readMessage({ armoredMessage: row.ciphertext });
        expect(msg.getEncryptionKeyIDs()).toHaveLength(2);
        expect(await openReport(row.ciphertext)).toMatchObject({ summary: "The form drops reports" });
        expect(await openReport(row.ciphertext, triage.priv)).toMatchObject({ summary: "The form drops reports" });
      }),
    );

    it(
      "is left out when the key does not match its pin, or only one of the two settings is there",
      withDb(async (db, raw) => {
        const triage = await throwawayKey();
        const envs = [
          { SECURITY_REPORT_TRIAGE_KEY: triage.pin.armored, SECURITY_REPORT_TRIAGE_FINGERPRINT: "22".repeat(20) },
          { SECURITY_REPORT_TRIAGE_KEY: triage.pin.armored },
          { SECURITY_REPORT_TRIAGE_FINGERPRINT: triage.pin.fingerprint },
        ];
        for (const env of envs) {
          const res = await handleSecurityReportRoute(post(report()), { DB: db, ...env }, deps());
          expect(res.status).toBe(200);
        }
        const rows = raw.raw.prepare("SELECT ciphertext, triage FROM security_reports").all() as { ciphertext: string; triage: number }[];
        expect(rows.map((r) => r.triage)).toEqual([0, 0, 0]);
        for (const r of rows) {
          expect((await readMessage({ armoredMessage: r.ciphertext })).getEncryptionKeyIDs()).toHaveLength(1);
          await expect(openReport(r.ciphertext, triage.priv)).rejects.toThrow();
        }
      }),
    );
  });

  describe("the owner's email", () => {
    const mailEnv = { RESEND_API_KEY: "re_test", SECURITY_REPORT_NOTIFY_TO: "owner@example.com", SECURITY_REPORT_NOTIFY_FROM: "Flagship <reports@example.com>" };

    it(
      "is skipped when unconfigured",
      withDb(async (db, raw) => {
        const calls: string[] = [];
        const fetchFn = (async (u: string) => {
          calls.push(u);
          return new Response("{}");
        }) as unknown as typeof fetch;
        for (const env of [{}, { RESEND_API_KEY: "re_test" }, { ...mailEnv, SECURITY_REPORT_NOTIFY_TO: "" }]) {
          const res = await handleSecurityReportRoute(post(report()), { DB: db, ...env }, deps({ fetchFn }));
          expect(res.status).toBe(200);
        }
        expect(calls).toEqual([]);
        const st = raw.raw.prepare("SELECT DISTINCT notify_status AS s FROM security_reports").all();
        expect(st).toEqual([{ s: "skipped" }]);
      }),
    );

    it(
      "goes out after the report is stored, with only the id, severity and time",
      withDb(async (db, raw) => {
        const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
        const fetchFn = (async (u: string, init: RequestInit) => {
          const stored = raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get() as { n: number };
          expect(stored.n).toBe(1);
          sent.push({ url: u, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
          return new Response('{"id":"x"}', { status: 200 });
        }) as unknown as typeof fetch;
        const pending: Promise<unknown>[] = [];
        const res = await handleSecurityReportRoute(post(report({ severity: "critical" })), { DB: db, ...mailEnv }, deps({ fetchFn, waitUntil: (p) => pending.push(p) }));
        expect(res.status).toBe(200);
        const { reportId } = (await res.json()) as { reportId: string };
        await Promise.all(pending);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.url).toBe("https://api.resend.com/emails");
        expect(sent[0]!.auth).toBe("Bearer re_test");
        expect(sent[0]!.body.to).toEqual(["owner@example.com"]);
        expect(sent[0]!.body.from).toBe("Flagship <reports@example.com>");
        const text = JSON.stringify(sent[0]!.body);
        expect(text).toContain(reportId);
        expect(text).toContain("critical");
        expect(text).toContain(new Date(T0).toISOString());
        for (const secret of ["researcher@example.com", "Webapp", "drops reports", "answers 404"]) expect(text).not.toContain(secret);
        expect(raw.raw.prepare("SELECT notify_status, notify_at FROM security_reports").get()).toEqual({ notify_status: "sent", notify_at: T0 });
      }),
    );

    it(
      "failing (an error answer or a thrown fetch) never fails the submission",
      withDb(async (db, raw) => {
        const answers = [
          async () => new Response("nope", { status: 500 }),
          async () => {
            throw new Error("network down");
          },
        ];
        for (const answer of answers) {
          const pending: Promise<unknown>[] = [];
          const res = await handleSecurityReportRoute(post(report()), { DB: db, ...mailEnv }, deps({ fetchFn: answer as unknown as typeof fetch, waitUntil: (p) => pending.push(p) }));
          expect(res.status).toBe(200);
          await Promise.all(pending);
        }
        expect(raw.raw.prepare("SELECT notify_status AS s FROM security_reports").all()).toEqual([{ s: "failed" }, { s: "failed" }]);
      }),
    );
  });
});

describe("through the Worker router", () => {
  it("is metered per network and by one daily cap", () => {
    expect(endpointFor("POST", "/api/security/report")).toBe("security-report");
    expect(LIMITS["security-report"]).toEqual([
      { axis: "ip", limit: 5, windowSec: 3600 },
      { axis: "subject", limit: SECURITY_REPORTS_PER_DAY, windowSec: 86_400 },
    ]);
    expect(bindingSubject("security-report", "/api/security/report")).toBe("all");
  });

  it(
    "takes 5 reports an hour from one network, then answers 429 with the limiter's sentence; the admin view needs the secret",
    withDb(async (db, raw) => {
      const { route } = await import("../src/route.js");
      const { memoryRateLimits } = await import("./rateLimitFakes.js");
      const rl = memoryRateLimits();
      const env = {
        SERVICES_BASE_URL: "https://flagship.services",
        ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
        DB: db,
        RATE_LIMITS: rl.ns,
        FLAGSHIP_ADMIN_SECRET: ADMIN,
      } as unknown as Parameters<typeof route>[1];
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 7; i++) {
        last = await route(post(report()), env);
        statuses.push(last.status);
      }
      // The bundled key is used here: a real report, encrypted to the security key.
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
      const refused = (await last!.json()) as { error: string; limit: string; message: string };
      expect(refused).toMatchObject({ error: "rate-limited", limit: "ip" });
      expect(refused.message).toMatch(/^Too many tries from your network\. Try again in about \d+ (?:minute|hour)s?\.$/);
      expect(rl.calls.some((c) => c.startsWith("security-report|subject|"))).toBe(true);
      expect(raw.raw.prepare("SELECT COUNT(*) AS n FROM security_reports").get()).toEqual({ n: 5 });
      const other = await route(post(report(), { "cf-connecting-ip": "198.51.100.4" }), env);
      expect(other.status).toBe(200);

      expect((await route(adminGet(), env)).status).toBe(401);
      expect((await route(adminGet("wrong"), env)).status).toBe(403);
      const view = await route(adminGet(ADMIN), env);
      expect(view.status).toBe(200);
      const { reports } = (await view.json()) as { reports: Record<string, unknown>[] };
      expect(reports).toHaveLength(6);
      expect(Object.keys(reports[0]!).sort()).toEqual(["ciphertext", "id", "notifyAt", "notifyStatus", "receivedAt", "severity", "sizeBytes", "triage"]);
      expect(String(reports[0]!.ciphertext)).toMatch(/^-----BEGIN PGP MESSAGE-----/);
    }),
  );

  it(
    "the daily cap refuses every network once reached",
    withDb(async (db) => {
      const { route } = await import("../src/route.js");
      const { memoryRateLimits } = await import("./rateLimitFakes.js");
      const rl = memoryRateLimits({ policy: (key) => !key.startsWith("security-report|subject|") });
      const env = {
        SERVICES_BASE_URL: "https://flagship.services",
        ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
        DB: db,
        RATE_LIMITS: rl.ns,
      } as unknown as Parameters<typeof route>[1];
      const res = await route(post(report(), { "cf-connecting-ip": "192.0.2.77" }), env);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { limit: string }).limit).toBe("subject");
    }),
  );
});

// Measures what the encryption costs (owner asked; not an assertion on speed beyond a generous ceiling).
describe("cost", () => {
  it("encrypts a full-size report to the real key in a few milliseconds once the key is parsed", async () => {
    const plaintext = { format: SECURITY_REPORT_FORMAT, id: "FLG-0", receivedAt: "t", severity: "high", component: "c", email: null, summary: "s".repeat(SUMMARY_MAX), details: "d".repeat(DETAILS_MAX) } as const;
    await encryptReport(plaintext, BUNDLED_KEY, new Date(T0));
    const runs = 20;
    const t = performance.now();
    for (let i = 0; i < runs; i++) await encryptReport(plaintext, BUNDLED_KEY, new Date(T0));
    const ms = (performance.now() - t) / runs;
    console.log(`security report encrypt: ${ms.toFixed(2)} ms per full-size report`);
    expect(ms).toBeLessThan(100);
  });
});
