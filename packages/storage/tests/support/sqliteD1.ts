/**
 * A `node:sqlite`-backed implementation of the duck-typed `D1Database`
 * surface that `src/d1.ts` expects. This lets the parity suite drive the
 * REAL production D1 adapter (the one the Worker runs) against an
 * in-process SQLite that has the EXACT prod schema applied — every
 * migration 0001..0048, in order.
 *
 * Why node:sqlite (not better-sqlite3 / miniflare): it ships with Node
 * 22+ (this repo runs Node 24), so the parity harness adds ZERO new
 * dependencies. The repo had no SQLite/D1 test dep at all; pulling in
 * better-sqlite3 (native build) or miniflare (heavy) for this one harness
 * was unwarranted given node:sqlite satisfies the whole surface.
 *
 * Fidelity notes (the D1 quirks the adapter relies on, and how the shim
 * reproduces them faithfully):
 *
 *   • `meta.changes` — D1 reports affected-row count here; the adapter
 *     branches on it for every conditional UPDATE / CAS / OR-IGNORE. The
 *     shim maps node:sqlite's `StatementSync.run().changes` straight
 *     through. `INSERT OR IGNORE` on a conflict ⇒ changes:0 in both, and
 *     a UNIQUE violation THROWS in both (the adapter try/catches those).
 *
 *   • Positional `?` AND indexed `?N` placeholders (the adapter uses
 *     both, and reuses `?1` across two predicates while binding ONE
 *     value — see D1UsernameAliasStorage.isConsumed). node:sqlite's
 *     varargs binding can't reuse an index when fewer args are supplied,
 *     so the shim rewrites the SQL to named params (`:pN`) and passes a
 *     params object, which node:sqlite binds by-name (reuse-safe).
 *
 *   • Value coercion — D1 accepts JS booleans + `undefined` as bind
 *     values; node:sqlite rejects both. The adapter almost always
 *     pre-coerces (`x ? 1 : 0`), but the shim coerces defensively so a
 *     stray boolean can't make the harness diverge from prod for the
 *     wrong reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../src/d1.js";

// `node:sqlite` is a Node 22+ builtin, but Vite's resolver strips the
// `node:` prefix and then fails to find a bare `sqlite` module at
// transform time. Loading it through createRequire defers resolution to
// the Node runtime (which knows the builtin), keeping this entirely
// inside the test-support file — no shared vitest-config change needed.
const nodeRequire = createRequire(import.meta.url);
type SqliteRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };
interface StatementSync {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
}
interface DatabaseSync {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  close(): void;
}
interface DatabaseSyncCtor {
  new (path: string): DatabaseSync;
}
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

type BindValue = string | number | bigint | null | Uint8Array;

function coerce(v: unknown): BindValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    v instanceof Uint8Array
  ) {
    return v;
  }
  // Fallthrough: D1 would coerce/throw; surface a clear error.
  throw new Error(`sqliteD1 shim: cannot bind value of type ${typeof v}`);
}

/**
 * Rewrite a query that mixes anonymous `?` and indexed `?N` placeholders
 * into one using only named `:pN` placeholders, AND compute the mapping
 * from the caller's positional `.bind(...)` args to those names.
 *
 * Anonymous `?` consume args left-to-right (1,2,3,...). Indexed `?N`
 * binds the Nth positional arg (and may repeat). The two styles are never
 * mixed within a single statement in src/d1.ts, but the rewriter handles
 * either uniformly: every placeholder becomes `:p<index>` where <index>
 * is its 1-based positional slot.
 */
function rewrite(sql: string): { text: string; maxIndex: number } {
  let anonCounter = 0;
  let maxIndex = 0;
  // Only treat `?` outside string literals as a placeholder. The d1.ts
  // SQL never embeds a literal `?` inside a quoted string, but guard
  // anyway by skipping single-quoted runs.
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // copy the whole quoted literal verbatim (handles '' escapes)
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") {
          // doubled '' is an escaped quote — stay inside
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "?") {
      let j = i + 1;
      let digits = "";
      while (j < sql.length && sql[j] >= "0" && sql[j] <= "9") {
        digits += sql[j];
        j++;
      }
      let idx: number;
      if (digits.length > 0) {
        idx = parseInt(digits, 10);
        i = j;
      } else {
        anonCounter += 1;
        idx = anonCounter;
        i += 1;
      }
      if (idx > maxIndex) maxIndex = idx;
      out += `:p${idx}`;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, maxIndex };
}

class SqliteD1Statement implements D1PreparedStatement {
  private bound: BindValue[] = [];
  private readonly rewritten: { text: string; maxIndex: number };

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {
    this.rewritten = rewrite(sql);
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.bound = values.map(coerce);
    return this;
  }

  private paramsObject(): Record<string, BindValue> {
    const obj: Record<string, BindValue> = {};
    for (let n = 1; n <= this.rewritten.maxIndex; n++) {
      // positional arg n-1 maps to :pN; missing ⇒ null (D1 would error,
      // but the adapter never under-binds a max-index placeholder).
      obj[`p${n}`] = this.bound[n - 1] ?? null;
    }
    return obj;
  }

  private prepared(): StatementSync {
    return this.db.prepare(this.rewritten.text);
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.prepared();
    const row =
      this.rewritten.maxIndex > 0
        ? stmt.get(this.paramsObject())
        : stmt.get();
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{
    results: T[];
    success: boolean;
    meta: { changes?: number; rows_read?: number };
  }> {
    const stmt = this.prepared();
    const rows =
      this.rewritten.maxIndex > 0
        ? stmt.all(this.paramsObject())
        : stmt.all();
    return {
      results: rows as T[],
      success: true,
      meta: { rows_read: rows.length },
    };
  }

  async run(): Promise<D1Result> {
    const stmt = this.prepared();
    const r =
      this.rewritten.maxIndex > 0
        ? stmt.run(this.paramsObject())
        : stmt.run();
    return {
      success: true,
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
      },
    };
  }
}

/** Files whose specific statements are documented prod-only fixups that
 *  legitimately no-op against a fresh schema (the schema source-of-truth
 *  files were edited in-place pre-launch). Tolerated error fragments
 *  scope WHICH errors are benign, so an unexpected failure still throws. */
const TOLERATED_ERROR_FRAGMENTS = [
  "duplicate column name", // re-adding an already-present column
  "no such column", // RENAME COLUMN whose source no longer exists (0026)
];

function splitStatements(sql: string): string[] {
  // Drop full-line `--` comments, then split on `;` at end-of-line. The
  // migration files keep every statement on its own line(s) terminated
  // by `;\n`, with no `;` inside string literals — verified across
  // 0001..0048.
  const noComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return noComments
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply every migration 0001..NNNN in lexical order to `db`, statement by
 * statement, tolerating ONLY the documented idempotency no-ops (a column
 * re-add or a rename whose source column is already gone). Any other DDL
 * error throws — so genuine schema drift in a migration surfaces here.
 *
 * This is also a live demonstration of the OPS-B idempotent-apply idiom:
 * a manual `--file` re-run is safe iff the runner treats these specific
 * errors as no-ops. The harness encodes exactly that policy.
 */
export function applyAllMigrations(db: DatabaseSync): {
  applied: string[];
  toleratedNoOps: { file: string; error: string }[];
} {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const toleratedNoOps: { file: string; error: string }[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of splitStatements(sql)) {
      try {
        db.exec(stmt);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (TOLERATED_ERROR_FRAGMENTS.some((frag) => msg.includes(frag))) {
          toleratedNoOps.push({ file, error: msg });
          continue;
        }
        throw new Error(`migration ${file} failed: ${msg}\n  stmt: ${stmt.slice(0, 200)}`);
      }
    }
  }
  return { applied: files, toleratedNoOps };
}

/** A `D1Database` (duck-typed for src/d1.ts) backed by an in-process,
 *  fully-migrated SQLite. `close()` releases the handle. */
export interface SqliteD1 extends D1Database {
  readonly raw: DatabaseSync;
  close(): void;
  toleratedNoOps: { file: string; error: string }[];
}

export function createSqliteD1(): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  // Match D1: enforce FK + UNIQUE semantics (D1 has FKs on by default).
  raw.exec("PRAGMA foreign_keys = ON;");
  const { toleratedNoOps } = applyAllMigrations(raw);
  return {
    raw,
    toleratedNoOps,
    prepare(query: string) {
      return new SqliteD1Statement(raw, query);
    },
    async batch(stmts: D1PreparedStatement[]) {
      // src/d1.ts never calls batch(), but satisfy the interface: run
      // each sequentially (no cross-statement transaction needed for the
      // adapter's current shape).
      const out: D1Result[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(query: string) {
      raw.exec(query);
      return { count: 0, duration: 0 };
    },
    close() {
      raw.close();
    },
  };
}
