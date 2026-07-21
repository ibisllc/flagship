/**
 * In-memory SiblingView — what this box currently believes about its account
 * siblings, learned ENTIRELY from inbound `/internal/gossip` frames (a box never
 * learns siblings from its own broadcast POST, whose reply is empty/ignored).
 *
 * Keyed by sibling id (the announcement's `name` = podCanonical/fqdn). Each
 * record stores the clout-relevant fields (birthDate / vote / services) plus the
 * box's own liveness self-report and a LOCAL received-at timestamp. A sibling not
 * heard from within the liveness window is treated as not-live, so a dead sibling
 * drops out of elections quickly — this is what makes failover fast.
 */
import type { GossipAnnouncement } from "@flagship/protocol";

export interface SiblingRecord {
  /** Sibling identity — the announcement's `name`, lowercased. */
  id: string;
  /** The sibling's FQDN — the final lexicographic clout tie-break. */
  domain: string;
  /** The sibling's STK pub hex (its birth-cert authority hex), lowercased. */
  stkHex: string;
  birthDate: number;
  /** STK pubkey hex the owner's latest set-leader vote points at, or "none". */
  voteStkHex: string;
  /** The vote's issuedAt (ms), or 0 when there is no vote. */
  voteDate: number;
  services: string[];
  /** The sibling's OWN liveness self-report from the frame. */
  liveness: "live" | "unreachable" | "never";
  /** `issuedAt` from the frame (the sibling's clock). */
  issuedAt: number;
  /** LOCAL monotonic-ish wall clock when we accepted this frame. */
  receivedAt: number;
}

/** A member as the elector consumes it (self or a live sibling). */
export interface ViewMember {
  id: string;
  domain: string;
  /** The member's STK pub hex (its birth-cert authority hex), lowercased. */
  stkHex: string;
  birthDate: number;
  voteIssuedAt: number | null;
  liveness: "live" | "unreachable" | "never";
  services: string[];
}

export class SiblingView {
  private readonly records = new Map<string, SiblingRecord>();

  /**
   * Window after which a sibling not re-heard is treated as not-live. ~2-3× the
   * announce interval so a single missed tick doesn't drop a peer, but a dead
   * one falls out within a couple of rounds.
   */
  constructor(private readonly livenessWindowMs: number) {}

  /**
   * Upsert a verified announcement. `now` is injectable for tests. A newer frame
   * (or any frame, since this peer is authenticated by the CGK-HMAC) replaces the
   * stored record and refreshes receivedAt. An older `issuedAt` than what we hold
   * is ignored (stale/replayed frame) but does NOT refresh liveness.
   */
  upsert(a: GossipAnnouncement, now: number): void {
    const id = a.name.toLowerCase();
    const prev = this.records.get(id);
    if (prev && a.issuedAt < prev.issuedAt) {
      // Stale frame — keep the newer record; do not refresh receivedAt so a
      // replay can't keep a dead sibling alive.
      return;
    }
    this.records.set(id, {
      id,
      domain: a.name.toLowerCase(),
      stkHex: a.birthAuthHex.toLowerCase(),
      birthDate: a.birthDate,
      voteStkHex: a.voteStkHex,
      voteDate: a.voteDate,
      services: [...a.services],
      liveness: a.liveness,
      issuedAt: a.issuedAt,
      receivedAt: now,
    });
  }

  /** All siblings still within the liveness window (raw records). */
  liveSiblings(now: number): SiblingRecord[] {
    const out: SiblingRecord[] = [];
    for (const r of this.records.values()) {
      if (now - r.receivedAt <= this.livenessWindowMs) out.push(r);
    }
    return out;
  }

  /**
   * Live siblings projected into ViewMembers for the elector. A sibling that
   * self-reports `unreachable`/`never` is carried through with that liveness so
   * the elector excludes it — but a sibling whose receivedAt has aged out of the
   * window is dropped entirely (it can no longer vouch for itself).
   */
  liveMembers(now: number): ViewMember[] {
    return this.liveSiblings(now).map((r) => ({
      id: r.id,
      domain: r.domain,
      stkHex: r.stkHex,
      birthDate: r.birthDate,
      voteIssuedAt: r.voteStkHex !== "none" && r.voteDate > 0 ? r.voteDate : null,
      liveness: r.liveness,
      services: r.services,
    }));
  }

  /** Drop records aged past the window. Best-effort housekeeping. */
  prune(now: number): void {
    for (const [id, r] of this.records) {
      if (now - r.receivedAt > this.livenessWindowMs) this.records.delete(id);
    }
  }

  /** Snapshot for diagnostics/tests. */
  size(): number {
    return this.records.size;
  }
  get(id: string): SiblingRecord | undefined {
    return this.records.get(id.toLowerCase());
  }
}
