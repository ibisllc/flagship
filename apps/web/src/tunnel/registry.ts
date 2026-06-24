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
  /**
   * Box-canonical roster, RAM-only. A pod canonical (`<server>.<user>.<apex>`)
   * is recorded on every `register` and never deleted on `unregister` — so it
   * remembers boxes that are CURRENTLY OR RECENTLY connected. The nudge logic
   * (`isNudgeableSni`) uses it to NOT nudge for a box's own apex/canonical that
   * is simply offline: a `<server>.<user>` that the user once ran is a box
   * canonical, not a leader-routed `<service>.<user>` meta-URL, so re-electing a
   * leader for it is meaningless. Tier-2 service names never enter this roster
   * (they are slot allocations, not pod canonicals), so they stay nudge-eligible.
   */
  private readonly knownBoxCanonicals = new Set<string>();
  private readonly allocator: AppUserAllocator;
  /**
   * The data-plane apex these pod canonicals live under — `flagship.services`
   * in prod, `gym.flagship.services` in the test env. Held here (not only in
   * the allocator) so the registry can do its own apex-RELATIVE user-zone
   * extraction for account-scoped lookups (the gossip fan-out).
   */
  private readonly apex: string;

  constructor(opts: { allocator?: AppUserAllocator; apex?: string } = {}) {
    this.apex = (opts.apex ?? "flagship.services").toLowerCase();
    this.allocator = opts.allocator ?? new AppUserAllocator({ apex: opts.apex });
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
    // Remember this pod canonical forever (RAM-only) so a later miss on it is
    // recognized as a box's own offline apex, NOT a nudge-able leader-route.
    this.knownBoxCanonicals.add(pc);
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
   * exact match (canonical or held shortened); falls back to a single
   * leftmost-label strip so `<service>.<podCanonical>` routes to the
   * pod. The strip IS the routing for the A′ per-box wildcard claim
   * `*.<server>.<user>.flagship.services` (the hub admits only the
   * pod's own wildcard and consumes it before register) — one label
   * deep, matching the box's wildcard-cert scope. Tier-2
   * `<service>.<user>` names never need the fallback: they resolve as
   * allocator slots (FCFS + failover queue).
   */
  findBySni(sni: string): RegisteredTunnel | undefined {
    const lower = sni.toLowerCase();
    // A real SNI is a hostname; a literal `*` (e.g. someone replaying
    // a wildcard claim as an SNI) must never strip-match into a pod.
    if (lower.includes("*")) return undefined;
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

  /**
   * Every connected tunnel whose pod canonical lives in `<username>`'s zone —
   * i.e. the user-zone label immediately left of the apex suffix equals
   * `username`. This is the account-scoped membership the gossip fan-out
   * (`broadcast--<user>.flagship.services`) delivers to: a box POSTs an opaque
   * blob and the hub mirrors it to every OTHER box of the same account.
   *
   * Apex-RELATIVE (the user is the last label after the apex suffix is
   * stripped, never a fixed offset from the right) so the `gym.` test apex
   * parses correctly. A pod canonical is `<server>.<user>.<apex>`, so the
   * user label is the LAST label of the apex-stripped head.
   */
  tunnelsForUser(username: string): RegisteredTunnel[] {
    const user = username.trim().toLowerCase();
    if (!user) return [];
    const out: RegisteredTunnel[] = [];
    for (const [pc, t] of this.tunnels) {
      if (this.userOfPod(pc) === user) out.push(t);
    }
    return out;
  }

  /** The user-zone label of a pod canonical, apex-relative, or null. */
  private userOfPod(podCanonical: string): string | null {
    const suffix = "." + this.apex;
    const lower = podCanonical.toLowerCase();
    if (!lower.endsWith(suffix)) return null;
    const head = lower.slice(0, -suffix.length);
    if (head.length === 0) return null;
    const parts = head.split(".");
    if (parts.length < 2) return null; // need at least <server>.<user>
    const user = parts[parts.length - 1]!;
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(user) ? user : null;
  }

  /**
   * The user-zone label for an arbitrary inbound SNI, apex-relative, or null
   * if the SNI is not a flagship.services name under this apex (e.g. a custom
   * domain). A leader-routed meta-URL `<service>.<user>.<apex>` and a pod
   * canonical `<server>.<user>.<apex>` both yield `<user>` — the user is always
   * the last label of the apex-stripped head.
   */
  userOfSni(sni: string): string | null {
    const suffix = "." + this.apex;
    const lower = sni.toLowerCase();
    if (lower.includes("*")) return null;
    if (!lower.endsWith(suffix)) return null;
    const head = lower.slice(0, -suffix.length);
    if (head.length === 0) return null;
    const parts = head.split(".");
    if (parts.length < 2) return null; // need at least <something>.<user>
    const user = parts[parts.length - 1]!;
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(user) ? user : null;
  }

  /**
   * Has this account at least one CURRENTLY-CONNECTED tunnel? Cheaper than
   * materializing `tunnelsForUser` — used by the SNI router's nudge gate.
   */
  hasOnlineTunnelsForUser(username: string): boolean {
    const user = username.trim().toLowerCase();
    if (!user) return false;
    for (const pc of this.tunnels.keys()) {
      if (this.userOfPod(pc) === user) return true;
    }
    return false;
  }

  /**
   * Decide whether an inbound-SNI MISS is eligible for the park→nudge→wait
   * resolution path (vs. today's immediate drop).
   *
   * The rule (documented precisely):
   *   nudge iff ALL of —
   *     (a) the SNI is a first-party `<...>.<user>.<apex>` name under this apex
   *         (NOT a custom domain — `userOfSni(sni)` is non-null), AND
   *     (b) that `<user>` has ≥1 currently-connected tunnel
   *         (`hasOnlineTunnelsForUser`), AND
   *     (c) the exact SNI is NOT a known (currently-or-recently registered) box
   *         canonical — a box's own apex/canonical that is simply offline is NOT
   *         a leader-routed meta-URL, so re-electing for it is meaningless.
   *
   * Caller has already confirmed `findBySni(sni)` is a miss. We deliberately do
   * NOT additionally require an exact tier-2 `<service>.<user>` two-label shape:
   * a `<service>.<server>.<user>` (tier-1) name whose box is momentarily absent
   * is ALSO a plausible leader-route to nudge for, and the box that elects
   * itself will register a name that lands in the registry (or it won't, and we
   * time out and drop). The box-canonical exclusion (c) is the safe floor that
   * keeps an offline box's apex out.
   */
  isNudgeableSni(sni: string): boolean {
    const lower = sni.toLowerCase();
    const user = this.userOfSni(lower);
    if (!user) return false;
    if (this.knownBoxCanonicals.has(lower)) return false;
    return this.hasOnlineTunnelsForUser(user);
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
