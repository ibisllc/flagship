import type { Frame } from "@flagship/tunnel-protocol";

export interface StreamCallbacks {
  onData(data: Uint8Array): void;
  onRemoteClose(): void;
}

export interface RegisteredTunnel {
  readonly serverId: string;
  readonly subdomains: ReadonlyArray<string>;
  send(frame: Frame): void;
  attachStream(streamId: number, callbacks: StreamCallbacks): void;
  detachStream(streamId: number): void;
  nextStreamId(): number;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Maps SNI hostnames to active tunnels. Supports exact matches and wildcard
 * subdomains (e.g. `*.harry.flagship.services` matches `photos.harry.flagship.services`).
 *
 * Wildcards bind one DNS label only — `*.flagship.services` does NOT match
 * `photos.harry.flagship.services`. This matches RFC 6125 / browser behavior.
 */
export class TunnelRegistry {
  private readonly byId = new Map<string, RegisteredTunnel>();
  private readonly byDomain = new Map<string, RegisteredTunnel>();

  register(t: RegisteredTunnel): RegisterResult {
    for (const sd of t.subdomains) {
      const existing = this.byDomain.get(sd);
      if (existing && existing.serverId !== t.serverId) {
        return { ok: false, reason: `subdomain ${sd} already claimed by ${existing.serverId}` };
      }
    }
    this.byId.set(t.serverId, t);
    for (const sd of t.subdomains) this.byDomain.set(sd, t);
    return { ok: true };
  }

  unregister(serverId: string): void {
    const t = this.byId.get(serverId);
    if (!t) return;
    this.byId.delete(serverId);
    for (const sd of t.subdomains) {
      if (this.byDomain.get(sd) === t) this.byDomain.delete(sd);
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
