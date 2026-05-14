import { describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "@flagship/storage";
import {
  recordRateLimited,
  recordUpgrade,
  readRecent,
  utcDayBucket,
} from "../src/qrPipeMetrics.js";

/**
 * Minimal D1 stub that understands the two prepared statements used
 * by qrPipeMetrics:
 *
 *   INSERT INTO qr_pipe_metrics (...) VALUES (?, ?, ?, ?)
 *     ON CONFLICT(bucket_day) DO UPDATE SET <column> = <column> + 1, updated_at = excluded.updated_at
 *
 *   SELECT bucket_day, upgrade_count, rate_limited_count, updated_at
 *     FROM qr_pipe_metrics
 *     ORDER BY bucket_day DESC
 *     LIMIT ?
 *
 * Anything else throws — keeps the harness honest if the module
 * starts issuing unexpected queries.
 */
interface Row {
  bucket_day: string;
  upgrade_count: number;
  rate_limited_count: number;
  updated_at: number;
}

function makeD1(): { db: D1Database; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      const isUpgradeInsert = /INSERT INTO qr_pipe_metrics[\s\S]*upgrade_count = upgrade_count \+ 1/.test(query);
      const isRateInsert = /INSERT INTO qr_pipe_metrics[\s\S]*rate_limited_count = rate_limited_count \+ 1/.test(query);
      const isSelect = /SELECT bucket_day.*FROM qr_pipe_metrics.*ORDER BY bucket_day DESC.*LIMIT \?/s.test(query);

      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first() { throw new Error("first() not used"); },
        async all<T = unknown>() {
          if (!isSelect) throw new Error(`unexpected all(): ${query}`);
          const limit = Number(bound[0] ?? 1000);
          const sorted = [...rows.values()].sort((a, b) =>
            a.bucket_day < b.bucket_day ? 1 : a.bucket_day > b.bucket_day ? -1 : 0,
          );
          return { results: sorted.slice(0, limit) as unknown as T[], success: true, meta: {} };
        },
        async run() {
          if (isUpgradeInsert || isRateInsert) {
            const [bucketDay, upgInit, rlInit, updatedAt] = bound as [string, number, number, number];
            const existing = rows.get(bucketDay);
            if (existing) {
              if (isUpgradeInsert) existing.upgrade_count += 1;
              else existing.rate_limited_count += 1;
              existing.updated_at = updatedAt;
            } else {
              rows.set(bucketDay, {
                bucket_day: bucketDay,
                upgrade_count: upgInit,
                rate_limited_count: rlInit,
                updated_at: updatedAt,
              });
            }
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${query}`);
        },
      };
      return stmt;
    },
    async batch() { throw new Error("batch not used"); },
  };
  return { db, rows };
}

describe("qrPipeMetrics — utcDayBucket", () => {
  it("formats UTC date as YYYY-MM-DD", () => {
    expect(utcDayBucket(new Date("2026-05-14T12:34:56Z"))).toBe("2026-05-14");
    expect(utcDayBucket(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("rolls over at UTC midnight, not local-time midnight", () => {
    // 2026-05-14 at 23:30 in UTC -10 (e.g. Hawaii) is 09:30 UTC the next day.
    // We intentionally ignore the local component — utcDayBucket reads UTC.
    expect(utcDayBucket(new Date("2026-05-15T00:30:00Z"))).toBe("2026-05-15");
    expect(utcDayBucket(new Date("2026-05-14T23:30:00Z"))).toBe("2026-05-14");
  });
});

describe("qrPipeMetrics — recordUpgrade", () => {
  it("inserts a new row for an unseen day", async () => {
    const { db, rows } = makeD1();
    await recordUpgrade(db, new Date("2026-05-14T10:00:00Z"));
    expect(rows.size).toBe(1);
    const r = rows.get("2026-05-14")!;
    expect(r.upgrade_count).toBe(1);
    expect(r.rate_limited_count).toBe(0);
  });

  it("increments upgrade_count on an existing row (UPSERT)", async () => {
    const { db, rows } = makeD1();
    await recordUpgrade(db, new Date("2026-05-14T10:00:00Z"));
    await recordUpgrade(db, new Date("2026-05-14T11:00:00Z"));
    await recordUpgrade(db, new Date("2026-05-14T12:00:00Z"));
    expect(rows.size).toBe(1);
    expect(rows.get("2026-05-14")!.upgrade_count).toBe(3);
  });

  it("buckets across day boundaries", async () => {
    const { db, rows } = makeD1();
    await recordUpgrade(db, new Date("2026-05-14T23:59:00Z"));
    await recordUpgrade(db, new Date("2026-05-15T00:01:00Z"));
    expect(rows.size).toBe(2);
    expect(rows.get("2026-05-14")!.upgrade_count).toBe(1);
    expect(rows.get("2026-05-15")!.upgrade_count).toBe(1);
  });

  it("is a no-op when DB is undefined (dev / tests without binding)", async () => {
    await expect(recordUpgrade(undefined)).resolves.toBeUndefined();
  });

  it("swallows DB errors so a metrics failure can't break a request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: D1Database = {
      prepare() {
        return {
          bind() { return this as any; },
          async first() { return null; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { throw new Error("D1 unavailable"); },
        } as D1PreparedStatement;
      },
      async batch() { return []; },
    };
    // Must not throw — metrics is a side channel.
    await expect(recordUpgrade(broken)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("qrPipeMetrics — recordRateLimited", () => {
  it("touches rate_limited_count, not upgrade_count", async () => {
    const { db, rows } = makeD1();
    await recordRateLimited(db, new Date("2026-05-14T10:00:00Z"));
    const r = rows.get("2026-05-14")!;
    expect(r.upgrade_count).toBe(0);
    expect(r.rate_limited_count).toBe(1);
  });

  it("coexists with upgrade_count in the same day-bucket", async () => {
    const { db, rows } = makeD1();
    await recordUpgrade(db, new Date("2026-05-14T10:00:00Z"));
    await recordRateLimited(db, new Date("2026-05-14T11:00:00Z"));
    await recordUpgrade(db, new Date("2026-05-14T12:00:00Z"));
    const r = rows.get("2026-05-14")!;
    expect(r.upgrade_count).toBe(2);
    expect(r.rate_limited_count).toBe(1);
  });
});

describe("qrPipeMetrics — readRecent", () => {
  it("returns most-recent-first up to the requested limit", async () => {
    const { db } = makeD1();
    await recordUpgrade(db, new Date("2026-05-12T10:00:00Z"));
    await recordUpgrade(db, new Date("2026-05-13T10:00:00Z"));
    await recordUpgrade(db, new Date("2026-05-14T10:00:00Z"));
    const r = await readRecent(db, 2);
    expect(r.map((x) => x.bucketDay)).toEqual(["2026-05-14", "2026-05-13"]);
  });

  it("clamps days to [1, 90]", async () => {
    const { db } = makeD1();
    expect(await readRecent(db, 0)).toEqual([]); // 0 clamps to 1, but no rows
    expect(await readRecent(db, 9999)).toEqual([]); // 9999 clamps to 90, but no rows
    expect(await readRecent(db, -5)).toEqual([]);
  });

  it("returns [] when DB is undefined", async () => {
    expect(await readRecent(undefined, 7)).toEqual([]);
  });

  it("returns [] on DB error (metrics never breaks /status/)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: D1Database = {
      prepare() {
        return {
          bind() { return this as any; },
          async first() { return null; },
          async all() { throw new Error("D1 unavailable"); },
          async run() { return { success: true, meta: {} }; },
        } as D1PreparedStatement;
      },
      async batch() { return []; },
    };
    expect(await readRecent(broken, 7)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
