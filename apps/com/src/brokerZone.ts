/**
 * The services zone through the DNS broker (`apps/dns-broker`, `POST /service`; 0.4 item F6). With `DNS_BROKER_URL`
 * and `DNS_BROKER_SECRET` set, `.com` holds no Cloudflare token for the zone: the issuance service's challenge records
 * and the reap tool's reads go through the broker, which writes nothing but `_acme-challenge` TXT records.
 */
import type { IssuanceDns } from "./certificateIssuance.js";
import type { ReapDnsClient, ReapDnsRecord } from "./prodReap.js";

export interface BrokerZoneEnv {
  DNS_BROKER_URL?: string;
  DNS_BROKER_SECRET?: string;
}

export class BrokerRefusal extends Error {
  constructor(readonly status: number, op: string) {
    super(`the DNS broker refused ${op} (HTTP ${status})`);
  }
}

export class BrokerZoneClient implements IssuanceDns, ReapDnsClient {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    const resp = await this.fetchImpl(`${this.url.replace(/\/+$/, "")}/service`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ op, ...body }),
    });
    const out = (await resp.json().catch(() => null)) as ({ ok?: boolean } & T) | null;
    if (!resp.ok || !out || out.ok !== true) throw new BrokerRefusal(resp.status, op);
    return out;
  }

  async createTxt(opts: { name: string; value: string; ttl?: number; token?: string }): Promise<{ id: string }> {
    const r = await this.call<{ recordId: string }>("challenge.create", { name: opts.name, value: opts.value, ...(opts.token ? { token: opts.token } : {}) });
    return { id: r.recordId };
  }

  /** Challenge records only: the broker refuses any other record (the reap tool reports that as a failed delete). */
  async deleteById(id: string): Promise<boolean> {
    const r = await this.call<{ deleted?: boolean }>("challenge.delete", { id });
    return r.deleted === true;
  }

  async listAll(): Promise<ReapDnsRecord[]> {
    return (await this.call<{ records: ReapDnsRecord[] }>("zone.list")).records;
  }

  async getById(id: string): Promise<ReapDnsRecord | null> {
    return (await this.call<{ record: ReapDnsRecord | null }>("zone.get", { id })).record;
  }
}

/** The broker client when `.com` is configured for it, else null (then the zone token, if any, is used directly). */
export function brokerZoneOf(env: BrokerZoneEnv, fetchImpl?: typeof fetch): BrokerZoneClient | null {
  if (!env.DNS_BROKER_URL || !env.DNS_BROKER_SECRET) return null;
  return new BrokerZoneClient(env.DNS_BROKER_URL, env.DNS_BROKER_SECRET, fetchImpl);
}
