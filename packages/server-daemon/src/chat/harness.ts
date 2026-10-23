/**
 * The chat harness (SECURITY-HARDENING-PLAN.md 16.6, 17.5-17.8 and 18.8).
 *
 * What an app can do: `listen`, `message` (start or reply) and `close`, each authenticated by its
 * app token. What it cannot: pick a server for another owner's app, learn whether anything remote
 * exists, see another app's handles, or turn a message into authority. Every remote outcome returns
 * the same `{accepted: true}`.
 *
 * Messages among the owner's own deployments are permissionless. Another owner's app is reached
 * only through its current lead, with the sender's admin approving the outgoing scope before
 * contact and the receiver's admin approving (Allow / Always allow) after a matching listener is
 * confirmed, or a verified invitation proof standing in for that alert. No matching listener means
 * a silent drop with nothing queued, no alert and no nonce used.
 */
import { appKey, ChatInputError, MAX_BODY_BYTES, MAX_REQUEST_ID, type Accepted, type AppIdentity, type ConversationEvent, type InboundEnvelope, type OriginScope, type OwnedInstanceScope, type Rank } from "./types.js";
import { acceptCounter, RoutingTable, type Conversation } from "./conversations.js";
import type { ChatProof, InvitationAdmission, LeadAuthority } from "./admission.js";

export interface WireFrame {
  kind: "start" | "reply" | "close" | "ack";
  /** Inter-harness id. Neither app's local id ever travels. */
  wireId: string;
  counter: number;
  leadGeneration: number;
  /** For `start`: the logical target. There is never a server in it. */
  target?: { author: string; slug: string; targetUser: string };
  claimedSender?: AppIdentity;
  submittedAt?: number;
  body?: string;
  proof?: ChatProof;
  /** Optional human recognition phrase: shown to admins, never to apps, never logged. */
  phrase?: string;
}

/** Box-to-box carrier. It authenticates the peer and addresses a cross-user target by its app's name. */
export interface ChatTransport {
  /** Sends to the target app's canonical name (the relay delivers to whichever box holds it); returns the peer's route key. */
  sendToLead(target: { author: string; slug: string; targetUser: string }, frame: WireFrame): Promise<{ peerKey: string }>;
  sendOnRoute(peerKey: string, frame: WireFrame): Promise<void>;
}

export interface ApprovalRequest {
  kind: "incoming" | "outgoing";
  requestId: string;
  /** Wording the admin sees; a claim, never an identity. */
  claimedSender: AppIdentity;
  receiverApp: AppIdentity;
  phrase?: string;
  count: number;
}

export interface ChatNotifier {
  approval(r: ApprovalRequest): void;
}

export interface HarnessOptions {
  self: { account: string };
  /** Resolve an app token's owner to its identity; the harness trusts nothing else about the caller. */
  lead: LeadAuthority;
  admission: InvitationAdmission | null;
  transport: ChatTransport;
  notifier: ChatNotifier;
  /** Does this box host the app `target` (author--slug) for the account? */
  hostsApp: (app: AppIdentity) => boolean;
  now?: () => number;
  limits?: Partial<Limits>;
  /**
   * False until this box is connected to the carrier that reaches other owners' leads: a start for
   * another owner is then accepted (the app learns nothing either way) and goes nowhere, with no
   * alert and nothing held.
   */
  crossOwner?: boolean;
}

export interface Limits {
  pendingRequestsMax: number;
  pendingBodyBytesMax: number;
  pendingAgeMs: number;
  inboxMax: number;
  perAppSendsPerWindow: number;
  windowMs: number;
  alertEveryMs: number;
  unansweredFloor: number;
}

const DEFAULT_LIMITS: Limits = {
  pendingRequestsMax: 32,
  pendingBodyBytesMax: 256 * 1024,
  pendingAgeMs: 24 * 3_600_000,
  inboxMax: 256,
  perAppSendsPerWindow: 120,
  windowMs: 60_000,
  alertEveryMs: 30_000,
  unansweredFloor: 30,
};

interface Listener {
  id: string;
  app: AppIdentity;
  originScope: OriginScope;
  ownedInstanceScope: OwnedInstanceScope;
  runtimeGeneration: number;
}

interface Pending {
  requestId: string;
  frame: WireFrame;
  peerKey: string;
  receiver: AppIdentity;
  receivedAt: number;
  bytes: number;
  count: number;
}

export class ChatHarness {
  readonly table: RoutingTable;
  private readonly now: () => number;
  private readonly limits: Limits;
  private listeners = new Map<string, Listener>();
  private inboxes = new Map<string, ConversationEvent[]>();
  private runtimeGen = new Map<string, number>();
  /** requestId dedupe per authenticated caller. */
  private requests = new Map<string, { digest: string; result: Accepted }>();
  /**
   * Standing Always allow, one per (sending account, claimed sending app, receiving app): an answer
   * about one remote app never opens the receiver to anyone else. The sending account is the
   * authenticated peer; the app name inside it stays a claim.
   */
  private alwaysAllow = new Map<string, { peerKey: string; sender: AppIdentity; receiver: AppIdentity }>();
  private outboundApproved = new Set<string>();
  private pendingIn = new Map<string, Pending>();
  private heldOut = new Map<string, { frame: WireFrame; app: AppIdentity; localId: string; target: { author: string; slug: string; targetUser: string } }>();
  private notifier: ChatNotifier;
  private lastAlertAt = 0;
  private sends = new Map<string, { windowStart: number; count: number; starts: number; replies: number; cooldownUntil: number; strikes: number }>();

  constructor(private readonly o: HarnessOptions) {
    this.notifier = o.notifier;
    this.now = o.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
    this.table = new RoutingTable(4096, 8192, this.now);
  }

  /** The surface that wakes the owner is bound after the screens and the push relay exist. */
  setNotifier(n: ChatNotifier): void {
    this.notifier = n;
  }

  // ── what an app calls ────────────────────────────────────────────────────

  /** A new runtime for this app: every handle from the old one is stale and its listeners are gone. */
  runtimeRestarted(app: AppIdentity): void {
    this.runtimeGen.set(appKey(app), (this.runtimeGen.get(appKey(app)) ?? 0) + 1);
    for (const [id, l] of this.listeners) if (appKey(l.app) === appKey(app)) this.listeners.delete(id);
    this.inboxes.delete(appKey(app));
  }

  /** Register willingness to receive. Never prompts anyone, never opens a connection. */
  listen(app: AppIdentity, s: { originScope: OriginScope; ownedInstanceScope: OwnedInstanceScope }): { subscriptionId: string } {
    if (!["same-account", "all-accounts"].includes(s.originScope) || !["this-server", "owned-instances"].includes(s.ownedInstanceScope)) {
      throw new ChatInputError("bad-request", "unknown listener scope");
    }
    const id = crypto.randomUUID();
    this.listeners.set(id, { id, app, originScope: s.originScope, ownedInstanceScope: s.ownedInstanceScope, runtimeGeneration: this.gen(app) });
    return { subscriptionId: id };
  }

  unlisten(app: AppIdentity, subscriptionId: string): void {
    const l = this.listeners.get(subscriptionId);
    if (l && appKey(l.app) === appKey(app)) this.listeners.delete(subscriptionId);
  }

  /** Drain what has arrived for this app. */
  poll(app: AppIdentity): ConversationEvent[] {
    const box = this.inboxes.get(appKey(app));
    if (!box || box.length === 0) return [];
    return box.splice(0);
  }

  /** Start a conversation. Any remote outcome is the same `{accepted, conversationId}`. */
  async start(
    caller: AppIdentity,
    a: { receiverAuthor: string; receiverApp: string; body: string; targetUser?: string; requestId: string; accessProof?: ChatProof; phrase?: string; server?: unknown },
  ): Promise<Accepted> {
    this.validateBody(a.body, a.requestId);
    const targetUser = (a.targetUser ?? "self").toLowerCase();
    const cross = targetUser !== "self" && targetUser !== this.o.self.account.toLowerCase();
    if (cross && a.server !== undefined) throw new ChatInputError("bad-request", "another owner's server cannot be chosen");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(a.receiverAuthor) || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(a.receiverApp)) throw new ChatInputError("bad-request", "bad app name");
    const digest = JSON.stringify([a.receiverAuthor, a.receiverApp, targetUser, a.body]);
    const dedupe = this.dedupe(caller, a.requestId, digest);
    if (dedupe) return dedupe;
    this.checkRate(caller, "start");

    const receiver = { author: a.receiverAuthor, slug: a.receiverApp };
    const conv = this.table.create({
      localApp: caller,
      side: "initiator",
      peerKey: cross ? "pending" : "",
      logicalTarget: `${appKey(receiver)}.${cross ? targetUser : "self"}`,
      leadGeneration: this.o.lead.generation(),
      runtimeGeneration: this.gen(caller),
      state: "pending-outbound",
      authorization: cross ? "allow" : "own-deployment",
      slotKey: null,
    });
    if (!conv) throw new ChatInputError("rate-limited", "too many conversations are open");
    const result: Accepted = { accepted: true, conversationId: conv.localId };
    this.remember(caller, a.requestId, digest, result);

    const frame: WireFrame = {
      kind: "start", wireId: conv.wireId, counter: ++conv.outCounter, leadGeneration: conv.leadGeneration,
      target: { author: receiver.author, slug: receiver.slug, targetUser: cross ? targetUser : "self" },
      claimedSender: caller, submittedAt: this.now(), body: a.body,
      ...(a.accessProof ? { proof: a.accessProof } : {}), ...(a.phrase ? { phrase: a.phrase.slice(0, 30) } : {}),
    };

    if (!cross) {
      this.deliverLocalStart(caller, receiver, conv, frame);
      return result;
    }
    if (this.o.crossOwner === false) return result;
    // Only the instance at the app's canonical name talks to other owners: replies come back to that
    // name, so a start from an instance on another of the owner's servers would never hear them.
    if (!this.o.lead.mayAdmit(appKey(caller))) return result;
    // Another owner: the sending admin approves this outgoing scope before any contact. With a
    // visitor's invitation proof the access itself is the authorization for this route.
    const scope = `${appKey(caller)}>${appKey(receiver)}.${targetUser}`;
    if (!a.accessProof && !this.outboundApproved.has(scope)) {
      this.heldOut.set(conv.localId, { frame, app: caller, localId: conv.localId, target: frame.target! });
      this.raise({ kind: "outgoing", requestId: conv.localId, claimedSender: caller, receiverApp: receiver, count: 1, ...(a.phrase ? { phrase: a.phrase } : {}) });
      return result;
    }
    this.sendStart(conv, frame);
    return result;
  }

  /** Reply (or send another message) in a conversation the caller owns. */
  async reply(caller: AppIdentity, a: { conversationId: string; body: string; requestId: string }): Promise<Accepted> {
    this.validateBody(a.body, a.requestId);
    const conv = this.table.forLocal(a.conversationId, caller, this.gen(caller));
    if (!conv) {
      // Honest only for a conversation this app previously held as two-way with evidence.
      if (this.table.wasEstablished(a.conversationId, caller)) {
        this.push(caller, { type: "conversation-dead", conversationId: a.conversationId });
        return { accepted: true };
      }
      throw new ChatInputError("unknown-conversation", "unknown conversation");
    }
    const digest = JSON.stringify([a.conversationId, a.body]);
    const dedupe = this.dedupe(caller, a.requestId, digest);
    if (dedupe) return dedupe;
    this.checkRate(caller, "reply");
    this.remember(caller, a.requestId, digest, { accepted: true });
    this.table.touch(conv);
    const frame: WireFrame = { kind: "reply", wireId: conv.wireId, counter: ++conv.outCounter, leadGeneration: conv.leadGeneration, claimedSender: caller, submittedAt: this.now(), body: a.body };
    if (conv.peerKey === "") {
      this.deliverLocalReply(conv, frame);
    } else {
      void this.o.transport.sendOnRoute(conv.peerKey, frame).catch(() => {});
    }
    return { accepted: true };
  }

  async close(caller: AppIdentity, a: { conversationId: string }): Promise<Accepted> {
    const conv = this.table.forLocal(a.conversationId, caller, this.gen(caller));
    if (!conv) return { accepted: true };
    if (conv.peerKey !== "") void this.o.transport.sendOnRoute(conv.peerKey, { kind: "close", wireId: conv.wireId, counter: ++conv.outCounter, leadGeneration: conv.leadGeneration }).catch(() => {});
    await this.endConversation(conv, "closed");
    return { accepted: true };
  }

  // ── what the admin does ──────────────────────────────────────────────────

  /** The sending admin approves (or denies) an outgoing start that was held. */
  async approveOutgoing(requestId: string, decision: "allow" | "deny"): Promise<boolean> {
    const held = this.heldOut.get(requestId);
    if (!held) return false;
    this.heldOut.delete(requestId);
    const conv = this.table.forLocal(requestId, held.app);
    if (decision === "deny" || !conv) {
      if (conv) await this.endConversation(conv, "closed");
      return true;
    }
    this.outboundApproved.add(`${appKey(held.app)}>${appKey({ author: held.target.author, slug: held.target.slug })}.${held.target.targetUser}`);
    this.sendStart(conv, held.frame);
    return true;
  }

  /** The receiving admin answers a held request. `always` covers new conversations to this app. */
  async answerIncoming(requestId: string, decision: "allow" | "always" | "deny"): Promise<boolean> {
    const p = this.pendingIn.get(requestId);
    if (!p) return false;
    this.pendingIn.delete(requestId);
    if (decision === "deny") return true;
    let standing: string | undefined;
    if (decision === "always") {
      standing = alwaysKey(p.peerKey, p.frame.claimedSender!, p.receiver);
      this.alwaysAllow.set(standing, { peerKey: p.peerKey, sender: p.frame.claimedSender!, receiver: p.receiver });
    }
    await this.admitStart(p.frame, p.peerKey, p.receiver, decision === "always" ? "always-allow" : "allow", null, standing);
    return true;
  }

  /**
   * Revoke standing Always allows to `receiver` (only the one from `sender` when given), and end the
   * conversations they cover.
   */
  async revokeAlwaysAllow(receiver: AppIdentity, sender?: AppIdentity): Promise<number> {
    const gone = new Set<string>();
    for (const [k, v] of this.alwaysAllow) {
      if (appKey(v.receiver) === appKey(receiver) && (!sender || appKey(v.sender) === appKey(sender))) {
        this.alwaysAllow.delete(k);
        gone.add(k);
      }
    }
    let n = 0;
    for (const c of this.table.of(receiver)) {
      if (c.authorization === "always-allow" && c.standing && gone.has(c.standing)) {
        await this.endConversation(c, "dead", true);
        n++;
      }
    }
    return n;
  }

  /** Revoke a single conversation's Allow. */
  async revokeConversation(receiver: AppIdentity, localId: string): Promise<boolean> {
    const c = this.table.forLocal(localId, receiver);
    if (!c) return false;
    await this.endConversation(c, "dead", true);
    return true;
  }

  // ── what the transport hands in ──────────────────────────────────────────

  /** A frame from an authenticated peer box. Nothing is answered to the sender but protocol acks. */
  async receive(frame: WireFrame, peerKey: string, via?: AppIdentity): Promise<void> {
    if (frame.leadGeneration !== this.o.lead.generation()) return; // a fenced or stale generation
    if (frame.kind === "start") {
      // A start is for the app whose own host it arrived on, on this account, and nothing else.
      if (via && (!frame.target || appKey(frame.target) !== appKey(via) || frame.target.targetUser.toLowerCase() !== this.o.self.account.toLowerCase())) return;
      return this.receiveStart(frame, peerKey);
    }
    const conv = this.table.forWire(frame.wireId, peerKey);
    if (!conv) return; // unknown or mis-bound route: dropped, never explained
    if (via && appKey(conv.localApp) !== appKey(via)) return;
    if (conv.leadGeneration !== frame.leadGeneration) return;
    if (!acceptCounter(conv, frame.counter)) return;
    if (frame.kind === "close") {
      await this.endConversation(conv, "dead", true);
      return;
    }
    if (frame.kind === "ack") {
      if (conv.state === "awaiting-first-reply" || conv.state === "pending-inbound") this.table.establish(conv);
      return;
    }
    if (frame.kind === "reply") {
      // Re-check the invitation's access at every delivery; the rank delivered is the current one.
      let rank: Rank | undefined;
      if (conv.authorization === "invitation" && this.o.admission && conv.slotKey) {
        const perAppId = conv.slotKey.split("|")[1]!;
        const access = await this.o.admission.recheck(conv.logicalTarget, perAppId);
        if (!access.active) {
          await this.endConversation(conv, "dead", true);
          return;
        }
        rank = access.rank;
      }
      if (conv.side === "initiator" && conv.state !== "established") {
        this.table.establish(conv);
        void this.o.transport.sendOnRoute(peerKey, { kind: "ack", wireId: conv.wireId, counter: ++conv.outCounter, leadGeneration: conv.leadGeneration }).catch(() => {});
        this.countReply(conv.localApp);
      }
      this.table.touch(conv);
      this.push(conv.localApp, { type: "message", envelope: this.envelope(conv, frame, rank) });
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Send a start to the target app's name and bind the route to the peer account. */
  private sendStart(conv: Conversation, frame: WireFrame): void {
    void this.o.transport
      .sendToLead(frame.target!, frame)
      .then((r) => {
        if (conv.peerKey === "pending") conv.peerKey = r.peerKey;
      })
      .catch(() => {});
  }

  private async receiveStart(frame: WireFrame, peerKey: string): Promise<void> {
    const t = frame.target;
    if (!t || typeof frame.body !== "string" || !frame.claimedSender) return;
    if (Buffer.byteLength(frame.body) > MAX_BODY_BYTES) return;
    if (this.table.wireExists(frame.wireId)) return; // a repeated or colliding id never reopens a route
    const receiver = { author: t.author, slug: t.slug };
    if (!this.o.hostsApp(receiver)) return;
    // Only the box holding the app's canonical name admits a cross-user start; any other says nothing.
    if (!this.o.lead.mayAdmit(appKey(receiver))) return;
    // No matching listener: drop silently. No queue, no alert, no proof or slot used.
    if (!this.hasListener(receiver, "all-accounts")) return;

    if (frame.proof && this.o.admission) {
      const r = await this.o.admission.admit({ requestId: frame.wireId, target: `${appKey(receiver)}.${t.targetUser}`, proof: frame.proof, recipientApp: appKey(receiver) });
      if (r.kind === "admitted") {
        await this.admitStart(frame, peerKey, receiver, "invitation", { slotKey: r.slotKey, rank: r.rank });
        return;
      }
      if (r.kind === "already-used") {
        // Only this visitor, who just proved their own access, hears it.
        void this.o.transport.sendOnRoute(peerKey, { kind: "close", wireId: frame.wireId, counter: 1, leadGeneration: frame.leadGeneration, body: "This connection has already been used; consider alerting the remote administrator." }).catch(() => {});
        return;
      }
      return; // generic: nothing is said
    }
    const standing = alwaysKey(peerKey, frame.claimedSender, receiver);
    if (this.alwaysAllow.has(standing)) {
      await this.admitStart(frame, peerKey, receiver, "always-allow", null, standing);
      return;
    }
    this.holdIncoming(frame, peerKey, receiver);
  }

  private holdIncoming(frame: WireFrame, peerKey: string, receiver: AppIdentity): void {
    const bytes = Buffer.byteLength(frame.body ?? "");
    const t = this.now();
    for (const [k, p] of this.pendingIn) if (t - p.receivedAt > this.limits.pendingAgeMs) this.pendingIn.delete(k);
    // Repeated requests from the same claimed sender to the same app group into one.
    for (const p of this.pendingIn.values()) {
      if (appKey(p.frame.claimedSender!) === appKey(frame.claimedSender!) && appKey(p.receiver) === appKey(receiver) && p.peerKey === peerKey) {
        p.count++;
        return;
      }
    }
    const total = [...this.pendingIn.values()].reduce((n, p) => n + p.bytes, 0);
    if (this.pendingIn.size >= this.limits.pendingRequestsMax || total + bytes > this.limits.pendingBodyBytesMax) return; // bounded: beyond it, drop
    const requestId = crypto.randomUUID();
    this.pendingIn.set(requestId, { requestId, frame, peerKey, receiver, receivedAt: t, bytes, count: 1 });
    this.raise({ kind: "incoming", requestId, claimedSender: frame.claimedSender!, receiverApp: receiver, ...(frame.phrase ? { phrase: frame.phrase } : {}), count: 1 });
  }

  private async admitStart(
    frame: WireFrame,
    peerKey: string,
    receiver: AppIdentity,
    authorization: Conversation["authorization"],
    invitation: { slotKey: string; rank: Rank } | null,
    standing?: string,
  ): Promise<void> {
    if (!this.hasListener(receiver, "all-accounts")) return; // the listener may have gone while it waited
    const conv = this.table.create({
      wireId: frame.wireId, localApp: receiver, side: "receiver", peerKey, logicalTarget: `${appKey(receiver)}.${frame.target!.targetUser}`,
      leadGeneration: frame.leadGeneration, runtimeGeneration: this.gen(receiver), state: "awaiting-first-reply", authorization, slotKey: invitation?.slotKey ?? null,
      ...(standing ? { standing } : {}),
    });
    if (!conv) return;
    conv.inCounter = frame.counter;
    if (invitation && this.o.admission) await this.o.admission.bind(invitation.slotKey, conv.localId);
    this.push(receiver, { type: "message", envelope: this.envelope(conv, frame, invitation?.rank) });
  }

  private deliverLocalStart(caller: AppIdentity, receiver: AppIdentity, conv: Conversation, frame: WireFrame): void {
    // Messaging among the owner's own deployments: no approval. The sender's own runtime is excluded.
    const target = [...this.listeners.values()].find((l) => appKey(l.app) === appKey(receiver) && appKey(l.app) !== appKey(caller) && l.runtimeGeneration === this.gen(l.app));
    if (!target) return;
    const rc = this.table.create({
      localApp: receiver, side: "receiver", peerKey: "", logicalTarget: conv.logicalTarget, leadGeneration: conv.leadGeneration,
      runtimeGeneration: this.gen(receiver), state: "awaiting-first-reply", authorization: "own-deployment", slotKey: null, localPeerId: conv.localId,
    });
    if (!rc) return;
    // The two halves of a same-box conversation are linked here and nowhere an app can see.
    conv.localPeerId = rc.localId;
    conv.state = "awaiting-first-reply";
    this.push(receiver, { type: "message", envelope: this.envelope(rc, frame, undefined) });
  }

  private deliverLocalReply(conv: Conversation, frame: WireFrame): void {
    const other = conv.localPeerId ? this.table.all().find((c) => c.localId === conv.localPeerId) : undefined;
    if (!other) return;
    if (conv.side === "receiver" && other.state !== "established") {
      this.table.establish(other);
      this.table.establish(conv);
      this.countReply(other.localApp);
    }
    this.push(other.localApp, { type: "message", envelope: this.envelope(other, frame, undefined) });
  }

  private envelope(conv: Conversation, frame: WireFrame, rank: Rank | undefined): InboundEnvelope {
    return {
      conversationId: conv.localId,
      claimedSender: frame.claimedSender ?? { author: "", slug: "" },
      submittedAt: frame.submittedAt ?? 0,
      body: frame.body ?? "",
      ...(rank ? { verifiedAccess: { rank } } : {}),
    };
  }

  private async endConversation(conv: Conversation, as: "closed" | "dead", tellApp = false): Promise<void> {
    const slot = conv.slotKey;
    const peerLocal = conv.localPeerId ? this.table.all().find((c) => c.localId === conv.localPeerId) : undefined;
    const { notifyDead } = this.table.end(conv, as);
    if (peerLocal) this.table.end(peerLocal, as);
    if (slot && this.o.admission) await this.o.admission.release(slot);
    if ((notifyDead || tellApp) && as === "dead") this.push(conv.localApp, { type: "conversation-dead", conversationId: conv.localId });
  }

  private hasListener(app: AppIdentity, origin: OriginScope): boolean {
    for (const l of this.listeners.values()) {
      if (appKey(l.app) !== appKey(app) || l.runtimeGeneration !== this.gen(l.app)) continue;
      if (origin === "all-accounts" && l.originScope !== "all-accounts") continue;
      return true;
    }
    return false;
  }

  private push(app: AppIdentity, e: ConversationEvent): void {
    const k = appKey(app);
    const box = this.inboxes.get(k) ?? [];
    if (box.length >= this.limits.inboxMax) box.shift();
    box.push(e);
    this.inboxes.set(k, box);
  }

  private gen(app: AppIdentity): number {
    return this.runtimeGen.get(appKey(app)) ?? 0;
  }

  private validateBody(body: unknown, requestId: unknown): void {
    if (typeof body !== "string" || typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID) throw new ChatInputError("bad-request", "a message needs a body and a request id");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ChatInputError("too-large", "that message is too large");
  }

  private dedupe(caller: AppIdentity, requestId: string, digest: string): Accepted | null {
    const prior = this.requests.get(`${appKey(caller)}|${requestId}`);
    if (!prior) return null;
    if (prior.digest !== digest) throw new ChatInputError("request-id-reused", "that request id was used for different content");
    return prior.result;
  }

  private remember(caller: AppIdentity, requestId: string, digest: string, result: Accepted): void {
    if (this.requests.size > 8192) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(`${appKey(caller)}|${requestId}`, { digest, result });
  }

  /** Aggregate volume and unanswered-start ratio, with a gradual cooldown; never per-recipient facts. */
  private checkRate(caller: AppIdentity, kind: "start" | "reply"): void {
    const t = this.now();
    const k = appKey(caller);
    const s = this.sends.get(k) ?? { windowStart: t, count: 0, starts: 0, replies: 0, cooldownUntil: 0, strikes: 0 };
    if (t < s.cooldownUntil) throw new ChatInputError("rate-limited", "sending too fast; slow down");
    if (t - s.windowStart > this.limits.windowMs) {
      s.windowStart = t;
      s.count = 0;
    }
    s.count++;
    if (kind === "start") s.starts++;
    this.sends.set(k, s);
    const unanswered = s.starts - s.replies;
    if (s.count > this.limits.perAppSendsPerWindow || unanswered > this.limits.unansweredFloor) {
      // Gradual: each strike doubles the pause, capped. A single burst is not a ban.
      s.strikes = Math.min(s.strikes + 1, 8);
      s.cooldownUntil = t + Math.min(60_000 * 2 ** (s.strikes - 1), 3_600_000);
      throw new ChatInputError("rate-limited", "sending too fast; slow down");
    }
  }

  private countReply(app: AppIdentity): void {
    const s = this.sends.get(appKey(app));
    if (s) s.replies++;
  }

  /** Coalesced: at most one new alert per interval, no matter how many requests arrive. */
  private raise(r: ApprovalRequest): void {
    const t = this.now();
    if (t - this.lastAlertAt < this.limits.alertEveryMs) return;
    this.lastAlertAt = t;
    this.notifier.approval(r);
  }

  /** What waits for an admin, for the approval screens. Bodies never leave the harness. */
  pendingList(): Array<{ requestId: string; kind: "incoming" | "outgoing"; claimedSender: AppIdentity; receiverApp: AppIdentity; phrase?: string; count: number; at: number }> {
    const out: ReturnType<ChatHarness["pendingList"]> = [];
    for (const p of this.pendingIn.values()) {
      out.push({ requestId: p.requestId, kind: "incoming", claimedSender: p.frame.claimedSender!, receiverApp: p.receiver, ...(p.frame.phrase ? { phrase: p.frame.phrase } : {}), count: p.count, at: p.receivedAt });
    }
    for (const h of this.heldOut.values()) {
      out.push({ requestId: h.localId, kind: "outgoing", claimedSender: h.app, receiverApp: { author: h.target.author, slug: h.target.slug }, ...(h.frame.phrase ? { phrase: h.frame.phrase } : {}), count: 1, at: h.frame.submittedAt ?? 0 });
    }
    return out;
  }

  /** The standing Always allows: which claimed remote app may reach which of this owner's apps. */
  alwaysList(): Array<{ receiverApp: AppIdentity; claimedSender: AppIdentity }> {
    return [...this.alwaysAllow.values()].map((v) => ({ receiverApp: v.receiver, claimedSender: v.sender }));
  }

  /** For tests and the status page. */
  pendingCounts(): { incoming: number; outgoing: number } {
    return { incoming: this.pendingIn.size, outgoing: this.heldOut.size };
  }
}

function alwaysKey(peerKey: string, sender: AppIdentity, receiver: AppIdentity): string {
  return `always:${peerKey}|${appKey(sender)}>${appKey(receiver)}`;
}
