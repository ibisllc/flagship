/**
 * The attachment store (relay-mesh.md §5): every box, legacy and phone item this relay heard of, from its own
 * tunnels, its peers' announcements and query answers, with the §5.2 / §8.4 precedence, withdrawals (§5.4), the caps
 * (§5.5) and the purges the log forces (a box revoked or re-registered, a relay retired). Replication is full; a
 * query only repairs gaps. Every item is checked by `@flagship/protocol` before it is kept.
 */
import {
  accountOfPodName,
  checkAttachmentItem,
  checkPhoneItem,
  checkWithdraw,
  compareAttachments,
  comparePhoneItems,
  MESH_STORE_MAX_BOX_ITEMS,
  MESH_STORE_MAX_PER_RELAY,
  MESH_STORE_MAX_PHONE_ITEMS,
  PHONE_GENERATION_MEMORY_MS,
  nameHash,
  withdrawCovers,
  type AttachmentCheck,
  type AttachmentHolder,
  type AttachmentItem,
  type MeshCheckContext,
  type PhoneItem,
  type RelayWithdraw,
  type SignedRelayLogEntry,
} from "@flagship/protocol";
import type { MailboxAnnouncement } from "@flagship/tunnel-protocol";
import { verifyMailboxAnnouncements } from "../mailboxRelay.js";

export interface StoredAttachment {
  item: AttachmentItem;
  receivedAt: number;
}

export interface StoredPhone {
  item: PhoneItem;
  /** The relay that announced it (its holder). */
  announcer: string;
}

/** `{kind:"mailbox", announce, signature}` (§7.6): a PIK-signed mailbox announcement and the relay holding it. */
export interface MailboxItem {
  kind: "mailbox";
  announce: { pikPubHex: string; epoch: number };
  signature: string;
  relayId: string;
}

export type WithdrawItem = { withdraw: RelayWithdraw; signature: string };

export interface AttachmentStoreOptions {
  selfRelayId: string;
  servicesApex: string;
  ctx: () => MeshCheckContext;
  maxBoxItems?: number;
  maxPerRelay?: number;
  maxPhoneItems?: number;
  /** An item for this name changed (added, withdrawn, purged). */
  onChange?: (kind: "box" | "phone", name: string) => void;
}

export interface AttachmentStoreStats {
  boxItems: number;
  phoneItems: number;
  mailboxes: number;
  tombstones: number;
  rejected: Record<string, number>;
}

const itemKey = (relayId: string, kind: string): string => `${relayId}|${kind}`;
/** Relays remembered per mailbox id: the holder and its successors (§7.6). */
export const MAILBOX_HOLDERS_MAX = 4;

export class AttachmentStore {
  /** serverFqdn → `<relayId>|<kind>` → the newest item of that relay and kind. */
  private readonly boxes = new Map<string, Map<string, StoredAttachment>>();
  /** account → its pod names held here. */
  private readonly byAccount = new Map<string, Set<string>>();
  private readonly perRelay = new Map<string, number>();
  private boxCount = 0;
  /** hostname → holderRelayId → item. */
  private readonly phones = new Map<string, Map<string, StoredPhone>>();
  private phoneCount = 0;
  /**
   * hostname → signing ledger relay → the highest generation seen in its phone items and until when the newest lives
   * (a new ledger relay starts above it, §8.2). Kept per ledger so a retired relay's generations go with it; forgotten
   * `PHONE_GENERATION_MEMORY_MS` after the last item lapsed.
   */
  private readonly phoneGenerations = new Map<string, Map<string, { generation: number; until: number }>>();
  /** `<kind>|<subject>|<relayId>` → the latest withdrawn issuedAt: an older item from that relay arriving late is ignored. */
  private readonly tombstones = new Map<string, { upTo: number; at: number }>();
  /**
   * mailboxId → the relays that announced it, in order, at most `MAILBOX_HOLDERS_MAX` (§7.6: the announcement does not
   * name the relay). The first is the holder; the next takes over only when it withdraws, its bridge goes or it is
   * retired (security review 2026-11-02: never a takeover by a later announcement).
   */
  private readonly mailboxes = new Map<string, Array<MailboxItem & { epoch: number }>>();
  /** Items already verified (kind, signature): a duplicate from another peer costs no verify. */
  private readonly seen = new Set<string>();
  private readonly rejected: Record<string, number> = {};

  constructor(private readonly opts: AttachmentStoreOptions) {}

  get selfRelayId(): string {
    return this.opts.selfRelayId;
  }

  // ── box and legacy attachments ─────────────────────────────────────────

  /**
   * Keep a box or legacy item when it is valid (§5.1, §5.3) and not covered by a withdrawal. `holder`: the holder's
   * own extra checks (this tunnel's box and itself).
   */
  offerAttachment(item: AttachmentItem, from: string, holder?: AttachmentHolder): AttachmentCheck | { ok: false; reason: "withdrawn" } {
    const a = item?.attachment;
    const dupKey = `${item?.kind}|${item?.signature}`;
    if (this.seen.has(dupKey) && !holder) {
      const cur = this.boxes.get(a?.serverFqdn)?.get(itemKey(a.relayId, item.kind));
      if (cur && cur.item.signature === item.signature) return { ok: true };
    }
    const c = checkAttachmentItem(item, this.opts.ctx(), holder);
    if (!c.ok) {
      this.count(from, c.reason);
      return c;
    }
    const tomb = this.tombstones.get(`box|${a.serverFqdn}|${a.relayId}`);
    if (tomb && a.issuedAt <= tomb.upTo) return { ok: false, reason: "withdrawn" };
    this.remember(dupKey);
    let per = this.boxes.get(a.serverFqdn);
    if (!per) {
      per = new Map();
      this.boxes.set(a.serverFqdn, per);
      const account = accountOfPodName(a.serverFqdn, this.opts.servicesApex);
      if (account) {
        let s = this.byAccount.get(account);
        if (!s) this.byAccount.set(account, (s = new Set()));
        s.add(a.serverFqdn);
      }
    }
    const k = itemKey(a.relayId, item.kind);
    const had = per.get(k);
    if (had && had.item.attachment.issuedAt >= a.issuedAt && had.item.attachment.regGen >= a.regGen) return { ok: true };
    if (!had) {
      this.boxCount++;
      this.perRelay.set(a.relayId, (this.perRelay.get(a.relayId) ?? 0) + 1);
    }
    per.set(k, { item, receivedAt: this.opts.ctx().now });
    this.enforceBoxCaps(a.relayId);
    this.opts.onChange?.("box", a.serverFqdn);
    return { ok: true };
  }

  /** The winning live attachment for a pod name, or null (§5.2). Excludes relays in `exclude`. */
  winner(serverFqdn: string, exclude?: ReadonlySet<string>): AttachmentItem | null {
    const per = this.boxes.get(serverFqdn);
    if (!per) return null;
    const now = this.opts.ctx().now;
    let best: AttachmentItem | null = null;
    for (const s of per.values()) {
      const a = s.item.attachment;
      if (a.notAfter <= now || exclude?.has(a.relayId)) continue;
      if (!best || compareAttachments(s.item, best) > 0) best = s.item;
    }
    return best;
  }

  /** This relay's own live item for the name (box-signed first). */
  own(serverFqdn: string): AttachmentItem | null {
    const per = this.boxes.get(serverFqdn);
    const now = this.opts.ctx().now;
    const box = per?.get(itemKey(this.opts.selfRelayId, "box"))?.item;
    if (box && box.attachment.notAfter > now) return box;
    const legacy = per?.get(itemKey(this.opts.selfRelayId, "legacy"))?.item;
    return legacy && legacy.attachment.notAfter > now ? legacy : null;
  }

  /** Is this relay's own attachment the winner for the name? */
  ownWins(serverFqdn: string): boolean {
    const w = this.winner(serverFqdn);
    return !!w && w.attachment.relayId === this.opts.selfRelayId;
  }

  /** Drop one item (a holder answered `not-holder` for it). */
  dropItem(item: AttachmentItem): void {
    const a = item.attachment;
    const per = this.boxes.get(a.serverFqdn);
    const k = itemKey(a.relayId, item.kind);
    const had = per?.get(k);
    if (!per || !had || had.item.signature !== item.signature) return;
    this.deleteBox(a.serverFqdn, per, k);
    this.opts.onChange?.("box", a.serverFqdn);
  }

  /** The winning attachment of every box of the account (live, one per pod name). */
  accountWinners(account: string): AttachmentItem[] {
    const out: AttachmentItem[] = [];
    for (const fqdn of this.byAccount.get(account) ?? []) {
      const w = this.winner(fqdn);
      if (w) out.push(w);
    }
    return out;
  }

  /** Accounts with at least one pod name in the store. */
  accounts(): IterableIterator<string> {
    return this.byAccount.keys();
  }

  /** Every live item announced as this relay's (to re-announce, or to count tunnels). */
  ownItems(): AttachmentItem[] {
    const out: AttachmentItem[] = [];
    for (const fqdn of this.boxes.keys()) {
      const o = this.own(fqdn);
      if (o) out.push(o);
    }
    return out;
  }

  // ── withdrawals (§5.4) ──────────────────────────────────────────────────

  /** A checked withdrawal removes that relay's item for the subject issued no later, and blocks older late copies. */
  withdraw(w: WithdrawItem, from: string): boolean {
    const c = checkWithdraw(w?.withdraw, w?.signature, this.opts.ctx());
    if (!c.ok) {
      this.count(from, `withdraw-${c.reason}`);
      return false;
    }
    const wd = w.withdraw;
    const tk = `${wd.subjectKind}|${wd.subject}|${wd.relayId}`;
    const t = this.tombstones.get(tk);
    if (!t || t.upTo < wd.withdrawnIssuedAt) this.tombstones.set(tk, { upTo: wd.withdrawnIssuedAt, at: this.opts.ctx().now });
    if (wd.subjectKind === "box") {
      const per = this.boxes.get(wd.subject);
      if (per) {
        for (const [k, s] of [...per]) if (withdrawCovers(wd, s.item)) this.deleteBox(wd.subject, per, k);
      }
      this.opts.onChange?.("box", wd.subject);
    } else {
      const per = this.phones.get(wd.subject);
      if (per) {
        for (const [k, s] of [...per]) {
          if (withdrawCovers(wd, s.item)) {
            per.delete(k);
            this.phoneCount--;
          }
        }
        if (per.size === 0) this.phones.delete(wd.subject);
      }
      this.opts.onChange?.("phone", wd.subject);
    }
    return true;
  }

  // ── phone items (§8.3, §8.4) ────────────────────────────────────────────

  offerPhone(item: PhoneItem, announcer: string): boolean {
    const ctx = this.opts.ctx();
    const host = typeof item?.grant?.hostname === "string" ? item.grant.hostname : "";
    let highestLive = 0;
    for (const s of this.phones.get(host)?.values() ?? []) if (s.item.grant.notAfter > ctx.now) highestLive = Math.max(highestLive, s.item.grant.generation);
    const c = checkPhoneItem(item, announcer, ctx, highestLive);
    if (!c.ok) {
      this.count(announcer, `phone-${c.reason}`);
      return false;
    }
    const g = item.grant;
    this.rememberGeneration(g);
    const tomb = this.tombstones.get(`phone|${g.hostname}|${g.holderRelayId}`);
    if (tomb && g.issuedAt <= tomb.upTo) return false;
    let per = this.phones.get(g.hostname);
    if (!per) this.phones.set(g.hostname, (per = new Map()));
    const had = per.get(g.holderRelayId);
    if (had && comparePhoneItems(had.item, item) >= 0) return true;
    if (!had) this.phoneCount++;
    per.set(g.holderRelayId, { item, announcer });
    this.enforcePhoneCap(g.holderRelayId);
    this.opts.onChange?.("phone", g.hostname);
    return true;
  }

  phoneWinner(hostname: string, exclude?: ReadonlySet<string>): PhoneItem | null {
    const per = this.phones.get(hostname);
    if (!per) return null;
    const now = this.opts.ctx().now;
    let best: PhoneItem | null = null;
    for (const s of per.values()) {
      if (s.item.grant.notAfter <= now || exclude?.has(s.item.grant.holderRelayId)) continue;
      if (!best || comparePhoneItems(s.item, best) > 0) best = s.item;
    }
    return best;
  }

  maxPhoneGeneration(hostname: string): number {
    let max = 0;
    for (const v of this.phoneGenerations.get(hostname)?.values() ?? []) max = Math.max(max, v.generation);
    return max;
  }

  private rememberGeneration(g: PhoneItem["grant"]): void {
    let per = this.phoneGenerations.get(g.hostname);
    if (!per) {
      const cap = this.opts.maxPhoneItems ?? MESH_STORE_MAX_PHONE_ITEMS;
      if (this.phoneGenerations.size >= cap) {
        let oldest: { host: string; until: number } | null = null;
        for (const [h, m] of this.phoneGenerations) {
          const until = Math.max(...[...m.values()].map((v) => v.until));
          if (!oldest || until < oldest.until) oldest = { host: h, until };
        }
        if (oldest) this.phoneGenerations.delete(oldest.host);
      }
      this.phoneGenerations.set(g.hostname, (per = new Map()));
    }
    const had = per.get(g.ledgerRelayId);
    per.set(g.ledgerRelayId, { generation: Math.max(had?.generation ?? 0, g.generation), until: Math.max(had?.until ?? 0, g.notAfter) });
  }

  dropPhone(item: PhoneItem): void {
    const per = this.phones.get(item.grant.hostname);
    const had = per?.get(item.grant.holderRelayId);
    if (!per || !had || had.item.signature !== item.signature) return;
    per.delete(item.grant.holderRelayId);
    this.phoneCount--;
    if (per.size === 0) this.phones.delete(item.grant.hostname);
  }

  // ── mailboxes (§7.6) ────────────────────────────────────────────────────

  /** A valid announcement: true (kept as holder or, behind the first, as a successor). */
  offerMailbox(item: MailboxItem, from: string): boolean {
    const a = item?.announce;
    const ann: MailboxAnnouncement = { pikPubHex: a?.pikPubHex, epoch: a?.epoch, sigHex: item?.signature };
    const ids = typeof item?.relayId === "string" ? verifyMailboxAnnouncements([ann], this.opts.ctx().now) : null;
    if (!ids || ids.length !== 1) {
      this.count(from, "mailbox");
      return false;
    }
    const id = ids[0]!;
    const it = { kind: "mailbox" as const, announce: item.announce, signature: item.signature, relayId: item.relayId, epoch: a.epoch };
    const list = this.mailboxes.get(id) ?? [];
    const at = list.findIndex((m) => m.relayId === it.relayId);
    if (at >= 0) list[at] = it;
    else if (list.length < MAILBOX_HOLDERS_MAX) list.push(it);
    this.mailboxes.set(id, list);
    return true;
  }

  /** `mailbox-withdraw` from `from`: removes `from` from these ids only (the next relay, if any, becomes the holder). */
  withdrawMailboxes(ids: readonly string[], from: string): void {
    for (const id of ids) this.removeMailboxRelay(id, from);
  }

  private removeMailboxRelay(id: string, relayId: string): void {
    const list = this.mailboxes.get(id);
    if (!list) return;
    const rest = list.filter((m) => m.relayId !== relayId);
    if (rest.length === 0) this.mailboxes.delete(id);
    else this.mailboxes.set(id, rest);
  }

  /** The relay holding a mailbox, or null. */
  mailboxRelay(id: string): string | null {
    return this.mailboxes.get(id)?.[0]?.relayId ?? null;
  }

  dropMailboxesOf(relayId: string): void {
    for (const id of [...this.mailboxes.keys()]) this.removeMailboxRelay(id, relayId);
  }

  // ── what the log and directory force ────────────────────────────────────

  /** Applied log entries: drop items they invalidate (a revoked or replaced box, a retired relay). */
  onLogEntries(entries: SignedRelayLogEntry[]): void {
    for (const { entry: e } of entries) {
      if (e.kind === "box-revoke") {
        const gen = Number(e.f2);
        this.dropWhere((it) => it.attachment.boxPub === e.f1 && it.attachment.regGen <= gen);
      } else if (e.kind === "box-register") {
        const regGen = Number(e.f3);
        this.dropWhere((it) => {
          let h: string;
          try {
            h = nameHash(it.attachment.serverFqdn);
          } catch {
            return true;
          }
          return h === e.f1 && (it.attachment.boxPub !== e.f2 || it.attachment.regGen !== regGen);
        });
      } else if (e.kind === "relay-revoke") {
        this.dropRelay(e.f1);
      }
    }
  }

  /** A relay was retired or left the directory: everything it announced goes. */
  dropRelay(relayId: string): void {
    this.dropWhere((it) => it.attachment.relayId === relayId);
    for (const [host, per] of [...this.phones]) {
      for (const [k, s] of [...per]) {
        if (s.item.grant.holderRelayId === relayId || s.item.grant.ledgerRelayId === relayId) {
          per.delete(k);
          this.phoneCount--;
        }
      }
      if (per.size === 0) this.phones.delete(host);
      this.opts.onChange?.("phone", host);
    }
    for (const [host, per] of [...this.phoneGenerations]) {
      per.delete(relayId);
      if (per.size === 0) this.phoneGenerations.delete(host);
    }
    this.dropMailboxesOf(relayId);
  }

  /** Remove expired items and old tombstones (the sweep timer). */
  sweep(): void {
    const now = this.opts.ctx().now;
    this.dropWhere((it) => it.attachment.notAfter <= now);
    for (const [host, per] of [...this.phones]) {
      for (const [k, s] of [...per]) {
        if (s.item.grant.notAfter <= now) {
          per.delete(k);
          this.phoneCount--;
        }
      }
      if (per.size === 0) this.phones.delete(host);
    }
    for (const [host, per] of [...this.phoneGenerations]) {
      for (const [k, v] of [...per]) if (v.until + PHONE_GENERATION_MEMORY_MS <= now) per.delete(k);
      if (per.size === 0) this.phoneGenerations.delete(host);
    }
    // A tombstone outlives every item it can cover (the longest TTL is 30 min).
    for (const [k, t] of this.tombstones) if (now - t.at > 60 * 60_000) this.tombstones.delete(k);
    const epoch = Math.floor(now / (7 * 24 * 60 * 60_000));
    for (const [id, list] of this.mailboxes) if (list[0]!.epoch < epoch - 1) this.mailboxes.delete(id);
    if (this.seen.size > 4 * (this.opts.maxBoxItems ?? MESH_STORE_MAX_BOX_ITEMS)) this.seen.clear();
  }

  /** Every live item, for a full dump to a peer after `sync` (§6.3). */
  dump(): Array<AttachmentItem | PhoneItem | Omit<MailboxItem, never>> {
    const now = this.opts.ctx().now;
    const out: Array<AttachmentItem | PhoneItem | MailboxItem> = [];
    for (const per of this.boxes.values()) for (const s of per.values()) if (s.item.attachment.notAfter > now) out.push(s.item);
    for (const per of this.phones.values()) for (const s of per.values()) if (s.item.grant.notAfter > now) out.push(s.item);
    for (const list of this.mailboxes.values()) for (const m of list) out.push({ kind: "mailbox", announce: m.announce, signature: m.signature, relayId: m.relayId });
    return out;
  }

  /** Live box items announced for the relay (`load.tunnels` counts them). */
  countFor(relayId: string): number {
    return this.perRelay.get(relayId) ?? 0;
  }

  stats(): AttachmentStoreStats {
    return { boxItems: this.boxCount, phoneItems: this.phoneCount, mailboxes: this.mailboxes.size, tombstones: this.tombstones.size, rejected: { ...this.rejected } };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private dropWhere(pred: (it: AttachmentItem) => boolean): void {
    for (const [fqdn, per] of [...this.boxes]) {
      let changed = false;
      for (const [k, s] of [...per]) {
        if (pred(s.item)) {
          this.deleteBox(fqdn, per, k);
          changed = true;
        }
      }
      if (changed) this.opts.onChange?.("box", fqdn);
    }
  }

  private deleteBox(fqdn: string, per: Map<string, StoredAttachment>, k: string): void {
    const s = per.get(k);
    if (!s) return;
    per.delete(k);
    this.boxCount--;
    const r = s.item.attachment.relayId;
    const n = (this.perRelay.get(r) ?? 1) - 1;
    if (n <= 0) this.perRelay.delete(r);
    else this.perRelay.set(r, n);
    if (per.size === 0) {
      this.boxes.delete(fqdn);
      const account = accountOfPodName(fqdn, this.opts.servicesApex);
      const set = account ? this.byAccount.get(account) : undefined;
      set?.delete(fqdn);
      if (account && set?.size === 0) this.byAccount.delete(account);
    }
  }

  /** §5.5: over a cap, evict the oldest `issuedAt` from another relay (never this relay's own). */
  private enforceBoxCaps(announcer: string): void {
    const maxAll = this.opts.maxBoxItems ?? MESH_STORE_MAX_BOX_ITEMS;
    const maxPer = this.opts.maxPerRelay ?? MESH_STORE_MAX_PER_RELAY;
    if ((this.perRelay.get(announcer) ?? 0) > maxPer && announcer !== this.opts.selfRelayId) this.evictOldest((r) => r === announcer);
    while (this.boxCount > maxAll) {
      if (!this.evictOldest((r) => r !== this.opts.selfRelayId)) break;
    }
  }

  private evictOldest(relayMatch: (relayId: string) => boolean): boolean {
    let oldest: { fqdn: string; k: string; at: number } | null = null;
    for (const [fqdn, per] of this.boxes) {
      for (const [k, s] of per) {
        const a = s.item.attachment;
        if (!relayMatch(a.relayId)) continue;
        if (!oldest || a.issuedAt < oldest.at) oldest = { fqdn, k, at: a.issuedAt };
      }
    }
    if (!oldest) return false;
    const per = this.boxes.get(oldest.fqdn)!;
    this.deleteBox(oldest.fqdn, per, oldest.k);
    return true;
  }

  private enforcePhoneCap(announcer: string): void {
    const max = this.opts.maxPhoneItems ?? MESH_STORE_MAX_PHONE_ITEMS;
    while (this.phoneCount > max) {
      let oldest: { host: string; k: string; at: number } | null = null;
      for (const [host, per] of this.phones) {
        for (const [k, s] of per) {
          if (s.item.grant.holderRelayId === this.opts.selfRelayId) continue;
          if (!oldest || s.item.grant.issuedAt < oldest.at) oldest = { host, k, at: s.item.grant.issuedAt };
        }
      }
      if (!oldest) return;
      const per = this.phones.get(oldest.host)!;
      per.delete(oldest.k);
      this.phoneCount--;
      if (per.size === 0) this.phones.delete(oldest.host);
      void announcer;
    }
  }

  private remember(k: string): void {
    this.seen.add(k);
  }

  private count(from: string, why: string): void {
    const k = `${from}:${why}`;
    this.rejected[k] = (this.rejected[k] ?? 0) + 1;
  }
}
