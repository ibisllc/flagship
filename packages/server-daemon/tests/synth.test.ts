import { describe, expect, it } from "vitest";
import {
  parseSchema,
  generateSynthetic,
  datasetToSql,
} from "../src/dataLayer/synth/index.js";

const SCHEMA = `
CREATE TABLE users (
  id integer PRIMARY KEY,
  email text NOT NULL UNIQUE,
  full_name text,
  status text CHECK (status IN ('active','invited','disabled')),
  created_at timestamp
);

CREATE TABLE notes (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  title varchar(200) NOT NULL,
  body text,
  pinned boolean
);
`;

const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("synth schema parser", () => {
  it("parses tables, columns, types, and constraints", () => {
    const s = parseSchema(SCHEMA);
    expect(s.tables.map((t) => t.name)).toEqual(["users", "notes"]);
    const users = s.tables[0];
    const email = users.columns.find((c) => c.name === "email")!;
    expect(email.notNull).toBe(true);
    expect(email.unique).toBe(true);
    const status = users.columns.find((c) => c.name === "status")!;
    expect(status.enumValues).toEqual(["active", "invited", "disabled"]);
    const id = users.columns.find((c) => c.name === "id")!;
    expect(id.primaryKey).toBe(true);
    const userId = s.tables[1].columns.find((c) => c.name === "user_id")!;
    expect(userId.references).toEqual({ table: "users", column: "id" });
  });

  it("never throws on malformed / unfamiliar DDL", () => {
    expect(() => parseSchema("this is not sql;;; CREATE INDEX foo;")).not.toThrow();
    expect(parseSchema("").tables).toEqual([]);
  });
});

describe("synth generator", () => {
  it("is deterministic: same schema+seed ⇒ byte-identical dataset", () => {
    const a = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const b = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    expect(datasetToSql(a)).toBe(datasetToSql(b));
  });

  it("different seeds ⇒ different data", () => {
    const a = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const b = generateSynthetic({ sql: SCHEMA, seedHex: "ff".repeat(32) });
    expect(datasetToSql(a)).not.toBe(datasetToSql(b));
  });

  it("preserves foreign-key integrity (every notes.user_id points at a real users.id)", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const users = ds.pg.find((t) => t.table === "users")!;
    const notes = ds.pg.find((t) => t.table === "notes")!;
    const userIds = new Set(users.rows.map((r) => r.id));
    for (const n of notes.rows) {
      expect(userIds.has(n.user_id as number)).toBe(true);
    }
  });

  it("generates tables in FK-safe order (parent before child)", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const names = ds.pg.map((t) => t.table);
    expect(names.indexOf("users")).toBeLessThan(names.indexOf("notes"));
  });

  it("enforces uniqueness on unique columns", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const users = ds.pg.find((t) => t.table === "users")!;
    const emails = users.rows.map((r) => r.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("covers every enum value across the generated rows", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED, hints: { rowCounts: { users: 12 } } });
    const users = ds.pg.find((t) => t.table === "users")!;
    const statuses = new Set(users.rows.map((r) => r.status));
    for (const v of ["active", "invited", "disabled"]) expect(statuses.has(v)).toBe(true);
  });

  it("respects NOT NULL (never emits null for a NOT NULL column)", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED });
    const notes = ds.pg.find((t) => t.table === "notes")!;
    for (const n of notes.rows) {
      expect(n.title).not.toBeNull();
      expect(n.user_id).not.toBeNull();
    }
  });

  it("embeds canary tokens for downstream egress detection", () => {
    const ds = generateSynthetic({ sql: SCHEMA, seedHex: SEED, hints: { canaryCount: 2 } });
    expect(ds.canaries.length).toBeGreaterThan(0);
    const sql = datasetToSql(ds);
    for (const c of ds.canaries) expect(sql).toContain(c);
  });

  it("emits FK-safe SQL (users INSERTs precede notes INSERTs)", () => {
    const sql = datasetToSql(generateSynthetic({ sql: SCHEMA, seedHex: SEED }));
    expect(sql.indexOf('INTO "users"')).toBeLessThan(sql.indexOf('INTO "notes"'));
  });
});

describe("synth golden vector — reproducibility claim-support artifact", () => {
  it("regenerates the committed golden dataset byte-identically", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../../../test-vectors/synth/golden.json", import.meta.url));
    const golden = JSON.parse(readFileSync(path, "utf8"));
    const regen = generateSynthetic({ sql: golden.schema, seedHex: golden.seedHex });
    expect(datasetToSql(regen)).toBe(golden.sql);
    expect(regen).toEqual(golden.dataset);
  });
});
