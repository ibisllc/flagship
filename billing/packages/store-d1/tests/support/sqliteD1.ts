// A D1 stand-in over node:sqlite: prepare/bind/first and batch() as one
// transaction, which is all D1MeterStore uses. Loaded through createRequire
// because Vite's resolver doesn't know the `node:sqlite` builtin.
import { createRequire } from "node:module";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../src/index.js";

interface Statement {
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
}
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Database };

class Stmt implements D1PreparedStatementLike {
  constructor(
    readonly db: Database,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  rows(): unknown[] {
    return this.db.prepare(this.sql).all(...this.values);
  }
}

export interface SqliteD1 extends D1DatabaseLike {
  /** Statements run through batch(), for asserting round trips. */
  batches: number;
  exec(sql: string): void;
  close(): void;
}

export function sqliteD1(): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  const d1: SqliteD1 = {
    batches: 0,
    prepare: (sql) => new Stmt(db, sql),
    async batch(statements) {
      d1.batches++;
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => ({ results: (s as Stmt).rows() }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
  return d1;
}
