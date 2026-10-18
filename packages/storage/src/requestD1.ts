/**
 * A per-request view of a D1 binding that costs the Worker fewer D1 round
 * trips, with the same answers.
 *
 * Why: on the Workers Free plan a request gets 10 ms of CPU, and every D1
 * call spends about half a millisecond of it in the binding's JavaScript
 * (measured in workerd; docs/runbooks/final-deploy.md "Workers CPU budget").
 * The control plane's handlers make 5 to 16 calls per request, most of them
 * small reads that do not depend on each other. Two rules cut that:
 *
 *  1. Reads issued in the same turn of the event loop (a `Promise.all` of
 *     storage reads) go to D1 as ONE `batch()`. A batch is one round trip
 *     and one transaction. If the batch throws, each read is retried alone,
 *     so a failing read still fails on its own.
 *  2. A SELECT answered earlier in this request is answered again from
 *     memory, until something writes. The cache lives and dies with the
 *     request (one wrapper per request), so nothing outlives a revoke or a
 *     rotation: the next request reads the database again. Any write other
 *     than to a leaf table (replay nonces, rate-limit log) empties it, and a
 *     read that was in flight across a write is not kept.
 *
 * Handlers do not change: they still call the same storage methods, in the
 * same order, and `await` each result. A route that waits and re-reads to
 * watch for change (the held /stream) must use the raw binding.
 */

import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from "./d1.js";

/** Tables whose writes never change what a SELECT elsewhere returns. */
const LEAF_TABLES: ReadonlySet<string> = new Set(["boot_nonces", "rate_limit_log"]);

/** Most statements sent in one batch(). */
const MAX_BATCH = 25;

const SELECT_RE = /^\s*select\b/i;
const FROM_RE = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
const WRITE_TARGET_RE =
  /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+([a-z_][a-z0-9_]*)/i;

function isLeafWrite(sql: string): boolean {
  const target = WRITE_TARGET_RE.exec(sql)?.[1]?.toLowerCase();
  return target !== undefined && LEAF_TABLES.has(target);
}

function tablesRead(sql: string): string[] | null {
  const out = new Set<string>();
  for (const m of sql.matchAll(FROM_RE)) out.add(m[1]!.toLowerCase());
  return out.size > 0 ? [...out] : null;
}

function memoKey(mode: Mode, sql: string, binds: readonly unknown[]): string | null {
  try {
    return `${mode}\u0001${sql}\u0001${JSON.stringify(binds)}`;
  } catch {
    return null; // a bigint or a cycle: not worth caching
  }
}

type Mode = "first" | "all";

interface Entry {
  rows: unknown[];
  meta: unknown;
  tables: string[];
}

interface Waiting {
  stmt: D1PreparedStatement;
  mode: Mode;
  key: string | null;
  tables: string[] | null;
  epoch: number;
  settle: (r: { rows: unknown[]; meta: unknown } | { error: unknown }) => void;
}

const NEXT_TURNS = 3;

export class RequestD1 implements D1Database {
  private readonly memo = new Map<string, Entry>();
  private queue: Waiting[] = [];
  private flushScheduled = false;
  private epoch = 0;
  /** D1 round trips this wrapper has made, for tests and the CPU harness. */
  roundTrips = 0;

  constructor(
    private readonly inner: D1Database,
    private readonly opts: { cache?: boolean } = {},
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new RequestStatement(this, this.inner.prepare(query), query);
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    this.flushNow();
    const inner = stmts.map((s) => (s instanceof RequestStatement ? s.inner : s));
    // Reads and writes to leaf tables leave every cached read valid.
    const harmless = stmts.every(
      (s) => s instanceof RequestStatement && (SELECT_RE.test(s.sql) || isLeafWrite(s.sql)),
    );
    if (!harmless) this.invalidate();
    this.roundTrips++;
    try {
      return await this.inner.batch(inner);
    } finally {
      if (!harmless) this.invalidate();
    }
  }

  exec(query: string): Promise<unknown> {
    this.invalidate();
    return this.inner.exec ? this.inner.exec(query) : Promise.reject(new Error("exec unsupported"));
  }

  /** @internal */
  readStatement(
    stmt: RequestStatement,
    mode: Mode,
  ): Promise<{ rows: unknown[]; meta: unknown }> {
    const cacheable = this.opts.cache !== false;
    const key = cacheable ? memoKey(mode, stmt.sql, stmt.binds) : null;
    if (key !== null) {
      const hit = this.memo.get(key);
      if (hit) return Promise.resolve({ rows: hit.rows, meta: hit.meta });
      // The same read already waiting in this turn: share its answer.
      for (const w of this.queue) {
        if (w.key === key) {
          return new Promise((resolve, reject) => {
            const prior = w.settle;
            w.settle = (r) => {
              prior(r);
              if ("error" in r) reject(r.error);
              else resolve(r);
            };
          });
        }
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        stmt: stmt.inner,
        mode,
        key,
        tables: key === null ? null : tablesRead(stmt.sql),
        epoch: this.epoch,
        settle: (r) => ("error" in r ? reject(r.error) : resolve(r)),
      });
      this.scheduleFlush();
    });
  }

  /** @internal */
  async writeStatement<T>(stmt: RequestStatement, run: () => Promise<T>): Promise<T> {
    this.flushNow();
    const leaf = isLeafWrite(stmt.sql);
    if (!leaf) this.invalidate();
    this.roundTrips++;
    try {
      return await run();
    } finally {
      if (!leaf) this.invalidate();
    }
  }

  private invalidate(): void {
    this.epoch++;
    this.memo.clear();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Let sibling storage methods that await something small first (a hex
    // decode, a guard) reach their query before the batch leaves.
    let turns = NEXT_TURNS;
    const tick = () => {
      if (--turns > 0) queueMicrotask(tick);
      else this.flushNow();
    };
    queueMicrotask(tick);
  }

  private flushNow(): void {
    this.flushScheduled = false;
    const queue = this.queue;
    if (queue.length === 0) return;
    this.queue = [];
    for (let i = 0; i < queue.length; i += MAX_BATCH) {
      void this.send(queue.slice(i, i + MAX_BATCH));
    }
  }

  private async send(group: Waiting[]): Promise<void> {
    if (group.length === 1) {
      await this.sendAlone(group[0]!);
      return;
    }
    this.roundTrips++;
    let results: D1Result[];
    try {
      results = await this.inner.batch(group.map((w) => w.stmt));
    } catch {
      // One read failed the batch. Run them one by one so each fails or
      // succeeds on its own, as it would have without the wrapper.
      await Promise.all(group.map((w) => this.sendAlone(w)));
      return;
    }
    group.forEach((w, i) => {
      const r = results[i];
      this.finish(w, (r?.results as unknown[] | undefined) ?? [], r?.meta ?? {});
    });
  }

  /** One read on its own, through the same method the caller used. */
  private async sendAlone(w: Waiting): Promise<void> {
    this.roundTrips++;
    try {
      if (w.mode === "first") {
        const row = await w.stmt.first();
        this.finish(w, row === null || row === undefined ? [] : [row], {});
      } else {
        const r = await w.stmt.all();
        this.finish(w, r.results as unknown[], r.meta);
      }
    } catch (error) {
      w.settle({ error });
    }
  }

  private finish(w: Waiting, rows: unknown[], meta: unknown): void {
    if (w.key !== null && w.tables !== null && w.epoch === this.epoch) {
      this.memo.set(w.key, { rows, meta, tables: w.tables });
    }
    w.settle({ rows, meta });
  }
}

function copyRows<T>(rows: unknown[]): T[] {
  return rows.map((r) => (r !== null && typeof r === "object" ? { ...(r as object) } : r)) as T[];
}

class RequestStatement implements D1PreparedStatement {
  binds: unknown[] = [];

  constructor(
    private readonly owner: RequestD1,
    /** D1's bind() returns a NEW statement; this is the latest one. */
    public inner: D1PreparedStatement,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.binds = values;
    this.inner = this.inner.bind(...values);
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (!SELECT_RE.test(this.sql)) {
      return this.owner.writeStatement(this, () => this.inner.first<T>());
    }
    const { rows } = await this.owner.readStatement(this, "first");
    const row = rows[0];
    return row === undefined ? null : (copyRows<T>([row])[0] as T);
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: D1Meta }> {
    if (!SELECT_RE.test(this.sql)) {
      return this.owner.writeStatement(this, () => this.inner.all<T>());
    }
    const { rows, meta } = await this.owner.readStatement(this, "all");
    return { results: copyRows<T>(rows), success: true, meta: meta as D1Meta };
  }

  run(): Promise<D1Result> {
    return this.owner.writeStatement(this, () => this.inner.run());
  }
}
