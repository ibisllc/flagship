/**
 * The owner's Database section (dataLayer/ownerDb.ts, docs/app-apis.md §6):
 * live data as the app's own role, read-only unless the owner signed the
 * exact statement, companions refused, never part of the build tools.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appDbSqlSha256, deriveIRK, signAppDbWriteGrant, type AppDbWriteGrant } from "@flagship/protocol";
import { AppSqlError, NoSuchTableError, type AppSqlRunner, type QueryArgs } from "../src/dataLayer/appSql.js";
import { DbWriteLedger, OWNER_DB_MAX_ROWS, OWNER_DB_TIMEOUT_MS, buildOwnerDbHttp, isAppDbPath } from "../src/dataLayer/ownerDb.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import type { AppDataCredentials } from "../src/dataLayer/provisioner.js";
import type { HttpRequest } from "../src/runtime.js";

const BOX = "home.harry.flagship.services";
const NOW = 1_800_000_000_000;
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(9) });
const LIVE_URL = "postgresql://app_aaa:pw@host.flagship.internal:5432/app_aaa";

const DATA: AppDataCredentials = {
  creator: "harry",
  slug: "notes",
  postgresSingleton: true,
  postgres: { default: { url: LIVE_URL, database: "app_aaa", role: "app_aaa" } },
};

function fakeSql(over: Partial<AppSqlRunner> = {}) {
  const queries: QueryArgs[] = [];
  const calls: Array<{ op: string; a: Record<string, unknown> }> = [];
  const runner: AppSqlRunner = {
    query: async (a) => {
      queries.push(a);
      return { command: "SELECT", columns: [{ name: "n", type: "integer" }], rows: [[1]], rowCount: 1, truncated: false };
    },
    listTables: async (a) => {
      calls.push({ op: "listTables", a });
      return [{ name: "notes", kind: "table", rows: 3, bytes: 8192, columns: [{ name: "id", type: "integer", nullable: false }] }];
    },
    tableRows: async (a) => {
      calls.push({ op: "tableRows", a });
      if (a.table !== "notes") throw new NoSuchTableError(a.table);
      return { columns: [{ name: "id", type: "integer" }], rows: [[1]], total: 1 };
    },
    exportCsv: async (a) => {
      calls.push({ op: "exportCsv", a });
      return "id\r\n1\r\n";
    },
    ...over,
  };
  return { runner, queries, calls };
}

function setup(o: { sql?: Partial<AppSqlRunner>; adminRootPub?: Uint8Array; ledger?: DbWriteLedger; now?: () => number } = {}) {
  const sql = fakeSql(o.sql);
  const logs: string[] = [];
  const handle = buildOwnerDbHttp({
    serverDomain: BOX,
    username: "harry",
    ownerIrkPub: owner.publicKey,
    ...(o.adminRootPub ? { adminRootPub: o.adminRootPub } : {}),
    app: (id) => (id === "harry-notes" ? { data: DATA } : id === "harry-static" ? { data: null } : null),
    sql: sql.runner,
    ...(o.ledger ? { ledger: o.ledger } : {}),
    now: o.now ?? (() => NOW),
    log: (m) => logs.push(m),
  });
  return { handle, ...sql, logs };
}

const req = (method: string, path: string, body?: unknown): HttpRequest =>
  ({ method, path, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)) }) as HttpRequest;
type Handle = ReturnType<typeof setup>["handle"];
async function call(h: Handle, method: string, path: string, body?: unknown) {
  const res = await h(path.split("?")[0]!, method, req(method, path, body));
  if (!res) return null;
  const text = String(res.body);
  return { status: res.status, headers: res.headers ?? {}, text, body: res.headers?.["content-type"]?.startsWith("application/json") ? JSON.parse(text) : null };
}

const S = "/api/screens/services/harry-notes/db";
const Q = `${S}/default/query`;
const grantFor = (sql: string, o: Partial<AppDbWriteGrant> = {}): AppDbWriteGrant => ({
  serverDomain: BOX,
  serviceId: "harry-notes",
  store: "default",
  sqlSha256: appDbSqlSha256(sql),
  issuedAt: NOW - 1000,
  ...o,
});
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function signed(sql: string, o: Partial<AppDbWriteGrant> = {}, signer = owner, sqlSent = sql) {
  const grant = grantFor(sql, o);
  return { sql: sqlSent, grant, signature: hex(signAppDbWriteGrant(grant, signer)) };
}

describe("reading", () => {
  it("lists each store's tables, as the app's own role", async () => {
    const { handle, calls } = setup();
    const r = await call(handle, "GET", S);
    expect(r!.status).toBe(200);
    expect(r!.body).toEqual({ stores: [{ store: "default", tables: [{ name: "notes", kind: "table", rows: 3, bytes: 8192 }] }] });
    expect(calls[0]).toEqual({ op: "listTables", a: { pgUrl: LIVE_URL, timeoutMs: OWNER_DB_TIMEOUT_MS, columns: false } });
    expect((await call(handle, "GET", "/api/screens/services/harry-static/db"))!.body).toEqual({ stores: [] });
    expect((await call(handle, "GET", "/api/screens/services/harry-gone/db"))!.status).toBe(404);
    expect((await call(handle, "POST", S))!.status).toBe(405);
  });

  it("pages a table, capping limit at 1000", async () => {
    const { handle, calls } = setup();
    const r = await call(handle, "GET", `${S}/default/tables/notes?offset=20&limit=5000`);
    expect(r!.body).toEqual({ columns: [{ name: "id", type: "integer" }], rows: [[1]], total: 1 });
    expect(calls.at(-1)).toEqual({ op: "tableRows", a: { pgUrl: LIVE_URL, table: "notes", offset: 20, limit: OWNER_DB_MAX_ROWS, timeoutMs: OWNER_DB_TIMEOUT_MS } });
    await call(handle, "GET", `${S}/default/tables/notes`);
    expect(calls.at(-1)!.a).toMatchObject({ offset: 0, limit: 100 });
    expect((await call(handle, "GET", `${S}/default/tables/notes?limit=-1`))!.status).toBe(400);
    expect((await call(handle, "GET", `${S}/default/tables/missing`))!.status).toBe(404);
    expect((await call(handle, "GET", `${S}/levels/tables/notes`))!.status).toBe(404);
    expect((await call(handle, "GET", `${S}/__proto__/tables/notes`))!.status).toBe(404);
  });

  it("exports a table as a CSV download", async () => {
    const { handle } = setup();
    const r = await call(handle, "GET", `${S}/default/tables/${encodeURIComponent("app.my notes")}/export.csv`);
    expect(r!.status).toBe(200);
    expect(r!.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r!.headers["content-disposition"]).toBe('attachment; filename="app.my_notes.csv"');
    expect(r!.text).toBe("id\r\n1\r\n");
  });

  it("an unsigned query is read-only, single-statement, 15 s, at most 1000 rows", async () => {
    const { handle, queries } = setup();
    const r = await call(handle, "POST", Q, { sql: "SELECT count(*) FROM notes" });
    expect(r!.status).toBe(200);
    expect(r!.body).toEqual({ command: "SELECT", columns: [{ name: "n", type: "integer" }], rows: [[1]], rowCount: 1, truncated: false });
    expect(queries[0]).toEqual({
      pgUrl: LIVE_URL,
      sql: "SELECT count(*) FROM notes",
      readOnly: true,
      multiStatement: false,
      maxRows: 1000,
      timeoutMs: 15_000,
    });
    expect((await call(handle, "POST", Q, { sql: "  " }))!.status).toBe(400);
    expect((await call(handle, "POST", Q, { sql: "x".repeat(300 * 1024) }))!.status).toBe(413);
  });

  it("a write without a grant says it needs one", async () => {
    const { handle } = setup({
      sql: {
        query: async () => {
          throw new AppSqlError("cannot execute DELETE in a read-only transaction", "25006");
        },
      },
    });
    const r = await call(handle, "POST", Q, { sql: "DELETE FROM notes" });
    expect(r!.status).toBe(400);
    expect(r!.body).toEqual({ error: "cannot execute DELETE in a read-only transaction", sqlState: "25006", needsGrant: true });
  });

  it("a database that's down is a 503, a timeout a plain 400", async () => {
    const down = setup({
      sql: {
        listTables: async () => {
          throw new AppSqlError("couldn't connect", "08006");
        },
      },
    });
    expect((await call(down.handle, "GET", S))!.status).toBe(503);
    const slow = setup({
      sql: {
        query: async () => {
          throw new AppSqlError("the statement ran too long and was cancelled", "57014");
        },
      },
    });
    const r = await call(slow.handle, "POST", Q, { sql: "SELECT pg_sleep(99)" });
    expect(r!.status).toBe(400);
    expect(r!.body.sqlState).toBe("57014");
  });
});

describe("signed writes (flagship/app-db-write/v1)", () => {
  it("runs the exact signed statement read-write, multi-statement allowed", async () => {
    const { handle, queries, logs } = setup();
    const sql = "UPDATE notes SET done = true WHERE id = 7; DELETE FROM notes WHERE done";
    const r = await call(handle, "POST", Q, signed(sql));
    expect(r!.status).toBe(200);
    expect(queries[0]).toMatchObject({ sql, readOnly: false, multiStatement: true, maxRows: 1000, timeoutMs: 15_000 });
    expect(logs.join()).not.toContain("DELETE FROM");
  });

  it("refuses a different statement, server, app, store, signer or a stale order", async () => {
    const { handle, queries } = setup();
    const sql = "DELETE FROM notes";
    const cases: Array<[unknown, number, RegExp]> = [
      [signed(sql, {}, owner, "DELETE FROM notes WHERE true"), 403, /not the one that was signed/],
      [signed(sql, { serverDomain: "media.harry.flagship.services" }), 403, /different server/],
      [signed(sql, { serviceId: "harry-other" }), 400, /different app/],
      [signed(sql, { store: "levels" }), 400, /different store/],
      [signed(sql, {}, stranger), 403, /invalid signature/],
      [signed(sql, { issuedAt: NOW - 11 * 60_000 }), 403, /stale/],
      [signed(sql, { issuedAt: NOW + 11 * 60_000 }), 403, /stale/],
      [{ sql, grant: { ...grantFor(sql), sqlSha256: "ABC" }, signature: "00".repeat(64) }, 400, /malformed/],
      [{ sql, grant: grantFor(sql) }, 400, /signature required/],
      [{ sql, grant: grantFor(sql), signature: "zz" }, 400, /signature hex/],
    ];
    for (const [body, status, msg] of cases) {
      const r = await call(handle, "POST", Q, body);
      expect(r!.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(r!.body.error).toMatch(msg);
    }
    expect(queries).toEqual([]);
  });

  it("each order works once, also across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dbw-")), "app-db-writes.json");
    const a = setup({ ledger: new DbWriteLedger(path, () => NOW) });
    const body = signed("DELETE FROM notes");
    expect((await call(a.handle, "POST", Q, body))!.status).toBe(200);
    const again = await call(a.handle, "POST", Q, body);
    expect(again!.status).toBe(409);
    const b = setup({ ledger: new DbWriteLedger(path, () => NOW) });
    expect((await call(b.handle, "POST", Q, body))!.status).toBe(409);
    // The same statement signed again (a new issuedAt) is a new order.
    expect((await call(b.handle, "POST", Q, signed("DELETE FROM notes", { issuedAt: NOW - 500 })))!.status).toBe(200);
    expect(b.queries).toHaveLength(1);
  });

  it("the ledger forgets orders once they could never be fresh again", async () => {
    let t = NOW;
    const ledger = new DbWriteLedger(null, () => t);
    expect(await ledger.claim("k")).toBe(true);
    expect(await ledger.claim("k")).toBe(false);
    t += 25 * 60_000;
    expect(await ledger.claim("k")).toBe(true);
  });

  it("with an admin root pinned, only the admin root signs (the owner IRK no longer does)", async () => {
    const { handle } = setup({ adminRootPub: adminRoot.publicKey });
    expect((await call(handle, "POST", Q, signed("DELETE FROM notes", {}, owner)))!.status).toBe(403);
    expect((await call(handle, "POST", Q, signed("DELETE FROM notes", {}, adminRoot)))!.status).toBe(200);
  });
});

describe("where it is reachable", () => {
  it("routes through the screens API for the owner and refuses companions on every method", async () => {
    const { handle } = setup();
    const screens = (companion: boolean) =>
      buildScreensHttp({
        gate: { check: () => null },
        serverFqdn: BOX,
        username: "harry",
        daemonVersion: "t",
        startedAt: 0,
        pairedSessions: companion ? ({ list: () => [], isCompanionRequest: () => true } as never) : null,
        appDb: { handle },
      });
    const ownerApi = screens(false);
    expect((await ownerApi(req("GET", S)))!.status).toBe(200);
    expect((await ownerApi(req("POST", Q, { sql: "SELECT 1" })))!.status).toBe(200);
    const companion = screens(true);
    for (const [m, p] of [
      ["GET", S],
      ["GET", `${S}/default/tables/notes`],
      ["GET", `${S}/default/tables/notes/export.csv`],
      ["POST", Q],
    ] as const) {
      const r = await companion(req(m, p, m === "POST" ? { sql: "SELECT 1" } : undefined));
      expect(r!.status, p).toBe(403);
    }
  });

  it("isAppDbPath matches only the console paths", () => {
    expect(isAppDbPath(S)).toBe(true);
    expect(isAppDbPath(`${S}/default/tables/notes`)).toBe(true);
    expect(isAppDbPath(`${S}/default/tables/notes/export.csv`)).toBe(true);
    expect(isAppDbPath(Q)).toBe(true);
    expect(isAppDbPath(`${S}/default`)).toBe(false);
    expect(isAppDbPath("/api/screens/services/harry-notes/access")).toBe(false);
  });
});
