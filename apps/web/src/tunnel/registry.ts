import type { Frame } from "@flagship/tunnel-protocol";
import {
  AppUserAllocator,
  type AppUserSetKey,
  type AppUserSetSnapshot,
} from "./allocator.js";

export interface StreamCallbacks {
  onData(data: Uint8Array): void;
  onRemoteClose(): void;
}

export interface RegisteredTunnel {
  /** Pod canonical FQDN (e.g. `kitchen.john.flagship.services`). Doubles as serverId. */
  readonly podCanonical: string;
  send(frame: Frame): void;
  attachStream(streamId: number, callbacks: StreamCallbacks): void;
  detachStream(streamId: number): void;
  nextStreamId(): number;
}

/**
 * `TunnelRegistry` v2 — an allocator-backed view over connected
 * tunnels. The hub provides per-pod canonicals validated by
 * IRK-signed entitlement certs (per N12a/b); the registry derives
 * shortened slot allocations via FCFS.
 *
 * Operations:
 *   - register(tunnel, canonicals): pod connects, joins (slug, author,
 *     user) sets, allocates free derivable shorteneds.
 *   - requestTransfer(tunnel, fqdn): explicit ownership move.
 *   - unregister(podCanonical): socket close → redistribute orphans.
 *   - findBySni(sni): SNI → tunnel.
 *
 * Snapshots emitted on every state change can be broadcast to
 * affected pods so each one keeps an up-to-date picture.
 */
export class TunnelRegistry {
  private readonly tunnels = new Map<string, RegisteredTunnel>();
  /**
   * #86 — custom-domain redirection table. `Map<customFqdn,
   * podCanonical>`, RAM-only (no DB on `.services`, by design). It is
   * an alias layer over the tunnel set, keyed on the pod canonical
   * (a string) — NOT the WS/tunnel object — so a pod reconnect
   * (which re-register()s under the same canonical) is transparent.
   * `.com` pushes ADD/DELETE here (#87); cold-start pulls the active
   * set. `findBySni` consults it only AFTER the native canonical/
   * wildcard lookups, so it can never shadow first-party routing.
   */
  private readonly redirections = new Map<string, string>();
  private readonly allocator: AppUserAllocator;

  constructor(opts: { allocator?: AppUserAllocator } = {}) {
    this.allocator = opts.allocator ?? new AppUserAllocator();
  }

  /**
   * Register a new tunnel + its entitled canonicals. Returns the
   * sets affected by the registration (caller broadcasts a fresh
   * snapshot to each).
   */
  register(args: {
    tunnel: RegisteredTunnel;
    canonicals: string[];
  }): { affectedSets: AppUserSetKey[]; shortenedsHeld: string[] } {
    const pc = args.tunnel.podCanonical.toLowerCase();
    // If this pod already had a tunnel registered (reconnect), drop it
    // first — the allocator preserves firstRegisteredAt internally so
    // re-registrations don't reset join-time.
    const prior = this.tunnels.get(pc);
    if (prior && prior !== args.tunnel) {
      this.tunnels.delete(pc);
    }
    this.tunnels.set(pc, args.tunnel);
    return this.allocator.addPod({
      podCanonical: pc,
      canonicals: args.canonicals,
    });
  }

  /**
   * Pod explicitly asks the hub to transfer ownership of `fqdn` to
   * itself. Caller has already validated the cert covers it.
   */
  requestTransfer(args: { podCanonical: string; fqdn: string }) {
    return this.allocator.requestTransfer(args);
  }

  unregister(podCanonical: string): { affectedSets: AppUserSetKey[]; redistributed: ReturnType<AppUserAllocator["removePod"]>["redistributed"] } {
    const pc = podCanonical.toLowerCase();
    this.tunnels.delete(pc);
    const r = this.allocator.removePod(pc);
    return { affectedSets: r.affectedSets, redistributed: r.redistributed };
  }

  /**
   * Resolve an inbound SNI to the tunnel that should serve it. Tries
   * exact match (canonical or held shortened); falls back to one-label
   * wildcard (`*.<host>.<user>.flagship.services`-style) lookups
   * against the per-tunnel canonical set so app-subdomain-of-canonical
   * traffic still routes.
   */
  findBySni(sni: string): RegisteredTunnel | undefined {
    const lower = sni.toLowerCase();
    const direct = this.allocator.findHolderByFqdn(lower);
    if (direct) return this.tunnels.get(direct);
    // Wildcard fallback: strip the leftmost label and try again.
    const dot = lower.indexOf(".");
    if (dot === -1) return undefined;
    const parent = lower.slice(dot + 1);
    const wildcardHolder = this.allocator.findHolderByFqdn(parent);
    if (wildcardHolder) return this.tunnels.get(wildcardHolder);
    // Exact-match against the pod's own canonical.
    const byParent = this.tunnels.get(parent);
    if (byParent) return byParent;
    // #86 — custom-domain redirection (consulted LAST so it can never
    // shadow first-party `*.flagship.services` routing). Resolve the
    // full SNI (custom domains are not flagship.services subdomains so
    // the parent-strip above won't have matched).
    const pod = this.redirections.get(lower);
    return pod ? this.tunnels.get(pod) : undefined;
  }

  /**
   * #86/#87 — install/replace a custom-domain redirection
   * (`customFqdn → podCanonical`). `.com` calls this via the authed
   * control channel on a confirmed CNAME; replace = delete(old) +
   * add(new) as two ops. Idempotent.
   */
  addRedirection(fqdn: string, podCanonical: string): void {
    this.redirections.set(fqdn.toLowerCase(), podCanonical.toLowerCase());
  }

  /** Remove a custom-domain redirection (invalidation / uninstall /
   *  the delete half of a replace). Idempotent. */
  removeRedirection(fqdn: string): void {
    this.redirections.delete(fqdn.toLowerCase());
  }

  /** Replace the entire redirection set in one shot — used by the
   *  `.services` cold-start pull from `.com`. */
  loadRedirections(entries: Iterable<readonly [string, string]>): void {
    this.redirections.clear();
    for (const [fqdn, pod] of entries) {
      this.redirections.set(fqdn.toLowerCase(), pod.toLowerCase());
    }
  }

  /** Metrics / health: how many custom-domain redirections are loaded. */
  redirectionCount(): number {
    return this.redirections.size;
  }

  /** Snapshot helper for the hub's broadcast logic. */
  snapshotsForPod(podCanonical: string): AppUserSetSnapshot[] {
    return this.allocator.snapshotForPod(podCanonical.toLowerCase());
  }

  snapshotByKey(key: AppUserSetKey): AppUserSetSnapshot | null {
    return this.allocator.snapshotByKey(key);
  }

  /** Members of a set, by pod canonical. Used by the hub broadcaster. */
  membersOf(key: AppUserSetKey): RegisteredTunnel[] {
    const out: RegisteredTunnel[] = [];
    for (const pc of this.allocator.membersOf(key)) {
      const t = this.tunnels.get(pc);
      if (t) out.push(t);
    }
    return out;
  }

  size(): number {
    return this.tunnels.size;
  }

  forEach(cb: (t: RegisteredTunnel) => void): void {
    for (const t of this.tunnels.values()) cb(t);
  }

  clear(): void {
    this.tunnels.clear();
    // No `clear` on allocator; relying on GC of the hub instance for now.
  }
}
