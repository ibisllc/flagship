/**
 * DNS for the relay mesh's names (docs/architecture-v2/relay-mesh.md §2, docs/runbooks/relay-mesh.md): every relay's
 * direct name `<relayId>.tunnel.<apex>` (A/AAAA at exactly its addresses, DNS only), the balanced name
 * `tunnel.<apex>` (every relay's addresses, when no Cloudflare load balancer owns it: the gym), and the
 * `_acme-challenge.<name>` CNAMEs Fly's DNS-01 validation asks for. A pure plan over the zone's records, then the
 * Cloudflare calls; only the names it manages are ever touched.
 */

export interface MeshDnsRelay {
  relayId: string;
  ipv4: string[];
  ipv6: string[];
}

export interface ZoneRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export interface WantedRecord {
  type: "A" | "AAAA" | "CNAME";
  name: string;
  content: string;
}

export interface MeshDnsPlan {
  create: WantedRecord[];
  delete: ZoneRecord[];
  keep: ZoneRecord[];
}

export interface MeshDnsOptions {
  apex: string;
  /** The relays whose names this run manages (their addresses as they are now). */
  relays: MeshDnsRelay[];
  /** Relays leaving: every record at their direct name and its challenge name goes. */
  remove?: string[];
  /**
   * Write `tunnel.<apex>` as every managed relay's addresses (the gym, no load balancer). Off when a load balancer
   * owns the name: then this plan never touches it.
   */
  balanced?: boolean;
  /** `_acme-challenge.<host>` → CNAME target, as Fly's `certs show` gives it. */
  acme?: Record<string, string>;
}

const norm = (s: string): string => s.toLowerCase().replace(/\.$/, "");

export const tunnelName = (apex: string): string => `tunnel.${norm(apex)}`;
export const relayName = (relayId: string, apex: string): string => `${relayId}.${tunnelName(apex)}`;

/** What to create and delete so the managed names hold exactly what they should. */
export function planMeshDns(existing: readonly ZoneRecord[], o: MeshDnsOptions): MeshDnsPlan {
  const apex = norm(o.apex);
  const want: WantedRecord[] = [];
  const managed = new Set<string>();
  const removing = new Set(o.remove ?? []);
  for (const id of removing) {
    managed.add(relayName(id, apex));
    managed.add(`_acme-challenge.${relayName(id, apex)}`);
  }
  for (const r of o.relays) {
    if (removing.has(r.relayId)) continue;
    const n = relayName(r.relayId, apex);
    managed.add(n);
    for (const a of r.ipv4) want.push({ type: "A", name: n, content: a });
    for (const a of r.ipv6) want.push({ type: "AAAA", name: n, content: a.toLowerCase() });
  }
  if (o.balanced) {
    const n = tunnelName(apex);
    managed.add(n);
    const kept = existing.filter((x) => norm(x.name) === n && (x.type === "A" || x.type === "AAAA"));
    // The balanced name keeps the addresses of relays this run does not manage, minus those leaving.
    const leaving = new Set(existing.filter((x) => [...removing].some((id) => norm(x.name) === relayName(id, apex))).map((x) => x.content.toLowerCase()));
    const ours = new Set(o.relays.flatMap((r) => [...r.ipv4, ...r.ipv6].map((a) => a.toLowerCase())));
    for (const x of kept) if (!leaving.has(x.content.toLowerCase()) && !ours.has(x.content.toLowerCase())) want.push({ type: x.type as "A" | "AAAA", name: n, content: x.content.toLowerCase() });
    for (const r of o.relays) {
      if (removing.has(r.relayId)) continue;
      for (const a of r.ipv4) want.push({ type: "A", name: n, content: a });
      for (const a of r.ipv6) want.push({ type: "AAAA", name: n, content: a.toLowerCase() });
    }
  }
  for (const [host, target] of Object.entries(o.acme ?? {})) {
    const n = `_acme-challenge.${norm(host)}`;
    managed.add(n);
    want.push({ type: "CNAME", name: n, content: norm(target) });
  }
  for (const n of managed) {
    if (n !== tunnelName(apex) && !n.endsWith(`.${tunnelName(apex)}`)) throw new Error(`${n} is not under ${tunnelName(apex)}`);
  }
  const key = (t: string, n: string, c: string) => `${t.toUpperCase()} ${norm(n)} ${norm(c)}`;
  const wanted = new Map(want.map((w) => [key(w.type, w.name, w.content), w]));
  const plan: MeshDnsPlan = { create: [], delete: [], keep: [] };
  const have = new Set<string>();
  for (const x of existing) {
    if (!managed.has(norm(x.name))) continue;
    // A challenge name holds only the CNAME this plan wants (Caddy's own TXT on a non-Fly relay is left alone).
    if (norm(x.name).startsWith("_acme-challenge.") && x.type.toUpperCase() === "TXT") continue;
    const k = key(x.type, x.name, x.content);
    if (wanted.has(k) && x.proxied !== true && !have.has(k)) {
      plan.keep.push(x);
      have.add(k);
    } else plan.delete.push(x);
  }
  for (const [k, w] of wanted) if (!have.has(k)) plan.create.push(w);
  return plan;
}

export function formatPlan(p: MeshDnsPlan): string[] {
  return [
    ...p.create.map((r) => `  create ${r.type.padEnd(5)} ${r.name} ${r.content}`),
    ...p.delete.map((r) => `  delete ${r.type.padEnd(5)} ${r.name} ${r.content}`),
    ...p.keep.map((r) => `  keep   ${r.type.padEnd(5)} ${r.name} ${r.content}`),
  ];
}

/** The Cloudflare calls (Zone.DNS:Edit on the services zone). Never proxied: TLS ends on the relay or the box. */
export class CloudflareZone {
  constructor(
    private readonly token: string,
    private zoneId = "",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async cf<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: unknown; result_info?: { total_pages?: number } };
    if (!r.ok || !j.success) throw new Error(`Cloudflare ${method} ${path.split("?")[0]}: ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 200)}`);
    return j.result as T;
  }

  async zone(zoneName: string): Promise<string> {
    if (!this.zoneId) {
      const z = await this.cf<Array<{ id: string }>>("GET", `/zones?name=${encodeURIComponent(zoneName)}`);
      if (!z[0]?.id) throw new Error(`no Cloudflare zone ${zoneName} for this token`);
      this.zoneId = z[0].id;
    }
    return this.zoneId;
  }

  /** Every record at or below `suffix` (one name filter per page of 1,000; the zone holds a few hundred at most). */
  async under(zoneName: string, suffix: string): Promise<ZoneRecord[]> {
    const z = await this.zone(zoneName);
    const out: ZoneRecord[] = [];
    for (let page = 1; page < 20; page++) {
      const rs = await this.cf<ZoneRecord[]>("GET", `/zones/${z}/dns_records?per_page=1000&page=${page}`);
      out.push(...rs.filter((r) => norm(r.name) === norm(suffix) || norm(r.name).endsWith(`.${norm(suffix)}`)));
      if (rs.length < 1000) break;
    }
    return out;
  }

  async apply(zoneName: string, p: MeshDnsPlan, log: (s: string) => void): Promise<void> {
    const z = await this.zone(zoneName);
    for (const r of p.delete) {
      await this.cf("DELETE", `/zones/${z}/dns_records/${encodeURIComponent(r.id)}`);
      log(`deleted ${r.type} ${r.name} ${r.content}`);
    }
    for (const r of p.create) {
      await this.cf("POST", `/zones/${z}/dns_records`, { type: r.type, name: r.name, content: r.content, ttl: 60, proxied: false });
      log(`created ${r.type} ${r.name} ${r.content}`);
    }
  }
}

/** A Fly app's public addresses from `flyctl ips list --json` (dedicated v4 and v6; never shared or private). */
export function flyAddresses(json: unknown): { ipv4: string[]; ipv6: string[] } {
  const list = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
  const typ = (x: Record<string, unknown>) => String(x.Type ?? x.type ?? "").toLowerCase();
  const addr = (x: Record<string, unknown>) => String(x.Address ?? x.address ?? "");
  return {
    ipv4: list.filter((x) => typ(x) === "v4").map(addr).filter(Boolean),
    ipv6: list.filter((x) => typ(x) === "v6").map(addr).filter(Boolean).map((a) => a.toLowerCase()),
  };
}

/** The DNS-01 CNAME target Fly asks for, from `flyctl certs show <host> --json` (null when it names none). */
export function flyAcmeTarget(json: unknown): string | null {
  const j = (json ?? {}) as Record<string, unknown>;
  const t = j.DNSValidationTarget ?? j.dnsValidationTarget ?? (j.Certificate as Record<string, unknown> | undefined)?.DNSValidationTarget;
  return typeof t === "string" && t.includes(".") ? norm(t) : null;
}
