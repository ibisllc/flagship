/**
 * Per-podCanonical eviction-chain cache for the .services tunnel hub
 * (graceful server replacement, docs/server-replacement-graceful-decommission.md §8).
 *
 * On every HELLO the hub asks: "has THIS box instance (its STK pubkey)
 * been evicted from this podCanonical?" Calling .com on every HELLO would
 * be a per-connect round trip; we cache the answer with a short TTL
 * (default 30s — shorter than the entitlement-revocation cache because an
 * eviction must take effect promptly, but long enough to amortise reconnect
 * storms).
 *
 * Returning `null` on a fetch failure means "couldn't get an answer" — the
 * hub treats that as FAIL-OPEN (a .com outage must not brick fleet-wide
 * registration; the durable decommission order / zombie-poll still closes
 * the fight, §8). Returning an (empty) Set is a definite answer.
 */

export interface EvictionCacheOptions {
  controlPlaneBaseUrl: string;
  /** Cache TTL in ms. Default 30s. */
  ttlMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Entry {
  retired: Set<string>;
  fetchedAt: number;
}

export class EvictionCache {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly base: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: EvictionCacheOptions) {
    this.base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Plugs into TunnelHubOptions.evictionLookup. Returns the lowercased-hex
   * STK pubkeys evicted for this podCanonical, or `null` on a fetch failure
   * (the hub's fail-open policy).
   */
  async lookup(podCanonical: string): Promise<Set<string> | null> {
    const key = podCanonical.toLowerCase();
    const cur = this.cache.get(key);
    if (cur && this.now() - cur.fetchedAt < this.ttlMs) return cur.retired;
    await this.refresh(key);
    return this.cache.get(key)?.retired ?? null;
  }

  private async refresh(key: string): Promise<void> {
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const r = await this.fetchImpl(
          `${this.base}/api/server/${encodeURIComponent(key)}/eviction-chain`,
        );
        if (!r.ok) return; // leave cache as-is → lookup() returns null ⇒ fail-open
        const body = (await r.json()) as { evictions?: Array<{ orderJson?: unknown }> };
        const evictions = Array.isArray(body?.evictions) ? body.evictions : [];
        const retired = new Set<string>();
        for (const e of evictions) {
          if (typeof e?.orderJson !== "string") continue;
          try {
            const order = JSON.parse(e.orderJson) as { retiredStkPubHex?: unknown };
            if (typeof order.retiredStkPubHex === "string") {
              retired.add(order.retiredStkPubHex.toLowerCase());
            }
          } catch {
            // a malformed order doesn't poison the whole chain
          }
        }
        this.cache.set(key, { retired, fetchedAt: this.now() });
      } catch {
        // network error → leave cache untouched ⇒ fail-open
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    await p;
  }
}
