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
    // Final fallback: the exact-match against the pod's own canonical.
    return this.tunnels.get(parent) ?? undefined;
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
