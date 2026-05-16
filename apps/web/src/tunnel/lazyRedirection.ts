// Lazy SNI-miss → ask-`.com` resolver (#12, Phase 3 C3.3 lazy half).
//
// Push (#87) + cold-start (coldStartRedirections) are the CORRECTNESS
// core: a confirmed custom domain is normally already in the RAM
// redirection table. This is a pure latency/availability optimization
// for the narrow window where a confirmed fqdn is NOT in RAM (a missed
// push that also predates the last cold-start). On a TLS SNI that the
// synchronous TunnelRegistry.findBySni missed, do ONE authed point
// lookup against `.com`, install the redirection on a hit so every
// subsequent connection takes the fast path, and negative-cache the
// miss so an unknown/garbage SNI can't turn into a `.com` amplifier.
//
// Hardening (the plan's "Unknown-FQDN = DoS/amplification vector"):
//   - first-party `*.flagship.services` is never asked about (those
//     are allocator-routed; a miss there is a real no-tunnel).
//   - negative cache: a miss is remembered (default 60s) so a flood
//     of the same bad SNI is one `.com` call, not thousands.
//   - in-flight dedupe: concurrent connections for the same new fqdn
//     share a single `.com` round-trip.
//   - rolling rate limit: a hard ceiling of lookups per window.
//   - bounded: AbortSignal.timeout so a slow `.com` can't pin sockets.
//   - fail-closed: no secret ⇒ disabled (returns null), like
//     coldStartRedirections.
//
// The point lookup is keyed on the EXACT fqdn (it arrived as the wire
// SNI), so it leaks nothing a `dig`/connection didn't already reveal —
// `.com` has no list/enumeration endpoint by design.

import type { TunnelRegistry } from "./registry.js";

export interface LazyRedirectionResolverOptions {
  registry: TunnelRegistry;
  comBaseUrl: string;
  /** Shared bearer secret. Absent ⇒ the resolver is disabled. */
  secret?: string;
  fetchImpl?: typeof fetch;
  /** How long a miss is negative-cached. Default 60s. */
  negativeTtlMs?: number;
  /** Max `.com` lookups per {@link windowMs}. Default 30. */
  maxPerWindow?: number;
  /** Rolling rate-limit window. Default 60s. */
  windowMs?: number;
  /** Per-lookup timeout. Default 2s. */
  timeoutMs?: number;
  now?: () => number;
}

export class LazyRedirectionResolver {
  private readonly o: Required<Omit<LazyRedirectionResolverOptions, "secret">> & {
    secret?: string;
  };
  private readonly negative = new Map<string, number>(); // fqdn → expiry ms
  private readonly inflight = new Map<string, Promise<string | null>>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(opts: LazyRedirectionResolverOptions) {
    this.o = {
      registry: opts.registry,
      comBaseUrl: opts.comBaseUrl,
      secret: opts.secret,
      fetchImpl: opts.fetchImpl ?? fetch,
      negativeTtlMs: opts.negativeTtlMs ?? 60_000,
      maxPerWindow: opts.maxPerWindow ?? 30,
      windowMs: opts.windowMs ?? 60_000,
      timeoutMs: opts.timeoutMs ?? 2_000,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /**
   * Resolve a missed SNI to its serving podCanonical via `.com`,
   * installing the redirection on a hit. Returns the pod, or null if
   * it can't/shouldn't be resolved (disabled, first-party, negative-
   * cached, rate-limited, unknown, or error). Never throws.
   */
  async resolve(sni: string): Promise<string | null> {
    if (!this.o.secret) return null;
    const fqdn = sni.trim().toLowerCase();
    if (fqdn.length === 0 || fqdn.length > 253) return null;
    // First-party names are allocator-routed; a miss there is a real
    // no-tunnel, never a custom-domain redirection.
    if (fqdn === "flagship.services" || fqdn.endsWith(".flagship.services")) {
      return null;
    }
    const now = this.o.now();
    const negExpiry = this.negative.get(fqdn);
    if (negExpiry !== undefined) {
      if (negExpiry > now) return null;
      this.negative.delete(fqdn);
    }
    const existing = this.inflight.get(fqdn);
    if (existing) return existing;

    // Rolling-window rate limit (the DoS/amplification guard).
    if (now - this.windowStart >= this.o.windowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.o.maxPerWindow) return null;
    this.windowCount++;

    const p = this.lookup(fqdn).finally(() => this.inflight.delete(fqdn));
    this.inflight.set(fqdn, p);
    return p;
  }

  private async lookup(fqdn: string): Promise<string | null> {
    try {
      const url =
        `${this.o.comBaseUrl.replace(/\/+$/, "")}` +
        `/api/internal/redirection-lookup?fqdn=${encodeURIComponent(fqdn)}`;
      const res = await this.o.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.o.secret}` },
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      if (!res.ok) {
        this.negativeCache(fqdn);
        return null;
      }
      const j = (await res.json()) as {
        found?: unknown;
        fqdn?: unknown;
        podCanonical?: unknown;
      };
      if (j.found === true && typeof j.podCanonical === "string" && j.podCanonical.length > 0) {
        this.o.registry.addRedirection(fqdn, j.podCanonical);
        return j.podCanonical.toLowerCase();
      }
      this.negativeCache(fqdn);
      return null;
    } catch {
      this.negativeCache(fqdn);
      return null;
    }
  }

  private negativeCache(fqdn: string): void {
    this.negative.set(fqdn, this.o.now() + this.o.negativeTtlMs);
  }
}
