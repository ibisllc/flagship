/**
 * Which hosts a box's AI calls may leave through the hub (docs/outbound-hosts.md).
 *
 * The list lives in `.com`'s database. A host not seen before is allowed and recorded; the
 * owner blocks one by flipping a flag. The hub asks `.com` with its own secret and sends only
 * the host, never a box, an account or an address, so what `.com` keeps cannot name a user.
 * When `.com` cannot be reached the last answer stands, and a host never seen is allowed only
 * if it is one of the known AI providers below.
 */

/** Provider API hosts that are allowed even when `.com` cannot be asked. */
export const KNOWN_AI_HOSTS: ReadonlySet<string> = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.deepseek.com",
  "api.x.ai",
  "api.fireworks.ai",
  "api.perplexity.ai",
  "api.cohere.com",
  "api.cerebras.ai",
  "router.huggingface.co",
]);

export interface HostReportRow {
  host: string;
  streams: number;
  up: number;
  down: number;
  refused: number;
}

export interface HostPolicy {
  allowed(host: string): Promise<boolean>;
  report(rows: HostReportRow[]): Promise<void>;
}

/** No `.com` to ask: the known AI providers and nothing else. */
export class KnownHostsPolicy implements HostPolicy {
  async allowed(host: string): Promise<boolean> {
    return KNOWN_AI_HOSTS.has(host.toLowerCase());
  }
  async report(): Promise<void> {}
}

export interface ComHostPolicyOptions {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long an "allowed" answer is kept; a block is noticed within this long. Default 2 min. */
  allowedTtlMs?: number;
  /** How long a "blocked" answer is kept. Default 1 min. */
  blockedTtlMs?: number;
  timeoutMs?: number;
  /** Most hosts remembered at once. Default 2000. */
  maxCached?: number;
}

export class ComHostPolicy implements HostPolicy {
  private readonly cache = new Map<string, { ok: boolean; until: number }>();
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: ComHostPolicyOptions) {
    this.f = o.fetch ?? globalThis.fetch;
    this.now = o.now ?? (() => Date.now());
  }

  async allowed(rawHost: string): Promise<boolean> {
    const host = rawHost.toLowerCase();
    const hit = this.cache.get(host);
    if (hit && hit.until > this.now()) return hit.ok;
    try {
      const res = await this.f(`${this.o.baseUrl}/api/outbound/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-usage-secret": this.o.secret },
        body: JSON.stringify({ host }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 3_000),
      });
      if (!res.ok) throw new Error(`check ${res.status}`);
      const ok = ((await res.json()) as { allowed?: unknown }).allowed === true;
      this.remember(host, ok);
      return ok;
    } catch {
      // `.com` unreachable: what we last knew, else only the known providers.
      return hit ? hit.ok : KNOWN_AI_HOSTS.has(host);
    }
  }

  private remember(host: string, ok: boolean): void {
    const max = this.o.maxCached ?? 2_000;
    if (!this.cache.has(host) && this.cache.size >= max) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(host, { ok, until: this.now() + (ok ? this.o.allowedTtlMs ?? 120_000 : this.o.blockedTtlMs ?? 60_000) });
  }

  async report(rows: HostReportRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.f(`${this.o.baseUrl}/api/outbound/report`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-usage-secret": this.o.secret },
        body: JSON.stringify({ rows: rows.slice(0, 500) }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 3_000),
      });
    } catch {
      // Totals are best-effort: a lost report is a lost count, never a failed call.
    }
  }
}
