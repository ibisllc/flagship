import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { currentAuthority, verifyMandateChainFromPin } from "@ibisllc/maintainers";
import {
  MAINTAINER_PINNED_MANDATE_HASH,
  ed,
  parseSecurityNotice,
  signSecurityNotice,
  verifySecurityNotice,
  type SecurityNoticeBody,
} from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { caTrustChainPublicMaterial } from "../src/caTrustChainLoader.js";
import { route, type RouteEnv } from "../src/route.js";
import {
  handleSecurityNotices,
  resetSecurityNoticesState,
} from "../src/securityNotices.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../.maintainers");
const DAY = 24 * 3600_000;
const T0 = Date.parse("2026-10-18T12:00:00Z");

const seed = new Uint8Array(32).fill(0x41);
const authority = { publicKey: ed.getPublicKey(seed), privateKey: seed };
const body: SecurityNoticeBody = {
  seq: 1,
  kind: "maintenance",
  validFrom: T0,
  validUntil: T0 + 3 * DAY,
  eventAt: T0 + 2 * DAY,
  lockFrom: 0,
  platforms: {},
  advisoryId: "",
  deprecatesProtocol: 0,
  reason: "",
  message: "We will update on {date}. Flagship may be briefly unavailable.",
};
const notice = signSecurityNotice(body, authority);

const get = (headers: Record<string, string> = {}, path = "/api/notices", method = "GET") =>
  new Request(`https://flagshipserver.com${path}`, { method, headers });

beforeEach(() => resetSecurityNoticesState());

describe("GET /api/notices", () => {
  it("answers 204 when no notice is in force, cacheable", async () => {
    const res = await handleSecurityNotices(get(), {}, undefined, { notice: null });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
  });

  it("serves the signed notice and the public mandate log, the same bytes for everyone", async () => {
    const deps = { notice, mandates: caTrustChainPublicMaterial().mandates };
    const a = await handleSecurityNotices(get(), {}, undefined, deps);
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const doc = (await a.json()) as { version: number; notice: unknown; mandates: unknown[] };
    expect(doc.version).toBe(1);
    expect(parseSecurityNotice(doc.notice)).not.toBeNull();
    expect(doc.mandates.length).toBeGreaterThan(0);

    const b = await handleSecurityNotices(
      get({ cookie: "session=abc", authorization: "Bearer secret", "x-flagship-device-id": "d1", "x-flagship-session": "s", "user-agent": "Flagship/1 (iPhone)" }, "/api/notices?u=harry&build=12"),
      {},
      undefined,
      deps,
    );
    expect(await b.text()).toBe(JSON.stringify(doc));
    expect(b.headers.get("set-cookie")).toBeNull();
  });

  it("answers a conditional request with 304 and no body", async () => {
    const deps = { notice };
    const first = await handleSecurityNotices(get(), {}, undefined, deps);
    const etag = first.headers.get("etag")!;
    const again = await handleSecurityNotices(get({ "if-none-match": etag }), {}, undefined, deps);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("allows only GET and HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handleSecurityNotices(get({}, "/api/notices", method), {}, undefined, { notice });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    const head = await handleSecurityNotices(get({}, "/api/notices", "HEAD"), {}, undefined, { notice });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("counts only totals, in batches, under a system account", async () => {
    const db = createSqliteD1();
    const env = { DB: db as unknown as D1Database };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const at = (t: number) => ({ notice: null, now: () => t });
    await handleSecurityNotices(get(), env, ctx, at(T0));
    await Promise.all(pending);
    await handleSecurityNotices(get(), env, ctx, at(T0 + 1_000));
    await handleSecurityNotices(get(), env, ctx, at(T0 + 2_000));
    await handleSecurityNotices(get({}, "/api/notices", "HEAD"), env, ctx, at(T0 + 3_000));
    await Promise.all(pending);
    let rows = await db.prepare("SELECT account, resource, period, amount FROM meter_counters WHERE resource = 'notice-fetch'").all();
    expect(rows.results).toEqual([{ account: "_system", resource: "notice-fetch", period: "2026-10-18", amount: 1 }]);

    await handleSecurityNotices(get(), env, ctx, at(T0 + 61_000));
    await Promise.all(pending);
    rows = await db.prepare("SELECT amount FROM meter_counters WHERE resource = 'notice-fetch'").all();
    expect(rows.results).toEqual([{ amount: 4 }]);
  });

  it("never fails a request because the counter is down", async () => {
    const broken = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    const res = await handleSecurityNotices(get(), { DB: broken }, undefined, { notice: null, now: () => T0 });
    expect(res.status).toBe(204);
  });
});

describe("through the Worker", () => {
  const env = (): RouteEnv => ({
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
  });

  it("is public: no preview cookie, no session, no rate-limit bindings needed", async () => {
    const res = await route(get(), env());
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("lets the webapp origin read it cross-origin", async () => {
    const res = await route(get({ origin: "https://webapp.flagshipserver.com" }), env());
    expect(res.headers.get("access-control-allow-origin")).toBe("https://webapp.flagshipserver.com");
    const pre = await route(
      new Request("https://flagshipserver.com/api/notices", { method: "OPTIONS", headers: { origin: "https://webapp.flagshipserver.com", "access-control-request-method": "GET" } }),
      env(),
    );
    expect(pre.status).toBe(204);
  });

  it("keeps the frame and sniffing protections every response carries", async () => {
    const res = await route(get(), env());
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("the committed notice", () => {
  const current = JSON.parse(readFileSync(join(ROOT, "notices", "current.json"), "utf8")) as unknown;

  it("is null, or a notice the ca-track authority signed", () => {
    if (current === null) return;
    const n = parseSecurityNotice(current);
    expect(n, "current.json must be a well-formed SecurityNotice").not.toBeNull();
    const mandates = caTrustChainPublicMaterial().mandates as never[];
    const chain = verifyMandateChainFromPin(MAINTAINER_PINNED_MANDATE_HASH, mandates);
    const auth = currentAuthority(chain, new Date(n!.validFrom));
    expect(auth, "no ca-track authority at the notice's validFrom").not.toBeNull();
    expect(verifySecurityNotice(n!, [auth!.holder])).toEqual({ ok: true });
  });
});
