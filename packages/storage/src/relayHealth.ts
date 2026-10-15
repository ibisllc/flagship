// How setup calls from boxes with an outbound proxy reached `.com`
// (docs/outbound-proxy.md §OHTTP): through the private relay, or directly
// because the relay failed. Counts per UTC day only (no box, no address),
// plus the latest daily relay probe.

export type RelayArrivalPath = "ohttp" | "direct-fallback";

export interface RelayProbeRecord {
  ok: boolean;
  at: number;
  detail: string;
}

export interface RelayHealthStorage {
  bump(day: string, path: RelayArrivalPath): Promise<void>;
  /** Counts for the given days (missing days count 0). */
  counts(days: readonly string[]): Promise<Record<RelayArrivalPath, number>>;
  recordProbe(p: RelayProbeRecord): Promise<void>;
  lastProbe(): Promise<RelayProbeRecord | null>;
}

interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
}

export class D1RelayHealthStorage implements RelayHealthStorage {
  constructor(private readonly db: D1Like) {}

  async bump(day: string, path: RelayArrivalPath) {
    await this.db
      .prepare(
        `INSERT INTO relay_arrivals (day, path, count) VALUES (?1, ?2, 1)
         ON CONFLICT(day, path) DO UPDATE SET count = count + 1`,
      )
      .bind(day, path)
      .run();
  }

  async counts(days: readonly string[]) {
    const out: Record<RelayArrivalPath, number> = { ohttp: 0, "direct-fallback": 0 };
    if (days.length === 0) return out;
    const marks = days.map((_, i) => `?${i + 1}`).join(",");
    const rows = await this.db
      .prepare(`SELECT path, SUM(count) AS n FROM relay_arrivals WHERE day IN (${marks}) GROUP BY path`)
      .bind(...days)
      .all<{ path: string; n: number }>();
    for (const r of rows.results ?? []) {
      if (r.path === "ohttp" || r.path === "direct-fallback") out[r.path] = Number(r.n) || 0;
    }
    return out;
  }

  async recordProbe(p: RelayProbeRecord) {
    await this.db
      .prepare(
        `INSERT INTO relay_probes (id, ok, at, detail) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, at = excluded.at, detail = excluded.detail`,
      )
      .bind(p.ok ? 1 : 0, p.at, p.detail.slice(0, 200))
      .run();
  }

  async lastProbe() {
    const r = await this.db
      .prepare("SELECT ok, at, detail FROM relay_probes WHERE id = 1")
      .bind()
      .first<{ ok: number; at: number; detail: string }>();
    return r ? { ok: r.ok === 1, at: Number(r.at), detail: r.detail } : null;
  }
}

export class InMemoryRelayHealthStorage implements RelayHealthStorage {
  private rows = new Map<string, number>();
  private probe: RelayProbeRecord | null = null;

  async bump(day: string, path: RelayArrivalPath) {
    const k = `${day}|${path}`;
    this.rows.set(k, (this.rows.get(k) ?? 0) + 1);
  }

  async counts(days: readonly string[]) {
    const out: Record<RelayArrivalPath, number> = { ohttp: 0, "direct-fallback": 0 };
    for (const d of days) {
      out.ohttp += this.rows.get(`${d}|ohttp`) ?? 0;
      out["direct-fallback"] += this.rows.get(`${d}|direct-fallback`) ?? 0;
    }
    return out;
  }

  async recordProbe(p: RelayProbeRecord) {
    this.probe = { ...p, detail: p.detail.slice(0, 200) };
  }

  async lastProbe() {
    return this.probe;
  }
}
