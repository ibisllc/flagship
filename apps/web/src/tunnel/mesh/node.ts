/**
 * One mesh relay (docs/architecture-v2/relay-mesh.md): the feed and log state, the directory, the attachment store,
 * the bridges, queries, account homes, rebalancing, legacy attachments and the phone ledger, wired together, plus the
 * hooks the existing relay pieces call: the tunnel hub (HELLO lookups from the log, ATTACHMENT frames, move hints),
 * the SNI router (§7.2 decisions, forwarding over a bridge), the serving gate (§4.4 inputs, freshness), the phone
 * routes (ledger relay and eligibility) and the HTTP server (`/mesh`, health, stats, drain).
 *
 * Everything here is behind `FLAGSHIP_MESH=on`; with it off none of this is constructed.
 */
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  accountHash,
  accountOfPodName,
  attachmentRefusalCode,
  isBarePhoneName,
  isPodName,
  nameHash as relayLogNameHash,
  MESH_ANNOUNCE_BATCH_MAX,
  MESH_ANNOUNCE_DELAY_MS,
  MESH_LOAD_INTERVAL_MS,
  MESH_LOG_PUSH_MAX,
  MOVE_COLOCATE_MIN_MS,
  MOVE_HINT_TTL_MS,
  ACCOUNT_MOVE_HINT_SPACING_MS,
  FEED_HEAD_MINT_MS,
  phoneLedgerRanking,
  directoryRelay,
  isPhoneLedgerFor,
  PHONE_LEDGER_TOP_K,
  relayLogBox,
  relayLogRevocations,
  signRelayMeshRecord,
  type AttachmentItem,
  type BoxAttachment,
  type MeshCheckContext,
  type MoveHint,
  type MoveHintReason,
  type PhoneItem,
  type RelayKind,
  type RelayLogState,
  type RevocationState,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { attachmentResultFrame, moveHintFrame, parseAttachmentFrame, type Frame, type MailboxAnnouncement } from "@flagship/tunnel-protocol";
import type { TunnelRegistry } from "../registry.js";
import type { ServingGate } from "../servingGate.js";
import type { PhoneRoutes } from "../phoneRoute.js";
import type { MailboxRegistry } from "../mailboxRelay.js";
import { AttachmentStore, type MailboxItem, type WithdrawItem } from "./attachments.js";
import { BridgeManager, bridgedSniMatches, type BridgePeer, type BridgeStream } from "./bridge.js";
import { MeshDirectory } from "./directory.js";
import { MeshFeed, type FeedSource } from "./feed.js";
import { AccountHomes } from "./home.js";
import { LegacyAnnouncer } from "./legacy.js";
import { answerLedgerRequest, MeshPhoneLedgerClient, PhoneLedgerHost, type LedgerTarget } from "./phoneLedger.js";
import { MeshQuery } from "./query.js";
import { Rebalancer } from "./rebalance.js";

/** What the node needs from the relay's blessing provider (`RelayBlessingProvider`). */
export interface MeshBlessing {
  relayKeyHex(): string;
  sign(msg: Uint8Array): Uint8Array;
  currentRelayBlessing(): import("@flagship/protocol").RelayBlessing | null;
  adopt(raw: unknown): boolean;
}

export interface MeshNodeOptions {
  relayId: string;
  relayKind: RelayKind;
  servicesApex: string;
  /** The log key (hex). */
  logKey: string;
  caKeys: () => readonly string[];
  blessing: MeshBlessing;
  feedSource: FeedSource;
  registry: TunnelRegistry;
  mailboxes?: MailboxRegistry;
  /** Test seam: where to dial a peer (default `wss://<tunnelHost>:8443/mesh`). */
  peerUrl?: (p: { relayId: string; tunnelHost: string }) => string;
  now?: () => number;
  feedPollMs?: number;
  refuseNewMs?: number;
  closeAllMs?: number;
  /** `FLAGSHIP_MESH_REBALANCE_MS`. */
  rebalanceMs?: number;
  /** `FLAGSHIP_MESH_MIN_MOVE_MS`. */
  minMoveMs?: number;
  legacyWaitMs?: number;
  legacyRenewMs?: number;
  pingMs?: number;
  downMs?: number;
  queryTimeoutMs?: number;
  /** Tunnels this relay is sized for (`load.capacity`). Default 10,000. */
  capacity?: number;
  /** How often the directory is re-read from the feed. Default 60 s. */
  directoryPollMs?: number;
  log?: (m: string) => void;
}

/** One box tunnel on this relay, as the hub describes it. */
export interface MeshBoxTunnel {
  podCanonical: string;
  boxPub: string;
  username: string;
  /** The box offered `mesh-v1` and the ACK echoed it. */
  meshNegotiated: boolean;
  /** When the accepting HELLO_ACK was sent (relay clock). */
  ackedAt: number;
  sendFrame(f: Frame): void;
}

export interface MeshBoxSession {
  /** An ATTACHMENT frame from the box. */
  onAttachment(payload: Uint8Array): void;
  /** The tunnel closed. */
  down(): void;
}

/** The SNI router's view (§7.2). */
export type MeshDecision =
  | { kind: "local" }
  | { kind: "forward"; relayId: string; name: string }
  | { kind: "query"; name: string; exclude: string[] }
  | { kind: "drop" }
  | { kind: "refuse"; code: "not-holder" | "apps-off" | "revoked" | "stale" };

interface LocalBox {
  t: MeshBoxTunnel;
  regGen: number;
  legacy: LegacyAnnouncer | null;
  attached: boolean;
  /** issuedAt of the newest item this relay announced for the box (what a withdrawal covers). */
  lastOwnIssuedAt: number;
  superseded: boolean;
  lastCoLocateAt: number;
}

type RouterEntry = (stream: Duplex, sni: string, initialBytes: Uint8Array, ctx: { entry: string; refuse: (code: string) => void }) => void;

export class MeshNode {
  readonly feed: MeshFeed;
  readonly directory: MeshDirectory;
  readonly store: AttachmentStore;
  readonly bridges: BridgeManager;
  readonly query: MeshQuery;
  readonly homes: AccountHomes;
  readonly rebalancer: Rebalancer;
  readonly phoneHost: PhoneLedgerHost;
  readonly phoneClient: MeshPhoneLedgerClient;
  serving: ServingGate | null = null;
  phoneRoutes: PhoneRoutes | null = null;
  draining = false;
  private routerEntry: RouterEntry | null = null;
  private mailboxes: MailboxRegistry | null;
  private readonly local = new Map<string, LocalBox>();
  private announceQueue: unknown[] = [];
  private withdrawQueue: WithdrawItem[] = [];
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private revocationsAdopted: RevocationState | null = null;
  private readonly reconsider = new Set<string>();
  private reconsiderScheduled = false;
  private certIndex: { sequence: number; byAccount: Map<string, Set<string>> } | null = null;
  readonly counters = { forwarded: 0, bridgedIn: 0, refusedIn: {} as Record<string, number>, hintsSent: {} as Record<string, number>, legacyAnnounced: 0, attachmentsRefused: {} as Record<string, number> };

  constructor(readonly opts: MeshNodeOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.mailboxes = opts.mailboxes ?? null;
    const self = opts.relayId;
    this.directory = new MeshDirectory({ servicesApex: opts.servicesApex, caKeys: opts.caKeys, now: this.now, log: this.log });
    this.feed = new MeshFeed({
      servicesApex: opts.servicesApex,
      logKey: opts.logKey,
      source: opts.feedSource,
      now: this.now,
      ...(opts.feedPollMs !== undefined ? { pollMs: opts.feedPollMs } : {}),
      ...(opts.refuseNewMs !== undefined ? { refuseNewMs: opts.refuseNewMs } : {}),
      ...(opts.closeAllMs !== undefined ? { closeAllMs: opts.closeAllMs } : {}),
      askPeers: (since) => {
        for (const p of this.bridges.live()) p.send({ type: "log-since", since });
      },
      onEntries: (entries, prev, next) => this.onLogEntries(entries, prev, next),
      onHead: (h) => this.gossipHead(h),
      log: this.log,
    });
    this.store = new AttachmentStore({
      selfRelayId: self,
      servicesApex: opts.servicesApex,
      ctx: () => this.checkContext(),
      onChange: (kind, name) => this.onStoreChange(kind, name),
    });
    this.homes = new AccountHomes({
      selfRelayId: self,
      ctx: () => this.checkContext(),
      winners: (account) => this.store.accountWinners(account),
      sign: (m) => opts.blessing.sign(m),
      ...(opts.minMoveMs !== undefined ? { minMoveMs: opts.minMoveMs } : {}),
    });
    this.bridges = new BridgeManager({
      selfRelayId: self,
      sign: (m) => opts.blessing.sign(m),
      blessing: () => opts.blessing.currentRelayBlessing(),
      heldBlessing: (id) => this.directory.heldBlessing(id),
      caKeys: opts.caKeys,
      checkContext: () => this.checkContext(),
      now: this.now,
      peers: () => this.directory.peers(self, this.feed.state).map((e) => ({ relayId: e.relayId, tunnelHost: e.tunnelHost })),
      ...(opts.peerUrl ? { peerUrl: opts.peerUrl } : {}),
      ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}),
      ...(opts.downMs !== undefined ? { downMs: opts.downMs } : {}),
      log: this.log,
      handler: {
        onControl: (p, m) => this.onControl(p, m),
        onOpen: (p, s) => this.onBridgedOpen(p, s),
        onUp: (p) => this.onPeerUp(p),
        onDown: (p, why) => this.onPeerDown(p, why),
      },
    });
    this.query = new MeshQuery({
      transport: { peers: () => this.bridges.live() },
      accept: (name, item, from) => this.acceptAnswer(name, item, from),
      now: this.now,
      ...(opts.queryTimeoutMs !== undefined ? { timeoutMs: opts.queryTimeoutMs } : {}),
    });
    this.rebalancer = new Rebalancer({
      selfRelayId: self,
      now: this.now,
      ...(opts.rebalanceMs !== undefined ? { intervalMs: opts.rebalanceMs } : {}),
      ...(opts.minMoveMs !== undefined ? { minMoveMs: opts.minMoveMs } : {}),
      relays: () =>
        (this.directory.current?.relays ?? []).map((r) => {
          const p = this.bridges.peer(r.relayId);
          return {
            relayId: r.relayId,
            relayKind: r.relayKind,
            lastLoadAt: p?.load?.at ?? null,
            draining: p?.load?.draining ?? false,
            tunnels: p?.load?.tunnels ?? 0,
            capacity: p?.load?.capacity ?? 0,
          };
        }),
      homeOf: (a) => this.homes.homeOf(a),
      lastMove: (a) => this.homes.lastMove(a),
      hasLegacyBox: (a) => this.store.accountWinners(a).some((w) => w.kind === "legacy"),
      move: (a, to) => this.moveAccount(a, to),
    });
    this.phoneHost = new PhoneLedgerHost({
      selfRelayId: self,
      servicesApex: opts.servicesApex,
      sign: (m) => opts.blessing.sign(m),
      now: this.now,
      maxSeenGeneration: (h) => this.store.maxPhoneGeneration(h),
      onVacant: (hostname, generation) => {
        this.bridges.broadcast({ type: "phone-vacant", hostname, generation });
        this.phoneRoutes?.pushed(hostname, generation, true);
      },
      // §8.2 (security review 2026-11-02, M3): only full, unrevoked relays of the directory may ask, and only for
      // accounts whose top k this relay is in (a lone relay with no directory is its own ledger).
      peerMayAsk: (id) => {
        const r = directoryRelay(this.directory.current, id);
        return !!r && r.relayKind === "full" && !this.feed.state.revokedRelays.has(id);
      },
      servesAccount: (account) => this.directory.current === null || isPhoneLedgerFor(account, self, this.directory.current, this.feed.state),
    });
    this.phoneClient = new MeshPhoneLedgerClient({
      selfRelayId: self,
      ledgerFor: (hostname) => this.ledgerFor(hostname),
      announce: (item) => {
        if (this.store.offerPhone(item, self)) this.queueAnnounce(item);
      },
      withdraw: (hostname, upTo) => this.withdrawOwn("phone", hostname, upTo),
    });
  }

  get selfRelayId(): string {
    return this.opts.relayId;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  attach(httpServer: HttpServer): () => void {
    return this.bridges.attach(httpServer);
  }

  start(): void {
    this.feed.start();
    void this.pollDirectory();
    this.bridges.start();
    this.rebalancer.start();
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.opts.directoryPollMs ?? 60_000, () => void this.pollDirectory());
    every(MESH_LOAD_INTERVAL_MS, () => this.sendLoad());
    every(5_000, () => {
      this.store.sweep();
      this.homes.sweep();
      this.phoneHost.sweep();
    });
    // Phone tunnels follow the strict rule (§4.6): closed once contact has been lost past the close-all deadline.
    every(1_000, () => this.phoneContactTick());
  }

  async stop(): Promise<void> {
    this.feed.stop();
    this.rebalancer.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.announceTimer) clearTimeout(this.announceTimer);
    for (const b of this.local.values()) b.legacy?.stop();
    await this.bridges.stop();
  }

  setPhoneRoutes(r: PhoneRoutes | null): void {
    this.phoneRoutes = r;
  }

  private phonesClosedForLoss = false;

  /** @internal (the 1 s timer; tests call it) */
  phoneContactTick(): void {
    const c = this.feed.contact();
    if (c === "ok") this.phonesClosedForLoss = false;
    else if (c === "lost" && !this.phonesClosedForLoss) {
      this.phonesClosedForLoss = true;
      this.phoneRoutes?.closeAll(1013, "serving-feed-lost");
    }
  }

  /** The relay's peer-backup mailboxes (bridged pb-mail streams are served from its local ones). */
  setMailboxes(m: MailboxRegistry | null): void {
    this.mailboxes = m;
  }

  setRouterEntry(fn: RouterEntry): void {
    this.routerEntry = fn;
  }

  async pollDirectory(): Promise<void> {
    const f = await this.opts.feedSource.directory();
    if (f !== null && this.directory.offerFile(f)) this.onDirectoryChanged();
  }

  checkContext(): MeshCheckContext {
    return { servicesApex: this.opts.servicesApex, log: this.feed.state, directory: this.directory.current, now: this.now() };
  }

  fresh(): boolean {
    return this.feed.fresh();
  }

  // ── readiness, stats ───────────────────────────────────────────────────

  /** §2: `/api/health` answers 503 unless the relay is mesh-ready. */
  readiness(): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const b = this.opts.blessing.currentRelayBlessing();
    if (!b) reasons.push("no-blessing");
    const me = this.directory.entry(this.opts.relayId);
    if (!me || me.relayKey !== this.opts.blessing.relayKeyHex()) reasons.push("not-in-directory");
    if (this.feed.state.revokedRelays.has(this.opts.relayId)) reasons.push("revoked");
    if (this.directory.unhealthy()) reasons.push("directory-expired");
    if (!this.fresh()) reasons.push("stale");
    if (this.draining) reasons.push("draining");
    const others = this.directory.peers(this.opts.relayId, this.feed.state).length;
    const live = this.bridges.live().length;
    if (others > 0 && live * 2 < others) reasons.push("bridges");
    return { ready: reasons.length === 0, reasons };
  }

  stats(): Record<string, unknown> {
    const r = this.readiness();
    return {
      relayId: this.opts.relayId,
      kind: this.opts.relayKind,
      ready: r.ready,
      reasons: r.reasons,
      draining: this.draining,
      feed: this.feed.stats(),
      directory: this.directory.stats(),
      store: this.store.stats(),
      peers: this.bridges.live().map((p) => p.stats()),
      handshakeFailures: { ...this.bridges.handshakeFailures },
      query: { ...this.query.stats },
      homes: this.homes.stats(),
      rebalance: { moves: this.rebalancer.moves, decisions: { ...this.rebalancer.decisions } },
      phoneLedger: { entries: this.phoneHost.size(), ops: this.phoneHost.ops },
      localBoxes: this.local.size,
      counters: this.counters,
    };
  }

  // ── HELLO lookups from the log (§4.1: no `.com` per-name lookups) ───────

  helloLookups() {
    const state = () => this.feed.state;
    const authority = (u: string) => {
      try {
        return state().authorities.get(accountHash(u.toLowerCase())) ?? null;
      } catch {
        return null;
      }
    };
    return {
      /** The registered STK for the pod name; a key the name no longer has is passed through so the eviction gate answers "replaced". */
      authLookup: (serverId: string, presented?: Uint8Array): Uint8Array | null => {
        const s = state();
        const reg = relayLogBox(s, serverId.toLowerCase());
        if (!reg || (s.revokedBoxes.get(reg.boxPub) ?? 0) >= reg.regGen) return null;
        if (presented && toHex(presented) !== reg.boxPub) return presented;
        return fromHex(reg.boxPub);
      },
      irkLookup: (u: string): Uint8Array | null => {
        const a = authority(u);
        return a ? fromHex(a.irkPub) : null;
      },
      authorityLookup: (u: string) => {
        const a = authority(u);
        return a ? { irkPub: fromHex(a.irkPub), adminRootPub: a.adminRootPub ? fromHex(a.adminRootPub) : null } : null;
      },
      revocationLookup: async (u: string): Promise<Set<string> | null> => {
        let h: string;
        try {
          h = accountHash(u.toLowerCase());
        } catch {
          return new Set();
        }
        return new Set(this.certsRevoked().get(h) ?? []);
      },
      /** Every key but the name's newest registration is evicted (the log's `box-register` is the eviction chain). */
      evictionLookup: async (pod: string): Promise<Set<string> | null> => {
        const reg = relayLogBox(state(), pod.toLowerCase());
        return reg ? new AllBut(reg.boxPub) : null;
      },
    };
  }

  private certsRevoked(): Map<string, Set<string>> {
    const s = this.feed.state;
    if (this.certIndex?.sequence === s.sequence) return this.certIndex.byAccount;
    const byAccount = new Map<string, Set<string>>();
    for (const k of s.revokedCerts) {
      const [h, id] = k.split("|") as [string, string];
      let set = byAccount.get(h);
      if (!set) byAccount.set(h, (set = new Set()));
      set.add(id);
    }
    this.certIndex = { sequence: s.sequence, byAccount };
    return byAccount;
  }

  // ── the hub's hooks (§9.1, §5) ──────────────────────────────────────────

  /** HELLO_ACK mesh fields for a box that offered `mesh-v1`; null without a valid blessing (no mesh-v1 then). */
  ackFields(): { relayId: string; relayBlessing: unknown } | null {
    const b = this.opts.blessing.currentRelayBlessing();
    return b ? { relayId: this.opts.relayId, relayBlessing: b } : null;
  }

  /** A box tunnel registered here. */
  boxUp(t: MeshBoxTunnel): MeshBoxSession {
    const pod = t.podCanonical.toLowerCase();
    const reg = relayLogBox(this.feed.state, pod);
    const box: LocalBox = { t, regGen: reg?.regGen ?? 0, legacy: null, attached: false, lastOwnIssuedAt: 0, superseded: false, lastCoLocateAt: 0 };
    this.local.set(pod, box);
    if (this.opts.relayKind === "full" && reg && reg.boxPub === t.boxPub) {
      box.legacy = new LegacyAnnouncer(
        {
          selfRelayId: this.opts.relayId,
          sign: (m) => this.opts.blessing.sign(m),
          now: this.now,
          ...(this.opts.legacyWaitMs !== undefined ? { waitMs: this.opts.legacyWaitMs } : {}),
          ...(this.opts.legacyRenewMs !== undefined ? { renewMs: this.opts.legacyRenewMs } : {}),
        },
        { serverFqdn: pod, boxPub: t.boxPub, regGen: reg.regGen, attachedAt: t.ackedAt },
        (item) => {
          if (box.attached || box.superseded) return;
          const r = this.store.offerAttachment(item, this.opts.relayId);
          if (r.ok) {
            this.counters.legacyAnnounced++;
            box.lastOwnIssuedAt = Math.max(box.lastOwnIssuedAt, item.attachment.issuedAt);
            this.queueAnnounce(item);
          }
        },
      );
      box.legacy.start(t.meshNegotiated);
    }
    return {
      onAttachment: (payload) => this.onBoxAttachment(box, payload),
      down: () => {
        box.legacy?.stop();
        if (this.local.get(pod) === box) this.local.delete(pod);
        if (box.lastOwnIssuedAt > 0) this.withdrawOwn("box", pod, box.lastOwnIssuedAt);
      },
    };
  }

  private onBoxAttachment(box: LocalBox, payload: Uint8Array): void {
    const p = parseAttachmentFrame(payload);
    const reply = (r: { ok: true } | { ok: false; code: "clock" | "mismatch" | "not-registered" | "revoked" }) => box.t.sendFrame(attachmentResultFrame(r));
    if (!p) return reply({ ok: false, code: "mismatch" });
    const item: AttachmentItem = { kind: "box", attachment: p.attachment as unknown as BoxAttachment, signature: p.signature };
    const pod = box.t.podCanonical.toLowerCase();
    const r = this.store.offerAttachment(item, this.opts.relayId, { relayId: this.opts.relayId, boxPub: box.t.boxPub, serverFqdn: pod });
    if (!r.ok) {
      this.counters.attachmentsRefused[r.reason] = (this.counters.attachmentsRefused[r.reason] ?? 0) + 1;
      return reply({ ok: false, code: r.reason === "withdrawn" ? "mismatch" : attachmentRefusalCode(r.reason) });
    }
    box.attached = true;
    box.superseded = false;
    box.legacy?.stop();
    box.lastOwnIssuedAt = Math.max(box.lastOwnIssuedAt, item.attachment.issuedAt);
    this.queueAnnounce(item);
    reply({ ok: true });
    const account = accountOfPodName(pod, this.opts.servicesApex);
    if (account) this.scheduleReconsider(account);
  }

  /** Sign and send a move hint to one of this relay's mesh boxes (§9.3). False when it cannot be sent. */
  sendHint(pod: string, reason: MoveHintReason, to: string): boolean {
    const box = this.local.get(pod);
    if (!box || !box.t.meshNegotiated || to === this.opts.relayId) return false;
    const target = this.directory.heldBlessing(to);
    if (!target || target.relayKind !== "full") return false;
    const now = this.now();
    const hint: MoveHint = { serverFqdn: pod, boxPub: box.t.boxPub, fromRelayId: this.opts.relayId, toRelayId: to, reason, issuedAt: now, notAfter: now + MOVE_HINT_TTL_MS };
    let signature: string;
    try {
      signature = signRelayMeshRecord("relay-move-hint", hint, (m) => this.opts.blessing.sign(m));
    } catch {
      return false;
    }
    box.t.sendFrame(moveHintFrame({ hint: hint as unknown as Record<string, unknown>, signature, target: target as unknown as Record<string, unknown> }));
    this.counters.hintsSent[reason] = (this.counters.hintsSent[reason] ?? 0) + 1;
    return true;
  }

  // ── routing (§7.2) ─────────────────────────────────────────────────────

  /** Where a visitor for `sni` goes. `bridged`: it came over a bridge (never forwarded again). */
  decide(sni: string, bridged: boolean): MeshDecision {
    const name = sni.toLowerCase();
    const apex = this.opts.servicesApex;
    if (!name.endsWith(`.${apex}`) || name.includes("*")) return { kind: "local" };
    const labels = name.slice(0, -(apex.length + 1)).split(".");
    const self = this.opts.relayId;
    if (!this.fresh()) return this.decideStale(name, labels, bridged);
    if (labels.length === 1) {
      if (!isBarePhoneName(name, apex)) return bridged ? { kind: "refuse", code: "not-holder" } : { kind: "drop" };
      if (this.phoneRoutes?.tunnelFor(name)) return { kind: "local" };
      if (bridged) return { kind: "refuse", code: "not-holder" };
      const w = this.store.phoneWinner(name);
      if (w && w.grant.holderRelayId !== self && this.bridges.peer(w.grant.holderRelayId)) return this.forwardTo(w.grant.holderRelayId, name);
      return { kind: "drop" };
    }
    const key = labels.length === 2 ? name : `${labels.slice(-2).join(".")}.${apex}`;
    const boxScoped = labels.length >= 3 || relayLogBox(this.feed.state, key) !== null || this.store.winner(key) !== null;
    if (boxScoped) {
      if (!isPodName(key, apex)) return bridged ? { kind: "refuse", code: "not-holder" } : { kind: "drop" };
      const reg = relayLogBox(this.feed.state, key);
      if (reg && (this.feed.state.revokedBoxes.get(reg.boxPub) ?? 0) >= reg.regGen) return bridged ? { kind: "refuse", code: "revoked" } : { kind: "drop" };
      const w = this.store.winner(key);
      if (w?.attachment.relayId === self) return { kind: "local" };
      if (!w) {
        if (this.local.has(key)) return { kind: "local" };
        if (bridged) return { kind: "refuse", code: "not-holder" };
        return reg ? { kind: "query", name: key, exclude: [] } : { kind: "drop" };
      }
      if (bridged) return { kind: "refuse", code: "not-holder" };
      if (!this.bridges.peer(w.attachment.relayId)) return { kind: "query", name: key, exclude: [w.attachment.relayId] };
      return this.forwardTo(w.attachment.relayId, key);
    }
    const account = labels[1]!;
    const home = this.homes.homeOf(account);
    if (home === self) return { kind: "local" };
    if (home === null) {
      if (this.opts.registry.hasOnlineTunnelsForUser(account)) return { kind: "local" };
      return bridged ? { kind: "refuse", code: "not-holder" } : { kind: "drop" };
    }
    if (bridged) return { kind: "refuse", code: "not-holder" };
    if (!this.bridges.peer(home)) return { kind: "drop" };
    return this.forwardTo(home, name);
  }

  private forwardTo(relayId: string, name: string): MeshDecision {
    if (this.feed.state.revokedRelays.has(relayId) || !this.directory.entry(relayId)) return { kind: "drop" };
    return { kind: "forward", relayId, name };
  }

  /**
   * §4.6 as amended, for a relay that is not fresh: only boxes whose owner chose no time limit are served. The holder
   * serves a bridged stream only to a local box the gate finds exempt (else `stale`). The entry forwards only a
   * box-scoped name registered and unrevoked in its last applied state (it cannot read a policy's grace, only its hash,
   * so the holder's check decides); account-level and bare names (phones follow the strict rule) are dropped.
   */
  private decideStale(name: string, labels: string[], bridged: boolean): MeshDecision {
    const apex = this.opts.servicesApex;
    if (labels.length < 2 || !this.feed.hasAppliedState()) return bridged ? { kind: "refuse", code: "stale" } : { kind: "drop" };
    const key = labels.length === 2 ? name : `${labels.slice(-2).join(".")}.${apex}`;
    const reg = relayLogBox(this.feed.state, key);
    if (!reg || (this.feed.state.revokedBoxes.get(reg.boxPub) ?? 0) >= reg.regGen) return bridged ? { kind: "refuse", code: "stale" } : { kind: "drop" };
    const local = this.local.get(key);
    if (local && local.t.boxPub === reg.boxPub && this.serving?.exemptBox(reg.boxPub)) {
      const w = this.store.winner(key);
      if (!w || w.attachment.relayId === this.opts.relayId) return { kind: "local" };
    }
    if (bridged) return { kind: "refuse", code: "stale" };
    const w = this.store.winner(key);
    if (!w || w.attachment.relayId === this.opts.relayId || !this.bridges.peer(w.attachment.relayId)) return { kind: "drop" };
    return this.forwardTo(w.attachment.relayId, key);
  }

  /** Query the peers for a name; resolves with the relay now holding the winner, or null. */
  async ask(name: string, exclude: string[]): Promise<string | null> {
    const r = await this.query.ask(name, new Set(exclude));
    return r && r !== this.opts.relayId && this.bridges.peer(r) ? r : null;
  }

  /** Open a bridged stream for a visitor (entry duties). */
  openTo(relayId: string, sni: string): BridgeStream | null {
    const p = this.bridges.peer(relayId);
    const s = p?.open(sni, "tls") ?? null;
    if (s) this.counters.forwarded++;
    return s;
  }

  /** The holder answered `not-holder` for `name`: drop what pointed there. */
  notHolder(name: string, relayId: string): void {
    const w = this.store.winner(name);
    if (w && w.attachment.relayId === relayId) this.store.dropItem(w);
    const ph = this.store.phoneWinner(name);
    if (ph && ph.grant.holderRelayId === relayId) this.store.dropPhone(ph);
  }

  /** Count a visitor stream's bytes toward rebalancing (the home counts by entry relay; phones are not counted). */
  traffic(podCanonical: string, sni: string, entry: string): ((bytes: number) => void) | null {
    const apex = this.opts.servicesApex;
    if (isBarePhoneName(sni.toLowerCase(), apex)) return null;
    const account = accountOfPodName(podCanonical.toLowerCase(), apex);
    if (!account) return null;
    this.rebalancer.countStream(account, entry);
    return (n) => this.rebalancer.countBytes(account, entry, n);
  }

  // ── bridges ────────────────────────────────────────────────────────────

  private onPeerUp(p: BridgePeer): void {
    this.log(`[mesh] bridge up: ${p.relayId} (${p.role})`);
    this.directory.offerBlessing(p.blessing);
    const head = this.feed.head;
    p.send({ type: "sync", directoryVersion: this.directory.version(), head, features: [], load: this.loadBody() });
    const items = this.store.dump();
    for (let i = 0; i < items.length; i += MESH_ANNOUNCE_BATCH_MAX) p.send({ type: "announce", items: items.slice(i, i + MESH_ANNOUNCE_BATCH_MAX) });
    for (const m of this.homes.liveMoves()) p.send({ type: "account-move", ...m });
    p.send({ type: "sync-done" });
  }

  private onPeerDown(p: BridgePeer, why: string): void {
    this.log(`[mesh] bridge down: ${p.relayId} (${why})`);
    // Its mailboxes are unreachable now; the next relay that announced one holds it (§7.6).
    this.store.dropMailboxesOf(p.relayId);

  }

  private onControl(p: BridgePeer, m: Record<string, unknown>): void {
    switch (m.type) {
      case "sync": {
        if (m.head) this.feed.offerHead(m.head, p.relayId);
        const theirSeq = Number((m.head as SignedRelayLogHead | null)?.head?.sequence ?? 0);
        p.lastLogSent = Number.isSafeInteger(theirSeq) ? theirSeq : 0;
        if (typeof m.directoryVersion === "number" && m.directoryVersion < this.directory.version()) {
          p.send({ type: "directory", directory: this.directory.current, blessings: this.directory.blessingList() });
        }
        this.pushLog(p);
        this.noteLoad(p, m.load);
        return;
      }
      case "sync-done":
        return;
      case "announce":
        for (const it of Array.isArray(m.items) ? m.items.slice(0, MESH_ANNOUNCE_BATCH_MAX) : []) this.acceptItem(it, p);
        return;
      case "withdraw":
        for (const w of Array.isArray(m.items) ? m.items.slice(0, MESH_ANNOUNCE_BATCH_MAX) : []) {
          if (!this.store.withdraw(w as WithdrawItem, p.relayId)) p.rejected++;
        }
        return;
      case "query":
        return this.query.onQuery(p, m, (name) => this.lookup(name));
      case "answer":
        return this.query.onAnswer(p, m);
      case "head":
        this.feed.offerHead({ head: m.head, signature: m.signature }, p.relayId);
        return;
      case "log":
        this.feed.offerEntries(m.entries, p.relayId);
        return;
      case "log-since": {
        const since = typeof m.since === "number" && Number.isSafeInteger(m.since) ? m.since : 0;
        p.send({ type: "log", entries: this.feed.entriesSince(since) });
        return;
      }
      case "directory":
        if (this.directory.offerFile({ directory: m.directory, blessings: m.blessings })) this.onDirectoryChanged();
        return;
      case "blessing":
        this.opts.blessing.adopt(m.blessing);
        return;
      case "load":
        this.noteLoad(p, m);
        return;
      case "account-move": {
        const mv = m.move as { accountHash?: string } | undefined;
        const account = typeof mv?.accountHash === "string" ? this.accountByHash(mv.accountHash) : null;
        const r = this.homes.offer({ move: m.move, signature: m.signature }, account, p.relayId);
        if (!r.ok) p.rejected++;
        else if (account) this.scheduleReconsider(account);
        return;
      }
      case "phone-begin":
      case "phone-claim":
      case "phone-renew":
      case "phone-release":
        return answerLedgerRequest(this.phoneHost, p, m);
      case "phone-begun":
      case "phone-claimed":
        return this.phoneClient.onReply(m);
      case "mailbox-withdraw":
        if (Array.isArray(m.ids) && m.ids.length <= MESH_ANNOUNCE_BATCH_MAX) this.store.withdrawMailboxes(m.ids.filter((x): x is string => typeof x === "string"), p.relayId);
        else p.rejected++;
        return;
      case "phone-vacant":
        if (typeof m.hostname === "string" && typeof m.generation === "number") this.phoneRoutes?.pushed(m.hostname, m.generation, true);
        return;
      default:
        return;
    }
  }

  /** An item from a peer's announcement (or a query answer, `announcer` = its holder). */
  private acceptItem(it: unknown, p: BridgePeer | null, announcer?: string): boolean {
    const o = it as { kind?: unknown } | null;
    const from = p?.relayId ?? announcer ?? "?";
    let ok = false;
    if (o?.kind === "box" || o?.kind === "legacy") {
      ok = this.store.offerAttachment(o as AttachmentItem, from).ok;
      if (ok) this.query.clearMiss((o as AttachmentItem).attachment.serverFqdn);
    } else if (o?.kind === "phone") {
      const item = o as PhoneItem;
      ok = this.store.offerPhone(item, announcer ?? from);
      if (ok) {
        this.query.clearMiss(item.grant.hostname);
        if (item.grant.holderRelayId !== this.opts.relayId) this.phoneRoutes?.pushed(item.grant.hostname, item.grant.generation, false);
      }
    } else if (o?.kind === "mailbox") {
      const mb = o as MailboxItem;
      ok = !!p && mb.relayId === p.relayId && this.store.offerMailbox(mb, from);
    }
    if (!ok && p) p.rejected++;
    return ok;
  }

  /** A query answer item: kept when valid; true when it is now the winner for the name. */
  private acceptAnswer(name: string, item: unknown, from: string): boolean {
    const o = item as { kind?: unknown; grant?: { holderRelayId?: unknown } } | null;
    const announcer = o?.kind === "phone" && typeof o.grant?.holderRelayId === "string" ? o.grant.holderRelayId : from;
    if (!this.acceptItem(item, null, announcer)) {
      const peer = this.bridges.peer(from);
      if (peer) peer.rejected++;
      return false;
    }
    if (o?.kind === "phone") return this.store.phoneWinner(name)?.signature === (item as PhoneItem).signature;
    const w = this.store.winner(name);
    return !!w && w.signature === (item as AttachmentItem).signature;
  }

  /** What this relay answers a `query` with: the winner it holds for the name (a pod name or a bare name). */
  private lookup(name: string): unknown[] {
    if (isBarePhoneName(name, this.opts.servicesApex)) {
      const w = this.store.phoneWinner(name);
      return w ? [w] : [];
    }
    const w = this.store.winner(name);
    return w ? [w] : [];
  }

  private noteLoad(p: BridgePeer, l: unknown): void {
    const o = l as { tunnels?: unknown; capacity?: unknown; draining?: unknown } | null;
    if (!o || typeof o.tunnels !== "number" || typeof o.capacity !== "number") return;
    p.load = { tunnels: o.tunnels, capacity: o.capacity, draining: o.draining === true, at: this.now() };
  }

  private loadBody(): { tunnels: number; capacity: number; draining: boolean } {
    return { tunnels: this.opts.registry.size(), capacity: this.opts.capacity ?? 10_000, draining: this.draining };
  }

  private sendLoad(): void {
    this.bridges.broadcast({ type: "load", ...this.loadBody() });
  }

  /** A stream a peer opened to this relay (holder duties, §7.4). */
  private onBridgedOpen(p: BridgePeer, s: BridgeStream): void {
    this.counters.bridgedIn++;
    const refuse = (code: string) => {
      this.counters.refusedIn[code] = (this.counters.refusedIn[code] ?? 0) + 1;
      p.refuse(s, code as "not-holder");
    };
    if (s.kind === "pb-mail") return void this.serveMailStream(p, s, refuse);
    if (!this.routerEntry) return refuse("not-holder");
    // The entry sends the peeked ClientHello as the first DATA; route once it is here, by the SNI the visitor sent
    // (§6.4: a peer's OPEN label alone never picks the tunnel).
    s.once("data", (first: Buffer) => {
      s.pause();
      if (s.kind === "tls" && !bridgedSniMatches(s.sni, first)) return refuse("not-holder");
      this.routerEntry!(s, s.sni, new Uint8Array(first.buffer, first.byteOffset, first.byteLength), { entry: p.relayId, refuse });
    });
  }

  // ── peer-backup mailboxes over a bridge (§7.6) ──────────────────────────

  /** Announce mailboxes a local tunnel proved (called by the mailbox registry). */
  announceMailboxes(list: MailboxAnnouncement[]): void {
    for (const a of list) this.queueAnnounce({ kind: "mailbox", announce: { pikPubHex: a.pikPubHex, epoch: a.epoch }, signature: a.sigHex, relayId: this.opts.relayId });
  }

  /** Local tunnels stopped holding these mailboxes: tell every peer, so another relay's holder can take them (§7.6). */
  withdrawMailboxes(ids: string[]): void {
    for (let i = 0; i < ids.length; i += MESH_ANNOUNCE_BATCH_MAX) this.bridges.broadcast({ type: "mailbox-withdraw", ids: ids.slice(i, i + MESH_ANNOUNCE_BATCH_MAX) });
  }

  /** Deliver to a mailbox held by a peer: `OPEN kind:"pb-mail"`, the envelope, then the reply (status u32 BE + body). */
  async deliverRemote(id: string, envelope: Uint8Array): Promise<{ status: number; body: Uint8Array } | null> {
    const relayId = this.store.mailboxRelay(id);
    const peer = relayId && relayId !== this.opts.relayId ? this.bridges.peer(relayId) : null;
    const s = peer?.open(id, "pb-mail", { length: envelope.byteLength }) ?? null;
    if (!s) return null;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const timer = setTimeout(() => s.destroy(), 120_000);
      s.on("data", (c: Buffer) => {
        total += c.byteLength;
        if (total > (1 << 20) + 4) return s.destroy();
        chunks.push(c);
      });
      s.on("close", () => {
        clearTimeout(timer);
        const all = Buffer.concat(chunks);
        if (s.refused || all.byteLength < 4) return resolve(s.refused ? null : { status: 502, body: new Uint8Array(0) });
        resolve({ status: all.readUInt32BE(0), body: new Uint8Array(all.subarray(4)) });
      });
      s.on("error", () => undefined);
      s.write(Buffer.from(envelope));
    });
  }

  private async serveMailStream(p: BridgePeer, s: BridgeStream, refuse: (code: string) => void): Promise<void> {
    const extra = (s as BridgeStream & { openExtra?: { length?: unknown } }).openExtra;
    const length = typeof extra?.length === "number" && Number.isSafeInteger(extra.length) && extra.length > 0 && extra.length <= 1 << 20 ? extra.length : 0;
    const mb = this.mailboxes;
    if (!length || !mb || !mb.hasLocal(s.sni)) return refuse("not-holder");
    const chunks: Buffer[] = [];
    let got = 0;
    await new Promise<void>((resolve) => {
      const onData = (c: Buffer) => {
        chunks.push(c);
        got += c.byteLength;
        if (got >= length) {
          s.off("data", onData);
          resolve();
        }
      };
      s.on("data", onData);
      s.once("close", () => resolve());
    });
    if (got < length) return;
    const r = await mb.deliverLocal(s.sni, new Uint8Array(Buffer.concat(chunks).subarray(0, length)));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(r?.status ?? 404);
    s.end(Buffer.concat([head, Buffer.from(r?.body ?? new Uint8Array(0))]));
    void p;
  }

  // ── announcements and withdrawals (§5.5) ────────────────────────────────

  private queueAnnounce(item: unknown): void {
    this.announceQueue.push(item);
    this.scheduleFlush();
  }

  private withdrawOwn(kind: "box" | "phone", subject: string, upTo: number): void {
    const w = { subjectKind: kind, subject, relayId: this.opts.relayId, withdrawnIssuedAt: upTo, at: this.now() };
    let signature: string;
    try {
      signature = signRelayMeshRecord("relay-withdraw", w, (m) => this.opts.blessing.sign(m));
    } catch {
      return;
    }
    const item = { withdraw: w, signature };
    this.store.withdraw(item, this.opts.relayId);
    this.withdrawQueue.push(item);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => this.flushAnnouncements(), MESH_ANNOUNCE_DELAY_MS);
    this.announceTimer.unref?.();
  }

  /** Send queued announcements and withdrawals now (the 1 s batch; tests call it). */
  flushAnnouncements(): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    const items = this.announceQueue;
    const wds = this.withdrawQueue;
    this.announceQueue = [];
    this.withdrawQueue = [];
    for (let i = 0; i < items.length; i += MESH_ANNOUNCE_BATCH_MAX) this.bridges.broadcast({ type: "announce", items: items.slice(i, i + MESH_ANNOUNCE_BATCH_MAX) });
    for (let i = 0; i < wds.length; i += MESH_ANNOUNCE_BATCH_MAX) this.bridges.broadcast({ type: "withdraw", items: wds.slice(i, i + MESH_ANNOUNCE_BATCH_MAX) });
  }

  // ── the log and directory ───────────────────────────────────────────────

  private onLogEntries(entries: SignedRelayLogEntry[], _prev: RelayLogState, next: RelayLogState): void {
    this.store.onLogEntries(entries);
    const gate = this.serving;
    if (gate) {
      const rev: RevocationState = { sequence: next.sequence, ...relayLogRevocations(next) } as RevocationState;
      if (this.revocationsAdopted?.boxes !== rev.boxes || this.revocationsAdopted?.renewalKeys !== rev.renewalKeys) {
        gate.adoptRevocations(rev);
        this.revocationsAdopted = rev;
      }
      gate.noteLatestSequence(next.sequence);
    }
    let grantRevoked = false;
    for (const { entry: e } of entries) {
      if (e.kind === "policy-head") void gate?.refreshMatching((h) => h.boxPub === e.f1);
      else if (e.kind === "account-authority") void gate?.refreshAccountHash(e.f1);
      else if (e.kind === "box-register") void gate?.refreshMatching((h) => h.boxPub === e.f2 || safeNameHash(h.podCanonical) === e.f1);
      else if (e.kind === "device-grant-revoke") grantRevoked = true;
      else if (e.kind === "relay-revoke") {
        this.bridges.drop(e.f1, 4403, "revoked");
        if (e.f1 === this.opts.relayId) this.log("[mesh] this relay was retired in the log");
      }
    }
    if (grantRevoked) void this.phoneRoutes?.recheckAll();
    for (const p of this.bridges.live()) this.pushLog(p);
  }

  /** Gossip entries the peer has not been sent yet (≤ 256 per message). */
  private pushLog(p: BridgePeer): void {
    if (this.feed.state.sequence <= p.lastLogSent) return;
    const entries = this.feed.entriesSince(p.lastLogSent, MESH_LOG_PUSH_MAX);
    if (entries.length === 0) return;
    p.send({ type: "log", entries });
    p.lastLogSent = entries[entries.length - 1]!.entry.sequence;
  }

  private gossipHead(h: SignedRelayLogHead): void {
    const now = this.now();
    for (const p of this.bridges.live()) {
      if (now - p.lastHeadSentAt < FEED_HEAD_MINT_MS) continue;
      p.lastHeadSentAt = now;
      p.send({ type: "head", head: h.head, signature: h.signature });
    }
    if (this.directory.version() < h.head.directoryVersion) void this.pollDirectory();
  }

  private onDirectoryChanged(): void {
    const listed = new Set((this.directory.current?.relays ?? []).map((r) => r.relayId));
    for (const p of this.bridges.live()) if (!listed.has(p.relayId)) this.store.dropRelay(p.relayId);
    for (const p of this.bridges.live()) p.send({ type: "directory", directory: this.directory.current, blessings: this.directory.blessingList() });
    this.bridges.reconcile();
  }

  // ── homes, hints, moves ─────────────────────────────────────────────────

  private onStoreChange(kind: "box" | "phone", name: string): void {
    if (kind !== "box") return;
    const box = this.local.get(name);
    if (box && !box.superseded && box.lastOwnIssuedAt > 0) {
      const w = this.store.winner(name);
      if (w && w.attachment.relayId !== this.opts.relayId && w.attachment.boxPub === box.t.boxPub) {
        // Superseded: the box signed for another relay. This relay forwards like any entry from now on.
        box.superseded = true;
        box.legacy?.stop();
        this.withdrawOwn("box", name, box.lastOwnIssuedAt);
      }
    }
    const account = accountOfPodName(name, this.opts.servicesApex);
    if (account) this.scheduleReconsider(account);
  }

  private scheduleReconsider(account: string): void {
    this.reconsider.add(account);
    if (this.reconsiderScheduled) return;
    this.reconsiderScheduled = true;
    queueMicrotask(() => {
      this.reconsiderScheduled = false;
      const accounts = [...this.reconsider];
      this.reconsider.clear();
      for (const a of accounts) this.coLocate(a);
    });
  }

  /** §7.3: a holder that is not its account's home hints each mesh box of the account there (`co-locate`). */
  private coLocate(account: string): void {
    const home = this.homes.homeOf(account);
    if (!home || home === this.opts.relayId) return;
    const now = this.now();
    for (const [pod, box] of this.local) {
      if (accountOfPodName(pod, this.opts.servicesApex) !== account || !box.t.meshNegotiated || box.superseded) continue;
      if (!this.store.ownWins(pod)) continue;
      if (box.lastCoLocateAt && now - box.lastCoLocateAt < (this.opts.minMoveMs ?? MOVE_COLOCATE_MIN_MS)) continue;
      if (this.sendHint(pod, "co-locate", home)) box.lastCoLocateAt = now;
    }
  }

  /** §10.3: move the account to `to` (the rebalancer decided): sign, announce, hint each box 2 s apart. */
  moveAccount(account: string, to: string): void {
    const m = this.homes.mint(account, to);
    this.bridges.broadcast({ type: "account-move", ...m });
    const pods = [...this.local.keys()].filter((p) => accountOfPodName(p, this.opts.servicesApex) === account);
    pods.forEach((pod, i) => {
      const t = setTimeout(() => this.sendHint(pod, "locality", to), i * ACCOUNT_MOVE_HINT_SPACING_MS);
      t.unref?.();
    });
  }

  /** §10.4: draining. Mark it (health 503, `load.draining`), and hint every mesh box away over half the grace. */
  beginDrain(graceMs: number): void {
    if (this.draining) return;
    this.draining = true;
    this.sendLoad();
    const pods = [...this.local.keys()];
    const spread = pods.length > 1 ? Math.floor(graceMs / 2 / pods.length) : 0;
    pods.forEach((pod, i) => {
      const t = setTimeout(() => {
        const to = this.bestOtherRelay();
        if (to) this.sendHint(pod, "retire", to);
      }, i * spread);
      t.unref?.();
    });
  }

  /** The best other `full` relay to send a box to: live bridge, not draining, same region first, lowest load. */
  bestOtherRelay(): string | null {
    const me = this.directory.entry(this.opts.relayId);
    const cands = (this.directory.current?.relays ?? [])
      .filter((r) => r.relayId !== this.opts.relayId && r.relayKind === "full" && !this.feed.state.revokedRelays.has(r.relayId))
      .map((r) => ({ r, p: this.bridges.peer(r.relayId) }))
      .filter((c) => c.p && !c.p.load?.draining && this.directory.heldBlessing(c.r.relayId));
    cands.sort((a, b) => {
      const ra = a.r.region === me?.region ? 0 : 1;
      const rb = b.r.region === me?.region ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const la = a.p!.load ? a.p!.load.tunnels / Math.max(1, a.p!.load.capacity) : 0;
      const lb = b.p!.load ? b.p!.load.tunnels / Math.max(1, b.p!.load.capacity) : 0;
      if (la !== lb) return la - lb;
      return a.r.relayId < b.r.relayId ? -1 : 1;
    });
    return cands[0]?.r.relayId ?? null;
  }

  // ── the phone ledger (§8.1) ─────────────────────────────────────────────

  /** L for the account of a bare hostname: the first relay of the ranking this relay can reach. */
  ledgerFor(hostname: string): LedgerTarget {
    const account = hostname.split(".")[0] ?? "";
    let ranking: string[];
    try {
      ranking = phoneLedgerRanking(account, this.directory.current, this.feed.state);
    } catch {
      return null;
    }
    for (const id of ranking.slice(0, PHONE_LEDGER_TOP_K)) {
      if (id === this.opts.relayId) return { local: this.phoneHost };
      const p = this.bridges.peer(id);
      if (p) return { peer: p };
    }
    // A relay alone (no directory yet, or a one-relay mesh not listed): it is its own ledger.
    return ranking.length === 0 && this.opts.relayKind === "full" ? { local: this.phoneHost } : null;
  }

  private accountByHash(h: string): string | null {
    for (const pod of [...this.local.keys()]) {
      const a = accountOfPodName(pod, this.opts.servicesApex);
      if (a && accountHash(a) === h) return a;
    }
    for (const a of this.store.accounts()) if (accountHash(a) === h) return a;
    return null;
  }
}

/** A set that holds every key but one (the eviction lookup: all but the newest registration are retired). */
class AllBut extends Set<string> {
  constructor(private readonly keep: string) {
    super();
  }
  override has(k: string): boolean {
    return k.toLowerCase() !== this.keep;
  }
}

function safeNameHash(fqdn: string): string | null {
  try {
    return relayLogNameHash(fqdn.toLowerCase());
  } catch {
    return null;
  }
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function fromHex(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h, "hex"));
}
