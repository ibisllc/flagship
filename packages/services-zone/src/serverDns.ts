import type { ZoneApi } from "./types.js";

/**
 * The Fly app's `/api/services-zone/publish-server` backend.
 *
 * Under the ROOT-WILDCARD layout (docs/wildcard-dns.md) the zone holds one
 * `*.<apex>` A/AAAA pair and nothing per account or box, so a server needs no
 * DNS of its own:
 *
 *   mode = "tunnel": publishes nothing. `<server>.<user>.<apex>` and every
 *                    name below it resolve through the root wildcard to the
 *                    relay, whose SNI router forwards over the user's outbound
 *                    WebSocket. Any per-box record an older build wrote for
 *                    this box is removed, because a record at the box name
 *                    would stop the wildcard for every service name below it.
 *
 *   mode = "direct": UNSUPPORTED. A box on its own IP would need a record at
 *                    `<server>.<user>`, which blocks the wildcard for all of
 *                    its children, so it would need an explicit record for
 *                    every service name too, and `.com` would have to write
 *                    one on each app install. Nothing calls it (no client, no
 *                    box) and the relay is the only supported path, so the
 *                    publisher refuses it with {@link DirectModeUnsupportedError}.
 *
 * Each call is idempotent. The LIVE register-time cleanup is in control-plane
 * `accountDns.ts`; this publisher only backs the Fly app's route.
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
  /** Kept for the route's wiring; nothing is published at it any more. */
  tunnelIngressIp?: string;
  apex?: string;
}

/** Thrown for `mode = "direct"`, which the root-wildcard layout cannot serve. */
export class DirectModeUnsupportedError extends Error {
  readonly code = "direct-mode-unsupported";
  constructor() {
    super(
      "direct-IP servers are not supported: a record at the server's name would stop the zone wildcard for every service name below it. Use the relay (mode=tunnel).",
    );
  }
}

export class ServerDnsPublisher {
  constructor(private readonly opts: ServerDnsPublisherOptions) {}

  /**
   * Make the box's names resolvable: with the root wildcard that means
   * publishing nothing and clearing any per-box record an older build left.
   * Returns the names that now resolve through the wildcard.
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
    if (args.mode === "direct") throw new DirectModeUnsupportedError();
    const apexFqdn = `${args.serverName}.${args.username}.${apex}`;
    const wildcardFqdn = `*.${args.serverName}.${args.username}.${apex}`;

    await this.purge(apexFqdn);
    await this.purge(wildcardFqdn);
    this.opts.registry.put(apexFqdn, { apex: apexFqdn, wildcard: wildcardFqdn });
    return { apex: apexFqdn, wildcard: wildcardFqdn, mode: args.mode, target: this.opts.tunnelIngressIp ?? "" };
  }

  /** Remove a server's per-box records (e.g. after revocation). */
  async unpublish(args: { username: string; serverName: string }): Promise<void> {
    const apex = this.opts.apex ?? "flagship.services";
    const apexFqdn = `${args.serverName}.${args.username}.${apex}`;
    const wildcardFqdn = `*.${args.serverName}.${args.username}.${apex}`;
    await this.purge(apexFqdn);
    await this.purge(wildcardFqdn);
    this.opts.registry.delete(apexFqdn);
  }

  private async purge(name: string): Promise<void> {
    const existing = await this.opts.zone.listTxtByName(name).catch(() => []);
    for (const r of existing) {
      if (r.id) await this.opts.zone.deleteTxt(r.id).catch(() => {});
    }
    const z = this.opts.zone as ZoneApiWithA;
    const a = await (z.listAByName?.(name) ?? Promise.resolve([]));
    for (const r of a) {
      if (r.id) await (z.deleteA?.(r.id) ?? Promise.resolve());
    }
  }
}

interface ZoneApiWithA {
  deleteA?(id: string): Promise<void>;
  listAByName?(name: string): Promise<{ id?: string; value: string }[]>;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function isLabel(s: string): boolean {
  return LABEL_RE.test(s);
}
