/**
 * The relay directory as a mesh relay holds it (relay-mesh.md §3.3): the newest CA-signed directory it verified (from
 * the feed's `directory.json` or a peer), never going back a version, and the relay blessings it holds for other
 * relays (from `directory.json`'s `blessings` and from bridge handshakes), so a peer that restarted while `.com` was
 * down can be admitted on its key and handed its own blessing back (§6.2).
 */
import {
  DIRECTORY_EXPIRED_UNHEALTHY_MS,
  directoryRelay,
  newerRelayDirectory,
  verifyRelayBlessing,
  verifyRelayDirectory,
  type RelayBlessing,
  type RelayDirectory,
  type RelayDirectoryEntry,
  type RelayLogState,
} from "@flagship/protocol";

export interface MeshDirectoryOptions {
  servicesApex: string;
  /** The CA keys authorized now (`relayMeshCaKeys` over the maintainer chain). */
  caKeys: () => readonly string[];
  now?: () => number;
  log?: (m: string) => void;
}

export class MeshDirectory {
  current: RelayDirectory | null = null;
  private readonly blessings = new Map<string, RelayBlessing>();
  private rejected = 0;
  private readonly now: () => number;

  constructor(private readonly opts: MeshDirectoryOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** A directory from the feed or a peer. True when adopted (newer than the one held). */
  offer(raw: unknown): boolean {
    const d = raw as RelayDirectory;
    const v = verifyRelayDirectory(d, this.opts.caKeys(), this.now(), this.opts.servicesApex);
    if (!v.ok) {
      this.rejected++;
      this.opts.log?.(`[mesh-directory] rejected a directory: ${v.reason}`);
      return false;
    }
    if (!newerRelayDirectory(this.current, d)) return false;
    this.current = d;
    // A held blessing whose key the directory no longer lists for that relay is dropped.
    for (const [id, b] of this.blessings) if (directoryRelay(d, id)?.relayKey !== b.relayKey) this.blessings.delete(id);
    return true;
  }

  /** `directory.json`: `{directory, blessings}`. */
  offerFile(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const o = raw as { directory?: unknown; blessings?: unknown };
    const adopted = o.directory ? this.offer(o.directory) : false;
    if (Array.isArray(o.blessings)) for (const b of o.blessings) this.offerBlessing(b);
    return adopted;
  }

  /** Keep a valid blessing for another relay (the one expiring last, whose key the directory lists). */
  offerBlessing(raw: unknown): boolean {
    const b = raw as RelayBlessing;
    if (!verifyRelayBlessing(b, this.opts.caKeys(), this.now(), this.opts.servicesApex).ok) return false;
    const listed = directoryRelay(this.current, b.relayId);
    if (listed && listed.relayKey !== b.relayKey) return false;
    const had = this.blessings.get(b.relayId);
    if (had && had.relayKey === b.relayKey && had.expiresAt >= b.expiresAt) return false;
    this.blessings.set(b.relayId, b);
    return true;
  }

  /** A still-valid blessing held for `relayId`, or null. */
  heldBlessing(relayId: string): RelayBlessing | null {
    const b = this.blessings.get(relayId);
    if (!b) return null;
    if (!verifyRelayBlessing(b, this.opts.caKeys(), this.now(), this.opts.servicesApex).ok) {
      this.blessings.delete(relayId);
      return null;
    }
    return b;
  }

  entry(relayId: string): RelayDirectoryEntry | null {
    return directoryRelay(this.current, relayId);
  }

  version(): number {
    return this.current?.directoryVersion ?? 0;
  }

  /** The other relays listed and not revoked in the log. */
  peers(selfId: string, log: RelayLogState | null): RelayDirectoryEntry[] {
    return (this.current?.relays ?? []).filter((r) => r.relayId !== selfId && !log?.revokedRelays.has(r.relayId));
  }

  /** §3.3: an expired directory is still used, but makes `/api/health` 503 this long past its expiry. */
  unhealthy(): boolean {
    return !!this.current && this.now() >= this.current.expiresAt + DIRECTORY_EXPIRED_UNHEALTHY_MS;
  }

  /** Every held blessing (sent with the directory to a peer whose version is lower). */
  blessingList(): RelayBlessing[] {
    return [...this.blessings.keys()].map((id) => this.heldBlessing(id)).filter((b): b is RelayBlessing => b !== null);
  }

  stats(): { version: number; relays: number; expiresAt: number | null; blessings: number; rejected: number } {
    return {
      version: this.version(),
      relays: this.current?.relays.length ?? 0,
      expiresAt: this.current?.expiresAt ?? null,
      blessings: this.blessings.size,
      rejected: this.rejected,
    };
  }
}
