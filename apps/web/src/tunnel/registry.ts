import type { Frame } from "@flagship/tunnel-protocol";

export interface StreamCallbacks {
  onData(data: Uint8Array): void;
  onRemoteClose(): void;
}

export interface RegisteredTunnel {
  readonly serverId: string;
  /**
   * Mutable view of the FQDNs this tunnel currently claims. Updated in
   * place by `replaceClaims` so the hub can apply HELLO updates without
   * tearing down the WS.
   */
  controlledDomains: string[];
  send(frame: Frame): void;
  attachStream(streamId: number, callbacks: StreamCallbacks): void;
  detachStream(streamId: number): void;
  nextStreamId(): number;
}

export interface RegisterResult {
  ok: true;
  /**
   * FQDNs that were stolen from a prior tunnel by this one. The hub
   * uses this list to log + (optionally) notify the loser.
   */
  takeovers: Array<{ fqdn: string; previousServerId: string }>;
}

export interface ReplaceClaimsResult {
  takeovers: Array<{ fqdn: string; previousServerId: string }>;
  /** FQDNs released because this tunnel no longer holds them. */
  released: string[];
}

/**
 * Maps SNI hostnames to active tunnels. Supports exact matches and
 * one-label wildcards (`*.harry.flagship.services` matches
 * `photos.harry.flagship.services`). Wildcards bind one DNS label only —
 * `*.flagship.services` does NOT match `photos.harry.flagship.services`.
 *
 * Last-HELLO-wins: when a new tunnel claims an FQDN that another tunnel
 * already holds, the new claim atomically supersedes the old one. The
 * loser keeps its WS open but loses the route. (See N0b — sibling
 * coordination is between pods, not at the hub.)
 */
export class TunnelRegistry {
  private readonly byId = new Map<string, RegisteredTunnel>();
  private readonly byDomain = new Map<string, RegisteredTunnel>();

  register(t: RegisteredTunnel): RegisterResult {
    const takeovers: Array<{ fqdn: string; previousServerId: string }> = [];
    // Take over any FQDN currently held by a different tunnel.
    for (const sd of t.controlledDomains) {
      const lower = sd.toLowerCase();
      const existing = this.byDomain.get(lower);
      if (existing && existing.serverId !== t.serverId) {
        takeovers.push({ fqdn: lower, previousServerId: existing.serverId });
        existing.controlledDomains = existing.controlledDomains.filter(
          (x) => x.toLowerCase() !== lower,
        );
      }
    }
    // If this serverId already had a tunnel registered (reconnect), drop it.
    const prior = this.byId.get(t.serverId);
    if (prior && prior !== t) {
      for (const sd of prior.controlledDomains) {
        const lower = sd.toLowerCase();
        if (this.byDomain.get(lower) === prior) this.byDomain.delete(lower);
      }
    }
    this.byId.set(t.serverId, t);
    for (const sd of t.controlledDomains) {
      this.byDomain.set(sd.toLowerCase(), t);
    }
    return { ok: true, takeovers };
  }

  /**
   * Apply a HELLO update — replace this tunnel's claimed FQDN list. The
   * tunnel keeps its WS but its route table changes atomically.
   */
  replaceClaims(t: RegisteredTunnel, next: string[]): ReplaceClaimsResult {
    const cur = this.byId.get(t.serverId);
    if (cur !== t) throw new Error("tunnel not registered");
    const nextLower = next.map((s) => s.toLowerCase());
    const nextSet = new Set(nextLower);
    const curSet = new Set(t.controlledDomains.map((s) => s.toLowerCase()));
    const released: string[] = [];
    for (const sd of curSet) {
      if (!nextSet.has(sd)) {
        if (this.byDomain.get(sd) === t) this.byDomain.delete(sd);
        released.push(sd);
      }
    }
    const takeovers: Array<{ fqdn: string; previousServerId: string }> = [];
    for (const sd of nextLower) {
      const existing = this.byDomain.get(sd);
      if (existing && existing !== t) {
        takeovers.push({ fqdn: sd, previousServerId: existing.serverId });
        existing.controlledDomains = existing.controlledDomains.filter(
          (x) => x.toLowerCase() !== sd,
        );
      }
      this.byDomain.set(sd, t);
    }
    t.controlledDomains = nextLower;
    return { takeovers, released };
  }

  unregister(serverId: string): void {
    const t = this.byId.get(serverId);
    if (!t) return;
    this.byId.delete(serverId);
    for (const sd of t.controlledDomains) {
      const lower = sd.toLowerCase();
      if (this.byDomain.get(lower) === t) this.byDomain.delete(lower);
    }
  }

  findBySni(sni: string): RegisteredTunnel | undefined {
    const lower = sni.toLowerCase();
    const exact = this.byDomain.get(lower);
    if (exact) return exact;

    const dot = lower.indexOf(".");
    if (dot === -1) return undefined;
    const wildcard = "*" + lower.slice(dot);
    return this.byDomain.get(wildcard);
  }

  size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.byDomain.clear();
  }
}
