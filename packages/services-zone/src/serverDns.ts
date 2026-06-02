import type { ZoneApi } from "./types.js";

/**
 * Publishes the DNS record set that makes `<server>.<user>.flagship.services`
 * resolvable.
 *
 *   mode = "tunnel": the apex of `<server>.<user>` resolves to the tunnel
 *                    ingress anycast IP. Wildcard `*.<server>.<user>` resolves
 *                    to the same. The SNI router peeks the ClientHello and
 *                    forwards over the user's outbound WebSocket.
 *
 *   mode = "direct": the apex points at the user-supplied A record (their
 *                    VPS / port-forwarded home box). Wildcard CNAMEs the same.
 *                    `.services` is not in the traffic path.
 *
 * Each call is idempotent — existing records for the same name are removed
 * before the new set is written, so a tunnel→direct flip leaves a clean zone.
 */

export type ServerDnsMode = "tunnel" | "direct";

export interface ServerDnsTarget {
  /** A record for the apex `<server>.<user>.<apex>`. */
  apexA: string;
  /** A record for the wildcard `*.<server>.<user>.<apex>`. */
  wildcardA: string;
}

export interface ServerDnsRecord {
  apex: string;
  wildcard: string;
  apexId?: string;
  wildcardId?: string;
}

export interface ServerDnsRegistry {
  put(serverFqdn: string, record: ServerDnsRecord): void;
  get(serverFqdn: string): ServerDnsRecord | undefined;
  delete(serverFqdn: string): boolean;
  list(): { serverFqdn: string; record: ServerDnsRecord }[];
}

export class InMemoryServerDnsRegistry implements ServerDnsRegistry {
  private byFqdn = new Map<string, ServerDnsRecord>();

  put(fqdn: string, record: ServerDnsRecord): void {
    this.byFqdn.set(fqdn, { ...record });
  }
  get(fqdn: string): ServerDnsRecord | undefined {
    return this.byFqdn.get(fqdn);
  }
  delete(fqdn: string): boolean {
    return this.byFqdn.delete(fqdn);
  }
  list(): { serverFqdn: string; record: ServerDnsRecord }[] {
    return [...this.byFqdn.entries()].map(([serverFqdn, record]) => ({ serverFqdn, record }));
  }
}

export interface ServerDnsPublisherOptions {
  zone: ZoneApi;
  registry: ServerDnsRegistry;
  /** A record of the tunnel ingress anycast IP for `mode = tunnel`. */
  tunnelIngressIp: string;
  apex?: string;
}

export class ServerDnsPublisher {
  constructor(private readonly opts: ServerDnsPublisherOptions) {}

  /**
   * Publish (or re-publish) the DNS record set for one server. Returns the
   * record set that's now active.
   */
  async publish(args: {
    username: string;
    serverName: string;
    mode: ServerDnsMode;
    directIp?: string;
  }): Promise<{ apex: string; wildcard: string; mode: ServerDnsMode; target: string }> {
    const apex = this.opts.apex ?? "flagship.services";
    if (!isLabel(args.username) || !isLabel(args.serverName)) {
      throw new Error("username and serverName must be RFC 1035 labels");
    }
    // PER-USER DNS (task #23): publish the TWO user-zone records — the apex
    // `<user>.<apex>` and the wildcard `*.<user>.<apex>` — instead of the old
    // per-server pair. The box apex `<server>.<user>` and every app label
    // `<label>.<user>` both resolve via the single `*.<user>` wildcard. Records
    // are per-USER, so multiple boxes share them (published idempotently); the
    // tunnel hub routes each SNI to the right box.
    const apexFqdn = `${args.username}.${apex}`;
    const wildcardFqdn = `*.${args.username}.${apex}`;
    const target = args.mode === "direct" ? requireIp(args.directIp) : this.opts.tunnelIngressIp;

    // Delete any prior records for this exact name so a flip leaves a clean zone.
    await this.purge(apexFqdn);
    await this.purge(wildcardFqdn);

    const apexRec = await this.writeA(apexFqdn, target);
    const wildRec = await this.writeA(wildcardFqdn, target);

    this.opts.registry.put(apexFqdn, {
      apex: apexFqdn,
      wildcard: wildcardFqdn,
      apexId: apexRec.id,
      wildcardId: wildRec.id,
    });

    return { apex: apexFqdn, wildcard: wildcardFqdn, mode: args.mode, target };
  }

  /**
   * Write an A record. The ZoneApi contract was originally TXT-only (for
   * ACME DNS-01); A-record providers slot in via the optional createA hook.
   * If none is configured, fall back to a TXT marker — useful for tests
   * and for offline / dry-run zone provisioning.
   */
  private async writeA(name: string, value: string): Promise<{ id?: string }> {
    const z = this.opts.zone as ZoneApiWithA;
    if (z.createA) return z.createA({ name, value, ttl: 60 });
    return this.opts.zone.createTxt({ name, value: `flagship-server-a:${value}`, ttl: 60 });
  }

  /**
   * Remove a server's DNS record set entirely (e.g. after revocation).
   */
  async unpublish(args: { username: string; serverName: string }): Promise<void> {
    const apex = this.opts.apex ?? "flagship.services";
    // PER-USER DNS (task #23): records are per-user, shared by every box under
    // `<user>`. Only call this when the LAST server under the user is torn
    // down — per-box routing revocation (#27) lives at the tunnel hub, not here.
    const apexFqdn = `${args.username}.${apex}`;
    const wildcardFqdn = `*.${args.username}.${apex}`;
    await this.purge(apexFqdn);
    await this.purge(wildcardFqdn);
    this.opts.registry.delete(apexFqdn);
  }

  private async purge(name: string): Promise<void> {
    const existing = await this.opts.zone.listTxtByName(name).catch(() => []);
    for (const r of existing) {
      if (r.id) await this.opts.zone.deleteTxt(r.id).catch(() => {});
    }
    const a = await ((this.opts.zone as ZoneApiWithA).listAByName?.(name) ?? Promise.resolve([]));
    for (const r of a) {
      if (r.id) await ((this.opts.zone as ZoneApiWithA).deleteA?.(r.id) ?? Promise.resolve());
    }
  }
}

interface ZoneApiWithA {
  createA?(record: { name: string; value: string; ttl?: number }): Promise<{ id?: string }>;
  deleteA?(id: string): Promise<void>;
  listAByName?(name: string): Promise<{ id?: string; value: string }[]>;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function isLabel(s: string): boolean {
  return LABEL_RE.test(s);
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/; // permissive; full validation isn't worth the bytes
function requireIp(ip: string | undefined): string {
  if (!ip) throw new Error("directIp required for mode=direct");
  if (!IPV4_RE.test(ip) && !IPV6_RE.test(ip)) {
    throw new Error(`directIp ${JSON.stringify(ip)} is not IPv4 or IPv6`);
  }
  return ip;
}
