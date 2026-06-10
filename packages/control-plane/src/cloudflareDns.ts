/**
 * Cloudflare DNS API client for `.com` (Worker-resident).
 *
 * Two responsibilities, both Cloudflare-internal HTTP calls:
 *
 *   1. Publish A/AAAA records for `<server>.<user>.flagship.services`
 *      → Fly anycast IP, gray-cloud (DNS only — TLS terminates on the
 *      user's daemon, not at Cloudflare's edge).
 *   2. Publish/delete TXT records for ACME DNS-01 challenges (used for
 *      wildcards; non-wildcards use TLS-ALPN-01 which doesn't need DNS
 *      publishing).
 *
 * Auth: an API Token with Zone:DNS:Edit scope on the flagship.services
 * zone. Set as a Worker secret via `wrangler secret put
 * CLOUDFLARE_DNS_API_TOKEN`.
 */

export interface CloudflareDnsConfig {
  apiToken: string;
  zoneId: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

const CF_API = "https://api.cloudflare.com/client/v4";

export class CloudflareDnsClient {
  constructor(private cfg: CloudflareDnsConfig) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.apiToken}`,
      "content-type": "application/json",
    };
  }

  /**
   * Idempotent upsert: if a record with this (name, type) already exists,
   * patch its content; otherwise create it. Always gray-cloud
   * (proxied=false) for `flagship.services` user content because TLS
   * terminates on the user's daemon, not Cloudflare's edge.
   */
  async upsert(opts: {
    name: string;
    type: "A" | "AAAA" | "TXT" | "CNAME" | "CAA";
    content: string;
    /**
     * CAA only: Cloudflare's API rejects a free-form `content` for CAA and
     * requires the structured `{ flags, tag, value }` form. When `type` is
     * `"CAA"` this MUST be supplied; `content` is still used as the
     * idempotency key (the zone-file presentation rdata, e.g.
     * `0 issue "letsencrypt.org"`).
     */
    data?: { flags: number; tag: string; value: string };
    ttl?: number;
    proxied?: boolean;
  }): Promise<CloudflareDnsRecord> {
    const proxied = opts.proxied ?? false;
    const ttl = opts.ttl ?? 60;
    const isCaa = opts.type === "CAA";

    const existing = await this.list(opts.name, opts.type);
    // CAA can legitimately have multiple records at one name (issue + issuewild
    // + iodef), so dedupe by exact rdata rather than just (name,type): a record
    // whose presentation form already matches is a no-op.
    if (isCaa) {
      const match = existing.find((r) => r.content === opts.content && r.ttl === ttl);
      if (match) return match;
    } else if (existing.length > 0) {
      const r = existing[0]!;
      if (r.content === opts.content && r.proxied === proxied && r.ttl === ttl) {
        return r;
      }
      const resp = await fetch(`${CF_API}/zones/${this.cfg.zoneId}/dns_records/${r.id}`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ content: opts.content, ttl, proxied }),
      });
      const body = (await resp.json()) as { success: boolean; result?: CloudflareDnsRecord; errors?: unknown };
      if (!body.success || !body.result) {
        throw new Error(`Cloudflare DNS PATCH failed: ${JSON.stringify(body.errors ?? body)}`);
      }
      return body.result;
    }

    const createBody: Record<string, unknown> = isCaa
      ? { type: "CAA", name: opts.name, data: opts.data, ttl }
      : { type: opts.type, name: opts.name, content: opts.content, ttl, proxied };
    const resp = await fetch(`${CF_API}/zones/${this.cfg.zoneId}/dns_records`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(createBody),
    });
    const body = (await resp.json()) as { success: boolean; result?: CloudflareDnsRecord; errors?: unknown };
    if (!body.success || !body.result) {
      throw new Error(`Cloudflare DNS POST failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.result;
  }

  /**
   * Plain create — does not dedupe by (name,type). Use this for ACME DNS-01
   * challenges where two authorizations of the same cert can produce two
   * TXT records at `_acme-challenge.<host>` that must both be present at
   * the same time. Each call returns a fresh record id which the caller
   * must keep to delete later.
   */
  async createTxt(opts: {
    name: string;
    value: string;
    ttl?: number;
  }): Promise<CloudflareDnsRecord> {
    const ttl = opts.ttl ?? 60;
    const resp = await fetch(`${CF_API}/zones/${this.cfg.zoneId}/dns_records`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: "TXT",
        name: opts.name,
        content: opts.value,
        ttl,
        proxied: false,
      }),
    });
    const body = (await resp.json()) as { success: boolean; result?: CloudflareDnsRecord; errors?: unknown };
    if (!body.success || !body.result) {
      throw new Error(`Cloudflare DNS createTxt failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.result;
  }

  /** Look up a single record by its CF record id. Returns null on 404. */
  async getById(id: string): Promise<CloudflareDnsRecord | null> {
    const resp = await fetch(
      `${CF_API}/zones/${this.cfg.zoneId}/dns_records/${encodeURIComponent(id)}`,
      { headers: this.headers() },
    );
    if (resp.status === 404) return null;
    const body = (await resp.json()) as { success: boolean; result?: CloudflareDnsRecord; errors?: unknown };
    if (!body.success || !body.result) {
      throw new Error(`Cloudflare DNS getById failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.result;
  }

  /** Delete a single record by id. Resolves true on success, false if absent. */
  async deleteById(id: string): Promise<boolean> {
    const resp = await fetch(
      `${CF_API}/zones/${this.cfg.zoneId}/dns_records/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (resp.status === 404) return false;
    const body = (await resp.json()) as { success: boolean; errors?: unknown };
    if (!body.success) {
      throw new Error(`Cloudflare DNS deleteById failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return true;
  }

  async list(name: string, type?: string): Promise<CloudflareDnsRecord[]> {
    const params = new URLSearchParams({ name });
    if (type) params.set("type", type);
    const resp = await fetch(
      `${CF_API}/zones/${this.cfg.zoneId}/dns_records?${params.toString()}`,
      { headers: this.headers() },
    );
    const body = (await resp.json()) as {
      success: boolean;
      result?: CloudflareDnsRecord[];
      errors?: unknown;
    };
    if (!body.success) {
      throw new Error(`Cloudflare DNS list failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.result ?? [];
  }

  async deleteByName(name: string, type: string): Promise<number> {
    const records = await this.list(name, type);
    let deleted = 0;
    for (const r of records) {
      const resp = await fetch(`${CF_API}/zones/${this.cfg.zoneId}/dns_records/${r.id}`, {
        method: "DELETE",
        headers: this.headers(),
      });
      const body = (await resp.json()) as { success: boolean };
      if (body.success) deleted += 1;
    }
    return deleted;
  }
}
