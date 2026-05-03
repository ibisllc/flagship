import type { FetchLike, TxtRecord, ZoneApi } from "./types.js";

export interface CloudflareZoneApiOptions {
  /** Cloudflare zone id (e.g. for flagship.services). */
  zoneId: string;
  /** API token with Zone.DNS:Edit on this zone. */
  apiToken: string;
  fetchImpl?: FetchLike;
  /** Override the API base for tests / private endpoints. */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface CfRecord {
  id: string;
  name: string;
  content: string;
  ttl?: number;
}

export class CloudflareZoneApi implements ZoneApi {
  private readonly opts: CloudflareZoneApiOptions;

  constructor(opts: CloudflareZoneApiOptions) {
    this.opts = opts;
  }

  async createTxt(record: { name: string; value: string; ttl?: number }): Promise<TxtRecord> {
    const r = await this.cf<CfRecord>("POST", "dns_records", {
      type: "TXT",
      name: record.name,
      content: record.value,
      ttl: record.ttl ?? 60,
    });
    return { id: r.id, name: r.name, value: r.content, ttl: r.ttl };
  }

  async deleteTxt(id: string): Promise<void> {
    await this.cf("DELETE", `dns_records/${encodeURIComponent(id)}`);
  }

  async listTxtByName(name: string): Promise<TxtRecord[]> {
    const r = await this.cf<CfRecord[]>(
      "GET",
      `dns_records?type=TXT&name=${encodeURIComponent(name)}`,
    );
    return r.map((x) => ({ id: x.id, name: x.name, value: x.content, ttl: x.ttl }));
  }

  private async cf<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = this.opts.baseUrl ?? DEFAULT_BASE;
    const url = `${base}/zones/${encodeURIComponent(this.opts.zoneId)}/${path}`;
    const res = await f(url, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = (await res.json()) as CfResponse<T>;
    if (!res.ok || !parsed.success) {
      const msg = parsed.errors?.map((e) => `${e.code}:${e.message}`).join(",") ?? "request failed";
      throw new Error(`cloudflare ${method} ${path} failed: ${msg}`);
    }
    return parsed.result;
  }
}
