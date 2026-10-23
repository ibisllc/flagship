/**
 * The routing table: three independent random identifiers per conversation, bounded.
 *
 *   initiator app's local id  ──┐
 *   inter-harness wire id     ──┼── one record on each harness; neither app learns the others
 *   receiver app's local id   ──┘
 *
 * A record binds its local id to the local app that owns it, the authenticated peer, the wire id,
 * the logical target, the lead generation and its state; every hop checks the complete binding and
 * fails closed on any mismatch. Random ids prevent guessing and accidental reuse; they cannot
 * detect a corrupted table, so the binding is what is trusted. A conversation is `established`
 * only once the first reply has reached the initiator and the peer said so.
 */
import { appKey, randomId, type AppIdentity } from "./types.js";

export type ConversationState = "pending-outbound" | "pending-inbound" | "awaiting-first-reply" | "established" | "closed" | "dead";

export interface Conversation {
  localId: string;
  wireId: string;
  /** The local app that owns this handle. Another local app presenting the id is refused. */
  localApp: AppIdentity;
  side: "initiator" | "receiver";
  /** The authenticated peer box key; "" for a conversation among the owner's own deployments. */
  peerKey: string;
  /** `author--app.targetuser` as resolved; no server is ever part of a cross-user target. */
  logicalTarget: string;
  leadGeneration: number;
  /** Bumped whenever the app's runtime restarts: a stale handle cannot attach to a new conversation. */
  runtimeGeneration: number;
  state: ConversationState;
  createdAt: number;
  lastActivityAt: number;
  /** Highest counter accepted from the peer / last sent, for replay refusal. */
  inCounter: number;
  outCounter: number;
  /** The authorization this conversation runs under. */
  authorization: "own-deployment" | "allow" | "always-allow" | "invitation";
  /** For an always-allow conversation: the standing approval it runs under (`always:` key). */
  standing?: string;
  /** For an invitation-authorized conversation: the slot to release when it ends. */
  slotKey: string | null;
  /** Both halves of a conversation among the owner's own deployments on this box; null across boxes. */
  localPeerId: string | null;
}

/** What survives an ordinary restart: metadata only, never bodies. */
export interface EstablishedTombstone {
  localId: string;
  localAppKey: string;
  wireId: string;
  peerKey: string;
  endedAt: number | null;
}

export class RoutingTable {
  private byLocal = new Map<string, Conversation>();
  private byWire = new Map<string, Conversation>();
  /** Conversations known to have been two-way, kept as bare metadata so `conversation-dead` is honest. */
  private established = new Map<string, EstablishedTombstone>();

  constructor(
    private readonly max = 4096,
    private readonly tombstoneMax = 8192,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.byLocal.size;
  }

  create(c: Omit<Conversation, "localId" | "wireId" | "createdAt" | "lastActivityAt" | "inCounter" | "outCounter" | "localPeerId"> & { wireId?: string; localPeerId?: string | null }): Conversation | null {
    if (this.byLocal.size >= this.max) this.evictOldestUnestablished();
    if (this.byLocal.size >= this.max) return null;
    const t = this.now();
    const rec: Conversation = { ...c, localId: randomId(), wireId: c.wireId ?? randomId(), createdAt: t, lastActivityAt: t, inCounter: 0, outCounter: 0, localPeerId: c.localPeerId ?? null };
    this.byLocal.set(rec.localId, rec);
    this.byWire.set(rec.wireId, rec);
    return rec;
  }

  /** The caller's own handle. Another app's, or a stale generation's, is not found. */
  forLocal(localId: string, caller: AppIdentity, runtimeGeneration?: number): Conversation | null {
    const c = this.byLocal.get(localId);
    if (!c || appKey(c.localApp) !== appKey(caller)) return null;
    if (runtimeGeneration !== undefined && c.runtimeGeneration !== runtimeGeneration) return null;
    return c;
  }

  /** A frame's wire id. It must come from the peer this record is bound to. */
  forWire(wireId: string, peerKey: string): Conversation | null {
    const c = this.byWire.get(wireId);
    return c && c.peerKey === peerKey ? c : null;
  }

  /** The record behind a wire id regardless of peer, for refusing a mismatch (never answered to the sender). */
  wireExists(wireId: string): boolean {
    return this.byWire.has(wireId);
  }

  touch(c: Conversation): void {
    c.lastActivityAt = this.now();
  }

  establish(c: Conversation): void {
    c.state = "established";
    this.established.set(c.localId, { localId: c.localId, localAppKey: appKey(c.localApp), wireId: c.wireId, peerKey: c.peerKey, endedAt: null });
    while (this.established.size > this.tombstoneMax) this.established.delete(this.established.keys().next().value!);
  }

  /**
   * Close a conversation. Returns whether the local app should hear `conversation-dead`: only if it
   * was established as two-way and we hold the evidence.
   */
  end(c: Conversation, as: "closed" | "dead"): { notifyDead: boolean } {
    const wasEstablished = c.state === "established";
    c.state = as;
    const t = this.established.get(c.localId);
    if (t) t.endedAt = this.now();
    this.byLocal.delete(c.localId);
    this.byWire.delete(c.wireId);
    return { notifyDead: as === "dead" && wasEstablished };
  }

  /** A handle for a conversation that is gone: was it ever established? Evidence only, no guessing. */
  wasEstablished(localId: string, caller: AppIdentity): boolean {
    const t = this.established.get(localId);
    return !!t && t.localAppKey === appKey(caller);
  }

  /** All active conversations of one app (revocation, uninstall, runtime restart). */
  of(app: AppIdentity): Conversation[] {
    return [...this.byLocal.values()].filter((c) => appKey(c.localApp) === appKey(app));
  }

  all(): Conversation[] {
    return [...this.byLocal.values()];
  }

  private evictOldestUnestablished(): void {
    let victim: Conversation | null = null;
    for (const c of this.byLocal.values()) {
      if (c.state === "established") continue;
      if (!victim || c.lastActivityAt < victim.lastActivityAt) victim = c;
    }
    if (victim) this.end(victim, "closed");
  }
}

/**
 * Bounded replay protection for one direction of one conversation: a counter must be strictly
 * greater than the last accepted. (Frames are authenticated by the box transport; this stops an
 * old frame being replayed into a live conversation.)
 */
export function acceptCounter(c: Conversation, counter: number): boolean {
  if (!Number.isSafeInteger(counter) || counter <= c.inCounter) return false;
  c.inCounter = counter;
  return true;
}
