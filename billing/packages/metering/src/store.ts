/** A cumulative usage counter: an account id and a number, nothing else. */
export interface MeterCounter {
  account: string;
  resource: string;
  period: string;
  amount: number;
  updatedAt: number;
}

/** One counter delta inside an idempotent batch. */
export interface MeterBatchEntry {
  account: string;
  resource: string;
  period: string;
  amount: number;
}

/** What `addBatch` did: added every entry (new totals, in entry order), or
 *  nothing because the batch id was already recorded. */
export type MeterBatchResult = { duplicate: false; totals: number[] } | { duplicate: true };

/**
 * Where counters live. Resource-agnostic: it never interprets `resource` or
 * `period`, so a new metered resource needs no schema change. A SQL store
 * implements it over `schema/meter_counters.sql`.
 */
export interface MeterStore {
  /** Atomically add `amount` (negatives and fractions floor to a whole
   *  non-negative number) to the counter, creating it at 0. Returns the new
   *  cumulative total. */
  add(account: string, resource: string, period: string, amount: number, now: number): Promise<number>;
  /** Read one counter. undefined → nothing recorded yet. */
  get(account: string, resource: string, period: string): Promise<MeterCounter | undefined>;
  /** Optional: idempotent batches (spec/report-and-lease-v1.md). In ONE
   *  atomic step: if `batchId` is not on record, record it until `keepUntil`
   *  (ms) and add every entry as `add` would; if it is, change nothing. A
   *  record past its `keepUntil` may be forgotten, after which the same id
   *  counts again, so callers stop retrying well before then. The record is
   *  the id and an expiry only, never an account or an amount. SQL stores
   *  implement it over `schema/meter_batches.sql`. */
  addBatch?(batchId: string, entries: MeterBatchEntry[], now: number, keepUntil: number): Promise<MeterBatchResult>;
}

/** Process-local store, for tests and single-process hosts. */
export class InMemoryMeterStore implements MeterStore {
  private rows = new Map<string, MeterCounter>();
  /** batch id → keepUntil, in insertion order. */
  private batches = new Map<string, number>();

  private key(account: string, resource: string, period: string): string {
    return JSON.stringify([account, resource, period]);
  }

  async add(account: string, resource: string, period: string, amount: number, now: number): Promise<number> {
    const k = this.key(account, resource, period);
    const next = (this.rows.get(k)?.amount ?? 0) + Math.max(0, Math.floor(amount));
    this.rows.set(k, { account, resource, period, amount: next, updatedAt: now });
    return next;
  }

  async get(account: string, resource: string, period: string): Promise<MeterCounter | undefined> {
    const r = this.rows.get(this.key(account, resource, period));
    return r ? { ...r } : undefined;
  }

  async addBatch(batchId: string, entries: MeterBatchEntry[], now: number, keepUntil: number): Promise<MeterBatchResult> {
    for (const [id, until] of this.batches) {
      if (until >= now) break;
      this.batches.delete(id);
    }
    const seen = this.batches.get(batchId);
    if (seen !== undefined && seen >= now) return { duplicate: true };
    this.batches.delete(batchId);
    this.batches.set(batchId, keepUntil);
    const totals: number[] = [];
    for (const e of entries) totals.push(await this.add(e.account, e.resource, e.period, e.amount, now));
    return { duplicate: false, totals };
  }

  /** Batch ids currently on record (tests, diagnostics). */
  batchCount(): number {
    return this.batches.size;
  }
}
