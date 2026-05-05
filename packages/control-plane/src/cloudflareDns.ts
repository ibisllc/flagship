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
    type: "A" | "AAAA" | "TXT" | "CNAME";
    content: string;
    ttl?: number;
    proxied?: boolean;
  }): Promise<CloudflareDnsRecord> {
    const proxied = opts.proxied ?? false;
    const ttl = opts.ttl ?? 60;

    const existing = await this.list(opts.name, opts.type);
    if (existing.length > 0) {
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

    const resp = await fetch(`${CF_API}/zones/${this.cfg.zoneId}/dns_records`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: opts.type,
        name: opts.name,
        content: opts.content,
        ttl,
        proxied,
      }),
    });
    const body = (await resp.json()) as { success: boolean; result?: CloudflareDnsRecord; errors?: unknown };
    if (!body.success || !body.result) {
      throw new Error(`Cloudflare DNS POST failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    return body.result;
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
