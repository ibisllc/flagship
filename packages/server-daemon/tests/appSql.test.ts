/**
 * Bounded SQL as an app's own role (dataLayer/appSql.ts): the statement
 * sequence each call sends, against a scripted fake connection.
 */
import { describe, expect, it } from "vitest";
import {
  AppSqlError,
  ExportTooLargeError,
  NoSuchTableError,
  appSqlRunner,
  csvField,
  exportCsvOn,
  listTablesOn,
  looksLikeRowQuery,
  loopbackPgUrl,
  runBoundedQuery,
  tableRowsOn,
  trimStatement,
  type PgClientLike,
} from "../src/dataLayer/appSql.js";

interface Sent {
  text: string;
  extended: boolean;
  values?: unknown[];
}

type Reply = { command?: string; rowCount?: number | null; fields?: Array<{ name: string; dataTypeID: number }>; rows?: unknown[][] } | Error;

/** Answers each statement by the first matcher that fits; records everything sent. */
function fakeClient(script: Array<[RegExp, Reply | ((s: Sent) => Reply)]>) {
  const sent: Sent[] = [];
  let ended = false;
  const client: PgClientLike = {
    async query(cfg) {
      const s: Sent = { text: cfg.text, extended: cfg.queryMode === "extended", ...(cfg.values ? { values: cfg.values } : {}) };
      sent.push(s);
      if (/pg_type WHERE oid = ANY/.test(cfg.text)) {
        const oids = (cfg.values?.[0] as number[]) ?? [];
        const names: Record<number, string> = { 23: "integer", 25: "text", 16: "boolean" };
        return { command: "SELECT", rowCount: oids.length, fields: [], rows: oids.map((o) => [o, names[o] ?? "unknown"]) };
      }
      for (const [re, reply] of script) {
        if (!re.test(cfg.text)) continue;
        const r = typeof reply === "function" ? reply(s) : reply;
        if (r instanceof Error) throw r;
        return { command: r.command ?? "", rowCount: r.rowCount ?? null, fields: r.fields ?? [], rows: r.rows ?? [] };
      }
      return { command: "", rowCount: null, fields: [], rows: [] };
    },
    async end() {
      ended = true;
    },
  };
  return { client, sent, ended: () => ended, texts: () => sent.map((s) => s.text) };
}

const pgErr = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("runBoundedQuery", () => {
  it("a read-only row query runs through a cursor in a READ ONLY transaction and fetches one row past the cap", async () => {
    const f = fakeClient([
      [/^FETCH/, { command: "FETCH", fields: [{ name: "id", dataTypeID: 23 }, { name: "title", dataTypeID: 25 }], rows: [[1, "a"], [2, "b"], [3, "c"]] }],
    ]);
    const r = await runBoundedQuery(f.client, { sql: "SELECT * FROM notes;  \n", readOnly: true, maxRows: 2, timeoutMs: 15_000 });
    expect(r).toEqual({
      command: "SELECT",
      columns: [{ name: "id", type: "integer" }, { name: "title", type: "text" }],
      rows: [[1, "a"], [2, "b"]],
      rowCount: 2,
      truncated: true,
    });
    const t = f.texts();
    expect(t[0]).toBe("BEGIN READ ONLY");
    expect(t[1]).toBe("SET LOCAL statement_timeout = 15000");
    expect(t[2]).toMatch(/^SAVEPOINT/);
    expect(t[3]).toBe("DECLARE flagship_console NO SCROLL CURSOR FOR SELECT * FROM notes\n");
    expect(f.sent[3]!.extended).toBe(true);
    expect(t[4]).toBe("FETCH FORWARD 3 FROM flagship_console");
    expect(t.at(-1)).toBe("ROLLBACK");
  });

  it("anything else read-only goes over the extended protocol, which takes ONE statement", async () => {
    const f = fakeClient([[/^UPDATE/, pgErr("cannot execute UPDATE in a read-only transaction", "25006")]]);
    const e = await runBoundedQuery(f.client, { sql: "UPDATE notes SET title = 'x'", readOnly: true, maxRows: 10, timeoutMs: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(AppSqlError);
    expect((e as AppSqlError).readOnlyViolation).toBe(true);
    const upd = f.sent.find((s) => s.text.startsWith("UPDATE"))!;
    expect(upd.extended).toBe(true);
    expect(f.texts().at(-1)).toBe("ROLLBACK");
    expect(f.texts()).not.toContain("COMMIT");
  });

  it("falls back to running a row-looking statement as written when DECLARE refuses it", async () => {
    const f = fakeClient([
      [/^DECLARE/, pgErr("DECLARE CURSOR must not contain data-modifying statements in WITH", "0A000")],
      [/^WITH/, { command: "SELECT", rowCount: 1, fields: [{ name: "id", dataTypeID: 23 }], rows: [[9]] }],
    ]);
    const r = await runBoundedQuery(f.client, {
      sql: "WITH d AS (DELETE FROM notes RETURNING id) SELECT id FROM d",
      readOnly: true,
      maxRows: 10,
      timeoutMs: 1000,
    });
    expect(r.rows).toEqual([[9]]);
    expect(f.texts()).toContain("ROLLBACK TO SAVEPOINT flagship_console_cursor");
    expect(f.sent.find((s) => s.text.startsWith("WITH"))!.extended).toBe(true);
  });

  it("a signed write may hold several statements (simple protocol) and commits", async () => {
    const f = fakeClient([[/^UPDATE/, [{ command: "UPDATE", rowCount: 3 }][0]!]]);
    const r = await runBoundedQuery(f.client, {
      sql: "UPDATE notes SET done = true; UPDATE notes SET n = 1",
      readOnly: false,
      multiStatement: true,
      maxRows: 1000,
      timeoutMs: 15_000,
    });
    expect(r).toMatchObject({ command: "UPDATE", rowCount: 3, rows: [], columns: [], truncated: false });
    expect(f.texts()[0]).toBe("BEGIN");
    expect(f.sent.find((s) => s.text.startsWith("UPDATE"))!.extended).toBe(false);
    expect(f.texts().at(-1)).toBe("COMMIT");
  });

  it("multiStatement never applies to a read-only query", async () => {
    const f = fakeClient([[/^SHOW/, { command: "SHOW", rows: [["on"]], fields: [{ name: "x", dataTypeID: 25 }] }]]);
    await runBoundedQuery(f.client, { sql: "SHOW transaction_read_only", readOnly: true, multiStatement: true, maxRows: 5, timeoutMs: 1000 });
    expect(f.sent.find((s) => s.text.startsWith("SHOW"))!.extended).toBe(true);
  });

  it("reports a timeout plainly and rolls back", async () => {
    const f = fakeClient([[/^FETCH/, pgErr("canceling statement due to statement timeout", "57014")]]);
    const e = (await runBoundedQuery(f.client, { sql: "SELECT pg_sleep(60)", readOnly: true, maxRows: 5, timeoutMs: 15_000 }).catch((x) => x)) as AppSqlError;
    expect(e.timedOut).toBe(true);
    expect(e.message).toMatch(/ran too long/);
    expect(f.texts().at(-1)).toBe("ROLLBACK");
  });

  it("refuses an empty statement and COPY", async () => {
    const f = fakeClient([]);
    await expect(runBoundedQuery(f.client, { sql: " ;; ", readOnly: true, maxRows: 5, timeoutMs: 1 })).rejects.toThrow(/empty/);
    await expect(runBoundedQuery(f.client, { sql: "/* x */ copy notes to stdout", readOnly: true, maxRows: 5, timeoutMs: 1 })).rejects.toThrow(/COPY/);
    expect(f.sent).toEqual([]);
  });
});

describe("helpers", () => {
  it("looksLikeRowQuery skips comments and parentheses", () => {
    expect(looksLikeRowQuery("-- hi\n/* there */ (SELECT 1)")).toBe(true);
    expect(looksLikeRowQuery("values (1)")).toBe(true);
    expect(looksLikeRowQuery("TABLE notes")).toBe(true);
    expect(looksLikeRowQuery("selectx")).toBe(false);
    expect(looksLikeRowQuery("DELETE FROM notes")).toBe(false);
  });
  it("trimStatement drops trailing semicolons and blanks", () => {
    expect(trimStatement("SELECT 1 ; ;\n")).toBe("SELECT 1");
  });
  it("csvField quotes only when it must", () => {
    expect(csvField(null)).toBe("");
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(true)).toBe("true");
  });
  it("points the role's URL at the loopback Postgres", () => {
    expect(loopbackPgUrl("postgresql://app_x:p%40ss@host.flagship.internal:5432/app_x")).toBe("postgresql://app_x:p%40ss@127.0.0.1:5432/app_x");
  });
});

describe("schema, rows and CSV", () => {
  it("lists tables with estimates, counts small never-analyzed ones, and attaches columns", async () => {
    const f = fakeClient([
      [
        /FROM pg_catalog\.pg_class c\s+JOIN/,
        { rows: [["public", "notes", "r", -1, 16384], ["public", "big", "r", 5e6, 9e9], ["app", "v_open", "v", -1, 0]] },
      ],
      [/^SELECT count\(\*\) FROM "public"\."notes"/, { rows: [["42"]] }],
      [/FROM pg_catalog\.pg_attribute/, { rows: [["public", "notes", "id", "integer", false], ["public", "notes", "title", "text", true]] }],
    ]);
    const t = await listTablesOn(f.client, { timeoutMs: 1000 });
    expect(t).toEqual([
      { name: "notes", kind: "table", rows: 42, bytes: 16384, columns: [{ name: "id", type: "integer", nullable: false }, { name: "title", type: "text", nullable: true }] },
      { name: "big", kind: "table", rows: 5e6, bytes: 9e9, columns: [] },
      { name: "app.v_open", kind: "view", rows: null, bytes: 0, columns: [] },
    ]);
    expect(f.texts()[0]).toBe("BEGIN READ ONLY");
    expect(f.texts().some((x) => x.includes('"big"'))).toBe(false);
  });

  it("resolves a table through the catalog before reading it, never by the name it was sent", async () => {
    const f = fakeClient([
      [/WHERE n\.nspname = \$1/, (s) => ({ rows: s.values![0] === "app" && s.values![1] === "we\"ird" ? [["app", 'we"ird']] : [] })],
      [/^SELECT \* FROM/, { fields: [{ name: "id", dataTypeID: 23 }], rows: [[1]] }],
      [/^SELECT count/, { rows: [["7"]] }],
    ]);
    const r = await tableRowsOn(f.client, { table: 'app.we"ird', offset: 5, limit: 10, timeoutMs: 1000 });
    expect(r).toEqual({ columns: [{ name: "id", type: "integer" }], rows: [[1]], total: 7 });
    expect(f.texts()).toContain('SELECT * FROM "app"."we""ird" LIMIT 10 OFFSET 5');
    await expect(tableRowsOn(fakeClient([]).client, { table: "nope; DROP TABLE x", offset: 0, limit: 1, timeoutMs: 1 })).rejects.toBeInstanceOf(
      NoSuchTableError,
    );
  });

  it("exports a whole table in batches, and refuses one too big", async () => {
    let batch = 0;
    const f = fakeClient([
      [/WHERE n\.nspname = \$1/, { rows: [["public", "notes"]] }],
      [
        /^FETCH/,
        () => {
          batch++;
          const rows = batch === 1 ? Array.from({ length: 2000 }, (_, i) => [i, `t${i}`]) : [[2000, 'a "q"']];
          return { fields: [{ name: "id", dataTypeID: 23 }, { name: "title", dataTypeID: 25 }], rows };
        },
      ],
    ]);
    const csv = await exportCsvOn(f.client, { table: "notes", timeoutMs: 1000, maxBytes: 1e6 });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,title");
    expect(lines).toHaveLength(2003);
    expect(lines[2001]).toBe('2000,"a ""q"""');
    expect(f.texts()).toContain('DECLARE flagship_console NO SCROLL CURSOR FOR SELECT * FROM "public"."notes"');

    const g = fakeClient([
      [/WHERE n\.nspname = \$1/, { rows: [["public", "notes"]] }],
      [/^FETCH/, { fields: [{ name: "x", dataTypeID: 25 }], rows: [["x".repeat(100)], ["y".repeat(100)]] }],
    ]);
    await expect(exportCsvOn(g.client, { table: "notes", timeoutMs: 1000, maxBytes: 150 })).rejects.toBeInstanceOf(ExportTooLargeError);
    expect(g.texts().at(-1)).toBe("ROLLBACK");
  });

  it("the runner opens one connection per call and always closes it", async () => {
    const f = fakeClient([[/^FETCH/, { fields: [], rows: [] }]]);
    const urls: string[] = [];
    const runner = appSqlRunner(async ({ pgUrl }) => {
      urls.push(pgUrl);
      return f.client;
    });
    await runner.query({ pgUrl: "postgresql://r:p@h:5432/d", sql: "select 1", readOnly: true, maxRows: 1, timeoutMs: 1 });
    expect(urls).toEqual(["postgresql://r:p@h:5432/d"]);
    expect(f.ended()).toBe(true);
    const down = appSqlRunner(async () => {
      throw new Error("ECONNREFUSED");
    });
    const e = (await down.listTables({ pgUrl: "postgresql://r:p@h/d", timeoutMs: 1 }).catch((x) => x)) as AppSqlError;
    expect(e.sqlState).toBe("08006");
  });
});
