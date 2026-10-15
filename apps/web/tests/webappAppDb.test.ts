// The owner's Database section on the webapp (docs/app-apis.md §6): the
// app-db-write canonical bytes and signature against the shared vectors, the
// box calls (stores, paged rows, read-only query, CSV), the needsGrant → signed
// resend flow and 409 re-sign, who sees the entry, and the page wiring.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIRK, verifyAppDbWriteGrant } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-db-write/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadDb = () => load("lib/appDb.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const owner = { requireOwnerProfile: () => {} };
const err = (status: number, body: Record<string, unknown>) => new ScreensError(String(body.error ?? ""), status, body);

type Case = {
  serverDomain: string;
  serviceId: string;
  store: string;
  sql: string;
  sqlSha256: string;
  issuedAt: number;
  canonical: string;
  signature: string;
};
const grantOf = (c: Case) => ({
  serverDomain: c.serverDomain,
  serviceId: c.serviceId,
  store: c.store,
  sqlSha256: c.sqlSha256,
  issuedAt: c.issuedAt,
});

describe("database writes — the shared vectors", () => {
  it("hashes the SQL, builds the canonical bytes and signs with the IRK of the UMK seed", async () => {
    const { appDbSqlSha256, canonicalAppDbWriteBytes, signAppDbWrite } = await loadDb();
    const { signWithIrk } = await load("keystore.js");
    const seed = fromHex(VECTORS.umkSeedHex);
    expect(hex(deriveIRK({ seed }).publicKey)).toBe(VECTORS.pub);
    for (const c of VECTORS.cases as Case[]) {
      expect(await appDbSqlSha256(c.sql)).toBe(c.sqlSha256);
      expect(utf8(canonicalAppDbWriteBytes(grantOf(c)))).toBe(c.canonical);
      const body = await signAppDbWrite({ ...grantOf(c), sql: c.sql, umk: seed, signWithIrk });
      expect(body).toEqual({ sql: c.sql, grant: grantOf(c), signature: c.signature });
      expect(verifyAppDbWriteGrant(grantOf(c), fromHex(body.signature), fromHex(VECTORS.pub))).toBe(true);
    }
  });

  it("signs with the sensitive-order key (admin root when held)", async () => {
    const { SENSITIVE_TAGS, canonicalTag, makeSensitiveSigner } = await load("lib/adminRoot.js");
    const { canonicalAppDbWriteBytes, TAG_APP_DB_WRITE } = await loadDb();
    expect(TAG_APP_DB_WRITE).toBe("flagship/app-db-write/v1");
    expect(SENSITIVE_TAGS.has(TAG_APP_DB_WRITE)).toBe(true);
    const bytes = canonicalAppDbWriteBytes(grantOf(VECTORS.cases[0]));
    expect(canonicalTag(bytes)).toBe(TAG_APP_DB_WRITE);
    const admin = vi.fn(async () => new Uint8Array(64).fill(1));
    const legacy = vi.fn(async () => new Uint8Array(64));
    await makeSensitiveSigner(new Uint8Array(32), legacy, { signWithAdminRoot: admin })(new Uint8Array(32), bytes);
    expect(admin).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("refuses a malformed grant before signing", async () => {
    const { canonicalAppDbWriteBytes } = await loadDb();
    const g = grantOf(VECTORS.cases[0]);
    expect(() => canonicalAppDbWriteBytes({ ...g, store: "" })).toThrow();
    expect(() => canonicalAppDbWriteBytes({ ...g, store: "a|b" })).toThrow();
    expect(() => canonicalAppDbWriteBytes({ ...g, serviceId: "a\nb" })).toThrow();
    expect(() => canonicalAppDbWriteBytes({ ...g, sqlSha256: "AB".repeat(32) })).toThrow();
    expect(() => canonicalAppDbWriteBytes({ ...g, issuedAt: 1.5 })).toThrow();
  });
});

describe("database — the box calls", () => {
  it("lists the stores defensively, and returns null when the box 404s (older box)", async () => {
    const { fetchDbStores } = await loadDb();
    const fetchJson = vi.fn(async () => ({
      stores: [
        {
          store: "default",
          tables: [
            { name: "items", kind: "table", rows: 1234, bytes: 81920 },
            { name: "audit.log", kind: "view", rows: null, bytes: 0 },
            { kind: "table" },
          ],
        },
        { tables: [] },
      ],
    }));
    expect(await fetchDbStores("harry-weather", fetchJson)).toEqual([
      {
        store: "default",
        tables: [
          { name: "items", kind: "table", rows: 1234, bytes: 81920 },
          { name: "audit.log", kind: "view", rows: null, bytes: 0 },
        ],
      },
    ]);
    expect(fetchJson).toHaveBeenCalledWith("/api/screens/services/harry-weather/db");
    const older = vi.fn(async () => { throw err(404, { error: "not found" }); });
    expect(await fetchDbStores("harry-weather", older)).toBeNull();
    const down = vi.fn(async () => { throw err(503, { error: "connection refused" }); });
    await expect(fetchDbStores("harry-weather", down)).rejects.toMatchObject({ status: 503 });
  });

  it("pages a table 100 rows at a time", async () => {
    const { fetchTableRows, hasNextPage, pageRangeText, DB_PAGE_SIZE } = await loadDb();
    expect(DB_PAGE_SIZE).toBe(100);
    const fetchJson = vi.fn(async () => ({
      columns: [{ name: "id", type: "integer" }, { name: "title", type: "text" }],
      rows: Array.from({ length: 100 }, (_, i) => [i + 101, `t${i}`]),
      total: 250,
    }));
    const page = await fetchTableRows({ serviceId: "harry-weather", store: "default", table: "audit.log", offset: 100, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith("/api/screens/services/harry-weather/db/default/tables/audit.log?offset=100&limit=100");
    expect(page.columns).toEqual([{ name: "id", type: "integer" }, { name: "title", type: "text" }]);
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(250);
    expect(pageRangeText({ offset: 100, rows: 100, total: 250 })).toBe("Rows 101–200 of 250");
    expect(hasNextPage({ offset: 100, rows: 100, limit: 100, total: 250 })).toBe(true);
    expect(hasNextPage({ offset: 200, rows: 50, limit: 100, total: 250 })).toBe(false);
    expect(hasNextPage({ offset: 0, rows: 100, limit: 100, total: null })).toBe(true);
    expect(pageRangeText({ offset: 0, rows: 0, total: 0 })).toBe("No rows");
  });

  it("runs a query read-only, unsigned", async () => {
    const { executeSql } = await loadDb();
    const fetchJson = vi.fn(async () => ({
      command: "SELECT",
      columns: [{ name: "n", type: "bigint" }],
      rows: [["3"]],
      rowCount: 1,
      truncated: false,
    }));
    const confirm = vi.fn();
    const signer = vi.fn();
    const out = await executeSql({ serviceId: "harry-weather", store: "default", sql: "SELECT count(*) AS n FROM items", fetchJson, confirm, signer }, owner);
    expect(out).toEqual({
      result: { command: "SELECT", columns: [{ name: "n", type: "bigint" }], rows: [["3"]], rowCount: 1, truncated: false },
      signed: false,
    });
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/api/screens/services/harry-weather/db/default/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ sql: "SELECT count(*) AS n FROM items" });
    expect(confirm).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it("a write (400 needsGrant) asks to confirm, then signs for the paired box and sends it again", async () => {
    const { executeSql } = await loadDb();
    const { signWithIrk } = await load("keystore.js");
    const c = VECTORS.cases[0] as Case;
    const bodies: Record<string, unknown>[] = [];
    const fetchJson = vi.fn(async (_path: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (!b.grant) throw err(400, { error: "cannot execute UPDATE in a read-only transaction", sqlState: "25006", needsGrant: true });
      return { command: "UPDATE", columns: [], rows: [], rowCount: 1, truncated: false };
    });
    const confirm = vi.fn(async () => true);
    const out = await executeSql(
      {
        serviceId: c.serviceId,
        store: c.store,
        sql: c.sql,
        fetchJson,
        confirm,
        signer: () => ({ serverDomain: c.serverDomain, umk: fromHex(VECTORS.umkSeedHex), signWithIrk }),
      },
      { ...owner, now: () => c.issuedAt },
    );
    expect(confirm).toHaveBeenCalledWith("");
    expect(out).toMatchObject({ signed: true, result: { command: "UPDATE", rowCount: 1 } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ sql: c.sql, grant: grantOf(c), signature: c.signature });
  });

  it("declining the confirmation sends nothing signed; other refusals throw", async () => {
    const { executeSql } = await loadDb();
    const fetchJson = vi.fn(async () => { throw err(400, { error: "x", needsGrant: true }); });
    const signer = vi.fn();
    const out = await executeSql({ serviceId: "s", store: "default", sql: "DELETE FROM t", fetchJson, confirm: async () => false, signer }, owner);
    expect(out).toEqual({ cancelled: true });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(signer).not.toHaveBeenCalled();
    const syntax = vi.fn(async () => { throw err(400, { error: 'syntax error at or near "SELEC"', sqlState: "42601", position: 1 }); });
    await expect(
      executeSql({ serviceId: "s", store: "default", sql: "SELEC 1", fetchJson: syntax, confirm: vi.fn(), signer }, owner),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("409 (that order was already used) asks again and signs a new order", async () => {
    const { executeSql } = await loadDb();
    const grants: { issuedAt: number }[] = [];
    let signed = 0;
    const fetchJson = vi.fn(async (_p: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      if (!b.grant) throw err(400, { error: "read-only", needsGrant: true });
      grants.push(b.grant);
      if (signed++ === 0) throw err(409, { error: "this signed order was already used: sign it again" });
      return { command: "DELETE", columns: [], rows: [], rowCount: 2, truncated: false };
    });
    const notes: string[] = [];
    const sign = vi.fn(async () => new Uint8Array(64));
    const out = await executeSql(
      {
        serviceId: "harry-weather",
        store: "default",
        sql: "DELETE FROM t",
        fetchJson,
        confirm: async (note: string) => { notes.push(note); return true; },
        signer: () => ({ serverDomain: "home.harry.flagship.services", umk: new Uint8Array(32), signWithIrk: sign }),
      },
      { ...owner, now: () => 1_700_000_000_000 },
    );
    expect(out).toMatchObject({ signed: true, result: { rowCount: 2 } });
    expect(notes).toEqual(["", "That confirmation was already used. Confirm again to run it."]);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(grants).toHaveLength(2);
    expect(grants[1]!.issuedAt).toBeGreaterThan(grants[0]!.issuedAt);
  });

  it("won't sign on a companion, locked, or without the paired box", async () => {
    const { runSignedQuery } = await loadDb();
    const sign = vi.fn();
    const fetchJson = vi.fn();
    const args = { serverDomain: "home.harry.flagship.services", serviceId: "s", store: "default", sql: "DELETE FROM t", umk: new Uint8Array(32), signWithIrk: sign, fetchJson };
    await expect(runSignedQuery(args, { requireOwnerProfile: () => { throw new Error("A remote browser can't sign"); } })).rejects.toThrow(/can't sign/);
    await expect(runSignedQuery({ ...args, umk: null }, owner)).rejects.toThrow(/Unlock/);
    await expect(runSignedQuery({ ...args, serverDomain: "" }, owner)).rejects.toThrow(/Pair/);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("exports a table as CSV with the session token, and says 413 plainly", async () => {
    const { fetchTableCsv, dbErrorMessage } = await loadDb();
    const makeError = (m: string, s: number, b: unknown) => new ScreensError(m, s, b);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-disposition": 'attachment; filename="audit.log.csv"' }),
      blob: async () => new Blob(["id,title\n1,a\n"], { type: "text/csv" }),
    }));
    const out = await fetchTableCsv({ serviceId: "harry-weather", store: "default", table: "audit.log", base: "https://home.example/", token: "tok", fetchImpl, makeError });
    expect(fetchImpl).toHaveBeenCalledWith("https://home.example/api/screens/services/harry-weather/db/default/tables/audit.log/export.csv", {
      headers: { "x-flagship-session": "tok" },
    });
    expect(out.filename).toBe("audit.log.csv");
    expect(await out.blob.text()).toBe("id,title\n1,a\n");
    const big = vi.fn(async () => ({ ok: false, status: 413, text: async () => JSON.stringify({ error: "the table is over 64 MB as CSV" }) }));
    const e = await fetchTableCsv({ serviceId: "s", store: "default", table: "t", base: "https://h", token: "tok", fetchImpl: big, makeError }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 413 });
    expect(dbErrorMessage(e)).toMatch(/too big to export/);
  });

  it("says the box's refusals plainly", async () => {
    const { dbErrorMessage } = await loadDb();
    expect(dbErrorMessage(err(400, { error: 'syntax error at or near "SELEC"', position: 1 }))).toBe('syntax error at or near "SELEC" (at character 1)');
    expect(dbErrorMessage(err(403, { error: "the order is stale: sign it again" }))).toMatch(/clock/);
    expect(dbErrorMessage(err(403, { error: "the order is for a different server" }))).toMatch(/different server/);
    expect(dbErrorMessage(err(403, { error: "invalid signature" }))).toMatch(/signature/);
    expect(dbErrorMessage(err(404, { error: "no such table" }))).toMatch(/isn't on this server/);
    expect(dbErrorMessage(err(503, { error: "connection refused" }))).toMatch(/couldn't reach/);
    expect(dbErrorMessage(err(413, { error: "the statement is too long" }))).toMatch(/too long/);
  });
});

describe("database — the screens", () => {
  it("lists each store's tables with approximate rows and size", async () => {
    const { renderDbTablesHtml } = await load("views/app-db.js");
    const html: string = renderDbTablesHtml([
      { store: "default", tables: [{ name: "items", kind: "table", rows: 1234, bytes: 81920 }, { name: "v<x>", kind: "view", rows: null, bytes: 0 }] },
    ]);
    expect(html).toContain('data-db-table="items"');
    expect(html).toContain("~1,234 rows");
    expect(html).toContain("82 KB");
    expect(html).toContain("v&lt;x&gt;");
    expect(html).toContain("rows unknown");
    expect(html).toContain('id="app-db-sql"');
    const many: string = renderDbTablesHtml([{ store: "a", tables: [] }, { store: "b", tables: [] }]);
    expect(many).toContain("No tables yet.");
    expect(many).toContain(">a</div>");
  });

  it("shows rows with column types, NULLs, paging and Export CSV", async () => {
    const { renderDbTablePageHtml } = await load("views/app-db.js");
    const html: string = renderDbTablePageHtml({
      columns: [{ name: "id", type: "integer" }, { name: "note", type: "text" }],
      rows: [[1, null], [2, "<b>"]],
      total: 2,
      offset: 0,
      limit: 100,
    });
    expect(html).toContain('class="db-grid-wrap"');
    expect(html).toContain('<div class="db-col-type">integer</div>');
    expect(html).toContain('<td class="db-null">NULL</td>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("Rows 1–2 of 2");
    expect(html).toContain('id="app-db-export"');
    expect(html).toContain('id="app-db-prev" class="secondary" disabled');
    expect(html).toContain('id="app-db-next" class="secondary" disabled');
  });

  it("shows a result's command, row count and truncated note, and the confirm prompt", async () => {
    const { renderQueryResultHtml, renderNeedsGrantHtml } = await load("views/app-db.js");
    const r: string = renderQueryResultHtml({ command: "SELECT", columns: [{ name: "n", type: "int4" }], rows: [[1]], rowCount: 1000, truncated: true });
    expect(r).toContain("SELECT · 1,000 rows");
    expect(r).toContain("data-db-truncated");
    const w: string = renderQueryResultHtml({ command: "UPDATE", columns: [], rows: [], rowCount: 1, truncated: false });
    expect(w).toContain("UPDATE · 1 row");
    expect(w).not.toContain("data-db-truncated");
    const ask: string = renderNeedsGrantHtml("That confirmation was already used. Confirm again to run it.");
    expect(ask).toContain("This changes data. Confirm to run it.");
    expect(ask).toContain('id="app-db-confirm"');
    expect(ask).toContain("already used");
  });

  it("the app's page shows Database for an owner with stores; hidden for a companion, a restricted device, an older box or no stores", async () => {
    const { renderDatabaseEntry, databaseEntryVisible } = await load("views/service-detail.js");
    const stores = [{ store: "default", tables: [{ name: "items", kind: "table", rows: 1, bytes: 1 }] }];
    const html: string = renderDatabaseEntry({ stores });
    expect(html).toContain("Database");
    expect(html).toContain("1 table");
    expect(html).toContain('id="sd-db-open"');
    expect(renderDatabaseEntry({ stores: null })).toBe("");
    expect(renderDatabaseEntry({ stores: [] })).toBe("");
    expect(renderDatabaseEntry({ error: "Your server couldn't reach this app's database." })).toContain('id="sd-db-open"');
    expect(databaseEntryVisible({ companion: false, deviceCapability: null })).toBe(true);
    expect(databaseEntryVisible({ companion: true, deviceCapability: null })).toBe(false);
    expect(databaseEntryVisible({ companion: false, deviceCapability: { scopes: ["browse"] } })).toBe(false);
  });

  it("the pages wire it and the shell precaches it", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain('<div id="sd-database"></div>');
    expect(detail).toContain("void loadDatabaseEntry(s);");
    expect(detail).toContain("if (!databaseEntryVisible()) return;");
    const view = await asset("/webapp/views/app-db.js");
    expect(view).toContain('registerView("view-app-db")');
    expect(view).toContain("signWithIrk: sensitiveSigner()");
    expect(view).toContain("serverDomain: podServerDomain()");
    expect(view).toContain("executeSql({");
    const html = await asset("/webapp/index.html");
    expect(html).toContain('<section id="view-app-db" class="hidden">');
    const app = await asset("/webapp/app.js");
    expect(app).toContain("initAppDbView()");
    const sw = await asset("/webapp/service-worker.js");
    for (const p of ['"/lib/appDb.js"', '"/views/app-db.js"']) expect(sw).toContain(p);
    expect(sw).toContain('SHELL_VERSION = "v82"');
  });
});
