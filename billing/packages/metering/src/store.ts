/** A cumulative usage counter: an account id and a number, nothing else. */
export interface MeterCounter {
  account: string;
  resource: string;
  period: string;
  amount: number;
  updatedAt: number;
}

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
}

/** Process-local store, for tests and single-process hosts. */
export class InMemoryMeterStore implements MeterStore {
  private rows = new Map<string, MeterCounter>();

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
}
