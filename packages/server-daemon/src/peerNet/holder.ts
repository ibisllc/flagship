/**
 * The holder: keeps other owners' bricks and `.com` filler in this server's
 * pool (docs/peer-backup.md §5, §6, §8). It never learns whose bricks they
 * are: an owner is an anonymous lease key that paid with blind tokens.
 */
import {
  blindPrepare,
  canonicalPbOp,
  canonicalPbPikBind,
  decodePbMailPlaintext,
  ed,
  encodePbMailPlaintext,
  openPbMailRequest,
  pbFillerAnswer,
  pbMailboxEpoch,
  pbMailboxId,

  pbMerklePath,
  pbTokenMessage,
  pbXPublicKey,
  rsaPssVerify,
  sealPbMailResponse,
  type PbNetwork,
  type PbSpend,
} from "@flagship/protocol";
import { nodeAead, merkleLevels } from "./fastCrypto.js";
import { PB_OPS, fromHex, hex, sha256Hex, type PbOpHeader } from "./mailOps.js";
import type { PbBlobStore, PbComClient, PbNetworkInfo, PbStateFile } from "./types.js";

export const HOLDER_TOMBSTONE_MS = 14 * 24 * 60 * 60_000;
export const HOLDER_EXPIRY_GRACE_MS = 7 * 24 * 60 * 60_000;
export const HOLDER_LEAVE_MS = 14 * 24 * 60 * 60_000;
const OP_FRESH_MS = 10 * 60_000;
const MAX_PROVE_LEAVES = 8;

interface LeaseRec {
  lkPubHex: string;
  slots: number;
  expiresAt: number;
  openedAt: number;
  closedAt: number | null;
  bricks: Record<string, { deletedAt: number | null }>;
}

export interface HolderState {
  v: 1;
  pikSeedHex: string;
  xSecretHex: string;
  fillerHeld: number;
  leases: Record<string, LeaseRec>;
  /** SHA-256 of serials spent here, with when (kept 180 days). */
  spent: Record<string, number>;
  pendingRedeem: Array<{ dueAt: number; spends: PbSpend[] }>;
  leavingSince: number | null;
  lastCheckinAt: number | null;
  reliability: number | null;
  provenSlots: number | null;
  lastError: string | null;
}

export interface HolderOptions {
  serverId: string;
  com: PbComClient;
  state: PbStateFile<HolderState>;
  blobs: PbBlobStore;
  /** The pool this server reserves for peers (2/3 of its disk, minus headroom). */
  poolBytes: () => number;
  now?: () => number;
  random?: () => number;
  /** Upper bound of the random wait before a lease's tokens are redeemed. Default 6 h. */
  redeemJitterMs?: number;
  /** Filler bricks fetched per tick. Default 32. */
  fillerPerTick?: number;
  log?: (m: string) => void;
}

export interface HolderStatus {
  pikPubHex: string;
  poolBytes: number;
  realBytes: number;
  fillerBytes: number;
  provenBytes: number;
  reliability: number | null;
  leases: number;
  bricks: number;
  leaving: boolean;
  lastCheckinAt: number | null;
  lastError: string | null;
}

function brickBlob(leaseId: string, brickId: string): string {
  return `b-${leaseId}-${brickId}`;
}
function fillerBlob(i: number): string {
  return `f-${i}`;
}

export class HolderEngine {
  private st: HolderState | null = null;
  private info: PbNetworkInfo | null = null;
  private infoAt = 0;
  private readonly seen = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: HolderOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Serialise state changes: mail and ticks never interleave mid-update. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async state(): Promise<HolderState> {
    if (this.st) return this.st;
    const loaded = await this.o.state.load();
    if (loaded && loaded.v === 1) {
      this.st = loaded;
    } else {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const x = crypto.getRandomValues(new Uint8Array(32));
      this.st = {
        v: 1,
        pikSeedHex: hex(seed),
        xSecretHex: hex(x),
        fillerHeld: 0,
        leases: {},
        spent: {},
        pendingRedeem: [],
        leavingSince: null,
        lastCheckinAt: null,
        reliability: null,
        provenSlots: null,
        lastError: null,
      };
      await this.save();
    }
    return this.st;
  }

  private async save(): Promise<void> {
    if (this.st) await this.o.state.save(this.st);
  }

  async pikPubHex(): Promise<string> {
    return hex(ed.getPublicKey(fromHex((await this.state()).pikSeedHex)));
  }

  async xPubHex(): Promise<string> {
    return hex(pbXPublicKey(fromHex((await this.state()).xSecretHex)));
  }

  private async network(): Promise<PbNetworkInfo> {
    if (!this.info || this.now() - this.infoAt > 24 * 60 * 60_000) {
      this.info = await this.o.com.network();
      this.infoAt = this.now();
    }
    return this.info;
  }

  private reservedBricks(st: HolderState, net: PbNetwork, except?: string): number {
    let n = 0;
    for (const [id, l] of Object.entries(st.leases)) {
      if (id === except) continue;
      n += l.slots * net.slotBricks;
    }
    return n;
  }

  private async dropFillerTo(target: number): Promise<void> {
    const st = await this.state();
    while (st.fillerHeld > Math.max(0, target)) {
      st.fillerHeld -= 1;
      await this.o.blobs.delete(fillerBlob(st.fillerHeld));
    }
  }

  private async deleteLease(leaseId: string): Promise<void> {
    const st = await this.state();
    const l = st.leases[leaseId];
    if (!l) return;
    for (const b of Object.keys(l.bricks)) await this.o.blobs.delete(brickBlob(leaseId, b));
    delete st.leases[leaseId];
  }

  // ────────────────────────────────────────────────────────────────────
  // Mail
  // ────────────────────────────────────────────────────────────────────

  /** Whether `mailboxId` is one of this holder's (previous, current or next epoch). */
  async ownsMailbox(mailboxId: string): Promise<boolean> {
    const pik = await this.pikPubHex();
    const e = pbMailboxEpoch(this.now());
    return [e - 1, e, e + 1].some((x) => x >= 0 && pbMailboxId(pik, x) === mailboxId);
  }

  /** Answer one sealed request. Throws (→ 400 at the relay) when it isn't sealed to us. */
  handleMail(mailboxId: string, envelope: Uint8Array): Promise<Uint8Array> {
    return this.locked(async () => {
      if (!(await this.ownsMailbox(mailboxId))) throw new Error("not this holder's mailbox");
      const st = await this.state();
      const { plaintext, keys } = openPbMailRequest(fromHex(st.xSecretHex), mailboxId, envelope, nodeAead);
      const reply = (header: Record<string, unknown>, body: Uint8Array = new Uint8Array(0)) =>
        sealPbMailResponse(keys, mailboxId, encodePbMailPlaintext({ header, body }), undefined, nodeAead);
      let msg;
      try {
        msg = decodePbMailPlaintext(plaintext);
      } catch {
        return reply({ ok: false, error: "malformed request" });
      }
      try {
        const r = await this.dispatch(mailboxId, msg.header as unknown as PbOpHeader, msg.body);
        return reply({ ok: true, ...r.header }, r.body);
      } catch (e) {
        return reply({ ok: false, error: (e as Error).message });
      }
    });
  }

  private async dispatch(
    mailboxId: string,
    h: PbOpHeader,
    body: Uint8Array,
  ): Promise<{ header: Record<string, unknown>; body?: Uint8Array }> {
    if (typeof h?.op !== "string" || !PB_OPS.has(h.op)) throw new Error("unknown operation");
    if (typeof h.issuedAt !== "number" || Math.abs(this.now() - h.issuedAt) > OP_FRESH_MS) throw new Error("stale request");
    if (typeof h.nonceHex !== "string" || !/^[0-9a-f]{32}$/.test(h.nonceHex)) throw new Error("malformed nonce");
    if (typeof h.argsJson !== "string" || typeof h.sigHex !== "string" || typeof h.leaseId !== "string") throw new Error("malformed request");
    const now = this.now();
    for (const [k, t] of this.seen) if (now - t > 2 * OP_FRESH_MS) this.seen.delete(k);
    if (this.seen.has(h.nonceHex)) throw new Error("replayed request");

    const st = await this.state();
    const net = (await this.network()).network;
    let lkPubHex: string;
    let lease: LeaseRec | undefined;
    if (h.op === "lease.open") {
      if (typeof h.lkPubHex !== "string" || !/^[0-9a-f]{64}$/.test(h.lkPubHex)) throw new Error("a new lease names its key");
      lkPubHex = h.lkPubHex;
    } else {
      lease = st.leases[h.leaseId];
      if (!lease) throw new Error("no such lease");
      lkPubHex = lease.lkPubHex;
    }
    let good = false;
    try {
      good = ed.verify(
        fromHex(h.sigHex),
        canonicalPbOp({ op: h.op, mailboxId, leaseId: h.leaseId, issuedAt: h.issuedAt, nonceHex: h.nonceHex, argsJson: h.argsJson, bodySha256Hex: sha256Hex(body) }),
        fromHex(lkPubHex),
      );
    } catch {
      good = false;
    }
    if (!good) throw new Error("invalid signature");
    this.seen.set(h.nonceHex, now);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(h.argsJson) as Record<string, unknown>;
    } catch {
      throw new Error("malformed args");
    }
    if (typeof args !== "object" || args === null) throw new Error("malformed args");

    switch (h.op) {
      case "lease.open":
        return this.opOpen(lkPubHex, args, net);
      case "lease.renew":
        return this.opRenew(h.leaseId, lease!, args, net);
      case "lease.close":
        lease!.closedAt = lease!.closedAt ?? now;
        await this.save();
        return { header: {} };
      case "lease.status": {
        const live = Object.values(lease!.bricks).filter((b) => b.deletedAt === null).length;
        return { header: { expiresAt: lease!.expiresAt, slots: lease!.slots, bricks: live, closed: lease!.closedAt !== null } };
      }
      case "brick.put":
        return this.opPut(h.leaseId, lease!, args, body, net);
      case "brick.get":
      case "brick.prove":
        return this.opRead(h.op, h.leaseId, lease!, args, net);
      case "brick.delete": {
        const ids = args.brickIds;
        if (!Array.isArray(ids) || ids.length > 4096) throw new Error("malformed brickIds");
        for (const id of ids) {
          const b = typeof id === "string" ? lease!.bricks[id] : undefined;
          if (b && b.deletedAt === null) b.deletedAt = now;
        }
        await this.save();
        return { header: {} };
      }
    }
    throw new Error("unknown operation");
  }

  private async checkTokens(args: Record<string, unknown>, count: number): Promise<PbSpend[]> {
    const tokens = args.tokens;
    if (!Array.isArray(tokens) || tokens.length !== count) throw new Error(`pay with ${count} tokens`);
    const st = await this.state();
    const { tokenKey } = await this.network();
    const out: PbSpend[] = [];
    const seenHere = new Set<string>();
    for (const t of tokens as Array<Record<string, unknown>>) {
      if (
        typeof t?.serialHex !== "string" || !/^[0-9a-f]{64}$/.test(t.serialHex) ||
        typeof t.prefixHex !== "string" || !/^[0-9a-f]{64}$/.test(t.prefixHex) ||
        typeof t.sigHex !== "string" || !/^[0-9a-f]+$/.test(t.sigHex)
      ) {
        throw new Error("malformed token");
      }
      const h = sha256Hex(fromHex(t.serialHex));
      if (st.spent[h] !== undefined || seenHere.has(h)) throw new Error("a token was already spent");
      if (!rsaPssVerify(tokenKey, blindPrepare(pbTokenMessage(t.serialHex), fromHex(t.prefixHex)), fromHex(t.sigHex))) {
        throw new Error("a token isn't valid");
      }
      seenHere.add(h);
      out.push({ leaseId: "", serialHex: t.serialHex, prefixHex: t.prefixHex, sigHex: t.sigHex });
    }
    return out;
  }

  private queueRedeem(leaseId: string, spends: PbSpend[]): void {
    const st = this.st!;
    const now = this.now();
    for (const s of spends) st.spent[sha256Hex(fromHex(s.serialHex))] = now;
    const jitter = Math.floor((this.o.random ?? Math.random)() * (this.o.redeemJitterMs ?? 6 * 60 * 60_000));
    st.pendingRedeem.push({ dueAt: now + jitter, spends: spends.map((s) => ({ ...s, leaseId })) });
  }

  private async opOpen(lkPubHex: string, args: Record<string, unknown>, net: PbNetwork) {
    const st = await this.state();
    if (st.leavingSince !== null) throw new Error("this holder is leaving");
    const slots = args.slots;
    if (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 || slots > 4096) throw new Error("malformed slots");
    const spends = await this.checkTokens(args, slots);
    const poolBricks = Math.floor(this.o.poolBytes() / net.brickBytes);
    const reserved = this.reservedBricks(st, net);
    const need = slots * net.slotBricks;
    if (reserved + need > poolBricks) throw new Error("full");
    await this.dropFillerTo(poolBricks - reserved - need);
    const leaseId = hex(crypto.getRandomValues(new Uint8Array(16)));
    const now = this.now();
    st.leases[leaseId] = { lkPubHex, slots, expiresAt: now + net.leaseMs, openedAt: now, closedAt: null, bricks: {} };
    this.queueRedeem(leaseId, spends);
    await this.save();
    return { header: { leaseId, expiresAt: now + net.leaseMs } };
  }

  private async opRenew(leaseId: string, lease: LeaseRec, args: Record<string, unknown>, net: PbNetwork) {
    if (lease.closedAt !== null) throw new Error("that lease is closed");
    const spends = await this.checkTokens(args, lease.slots);
    lease.expiresAt = this.now() + net.leaseMs;
    this.queueRedeem(leaseId, spends);
    await this.save();
    return { header: { expiresAt: lease.expiresAt } };
  }

  private async opPut(leaseId: string, lease: LeaseRec, args: Record<string, unknown>, body: Uint8Array, net: PbNetwork) {
    const now = this.now();
    if (lease.closedAt !== null || lease.expiresAt < now) throw new Error("that lease is closed");
    const id = args.brickId;
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new Error("malformed brickId");
    if (body.length !== net.brickBytes) throw new Error("a brick has the wrong size");
    if (args.sha256 !== sha256Hex(body)) throw new Error("the brick arrived damaged");
    const live = Object.entries(lease.bricks).filter(([k, b]) => b.deletedAt === null && k !== id).length;
    if (live >= lease.slots * net.slotBricks) throw new Error("the lease is full");
    await this.o.blobs.put(brickBlob(leaseId, id), body);
    lease.bricks[id] = { deletedAt: null };
    await this.save();
    return { header: {} };
  }

  private async opRead(op: "brick.get" | "brick.prove", leaseId: string, lease: LeaseRec, args: Record<string, unknown>, net: PbNetwork) {
    const id = args.brickId;
    if (typeof id !== "string" || !lease.bricks[id]) throw new Error("no such brick");
    const bytes = await this.o.blobs.get(brickBlob(leaseId, id));
    if (!bytes) throw new Error("no such brick");
    if (op === "brick.get") return { header: {}, body: bytes };
    const leaves = args.leaves;
    const count = net.brickBytes / net.leafBytes;
    if (
      !Array.isArray(leaves) || leaves.length === 0 || leaves.length > MAX_PROVE_LEAVES ||
      leaves.some((i) => typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= count)
    ) {
      throw new Error("malformed leaves");
    }
    const levels = merkleLevels(bytes, net.leafBytes);
    const out = new Uint8Array(leaves.length * net.leafBytes);
    const paths: string[][] = [];
    (leaves as number[]).forEach((i, j) => {
      out.set(bytes.subarray(i * net.leafBytes, (i + 1) * net.leafBytes), j * net.leafBytes);
      paths.push(pbMerklePath(levels, i).map(hex));
    });
    return { header: { paths }, body: out };
  }

  // ────────────────────────────────────────────────────────────────────
  // Upkeep (every few minutes)
  // ────────────────────────────────────────────────────────────────────

  /** Start leaving: no new leases; owners get HOLDER_LEAVE_MS to move away. */
  leave(): Promise<void> {
    return this.locked(async () => {
      const st = await this.state();
      if (st.leavingSince === null) {
        st.leavingSince = this.now();
        await this.save();
      }
    });
  }

  /** Undo a leave that hasn't finished (the owner turned Peer back on). */
  rejoin(): Promise<void> {
    return this.locked(async () => {
      const st = await this.state();
      if (st.leavingSince !== null) {
        st.leavingSince = null;
        await this.save();
      }
    });
  }

  /** True once a leave has run its course and the pool is empty. */
  async left(): Promise<boolean> {
    const st = await this.state();
    return st.leavingSince !== null && st.fillerHeld === 0 && Object.keys(st.leases).length === 0;
  }

  /**
   * Check in, answer `.com`'s filler challenge, top the filler up, redeem
   * due tokens, and drop what has expired. Network calls run outside the
   * lock, so mail keeps flowing while filler downloads.
   */
  async tick(): Promise<void> {
    const st = await this.state();
    const now = this.now();
    try {
      const net = (await this.network()).network;
      const target = () => Math.floor(this.o.poolBytes() / net.brickBytes) - this.reservedBricks(st, net);
      await this.locked(async () => {
        await this.collectGarbage(now);
        if (st.leavingSince !== null && now - st.leavingSince >= HOLDER_LEAVE_MS) {
          for (const id of Object.keys(st.leases)) await this.deleteLease(id);
          await this.dropFillerTo(0);
        }
        await this.save();
      });
      const pik = await this.pikPubHex();
      const xPub = await this.xPubHex();
      const reply = await this.o.com.checkin({
        pikPubHex: pik,
        xPubHex: xPub,
        poolBytes: st.leavingSince !== null ? 0 : this.o.poolBytes(),
        fillerHeld: st.fillerHeld,
        leaving: st.leavingSince !== null,
        pikBindSigHex: hex(ed.sign(canonicalPbPikBind(this.o.serverId, pik, xPub), fromHex(st.pikSeedHex))),
      });
      st.lastCheckinAt = now;
      st.reliability = reply.reliability;
      st.provenSlots = reply.provenSlots;
      if (reply.challenge) await this.answer(reply.challenge);
      await this.locked(async () => {
        if (reply.fillerNext < st.fillerHeld) await this.dropFillerTo(reply.fillerNext);
        if (st.leavingSince === null && st.fillerHeld > target()) await this.dropFillerTo(target());
        await this.save();
      });
      if (st.leavingSince === null) {
        let budget = Math.min(reply.fillerWanted, this.o.fillerPerTick ?? 32);
        while (st.fillerHeld < target() && budget-- > 0) {
          const index = st.fillerHeld;
          const bytes = await this.o.com.fetchFiller(index);
          if (bytes.length !== net.brickBytes) throw new Error("filler of the wrong size");
          await this.locked(async () => {
            // A lease may have taken the room meanwhile; .com hears the lower count next time.
            if (st.fillerHeld !== index || index >= target()) return;
            await this.o.blobs.put(fillerBlob(index), bytes);
            st.fillerHeld = index + 1;
            await this.save();
          });
          if (st.fillerHeld !== index + 1) break;
        }
      }
      await this.redeemDue(now);
      st.lastError = null;
    } catch (e) {
      st.lastError = (e as Error).message;
      this.o.log?.(`holder tick: ${st.lastError}`);
    }
    await this.locked(() => this.save());
  }

  private async answer(c: { id: string; index: number; leaf: number; nonceHex: string; leafBytes: number }): Promise<void> {
    const st = await this.state();
    if (c.index >= st.fillerHeld) return;
    const leaf = await this.o.blobs.range(fillerBlob(c.index), c.leaf * c.leafBytes, c.leafBytes);
    if (!leaf) return;
    await this.o.com.proof(c.id, pbFillerAnswer(fromHex(c.nonceHex), leaf));
  }

  private async redeemDue(now: number): Promise<void> {
    const st = await this.state();
    const due = st.pendingRedeem.filter((p) => p.dueAt <= now);
    if (due.length === 0) return;
    const spends = due.flatMap((p) => p.spends);
    const results = await this.o.com.redeem(await this.pikPubHex(), spends);
    await this.locked(async () => {
      st.pendingRedeem = st.pendingRedeem.filter((p) => !due.includes(p));
      const bad = new Set(results.filter((r) => !r.ok).map((r) => r.serialHex));
      for (const s of spends) {
        if (bad.has(s.serialHex) && st.leases[s.leaseId]) {
          this.o.log?.(`lease ${s.leaseId.slice(0, 8)} paid with a token spent elsewhere; dropped`);
          await this.deleteLease(s.leaseId);
        }
      }
      await this.save();
    });
  }

  private async collectGarbage(now: number): Promise<void> {
    const st = await this.state();
    for (const [id, l] of Object.entries(st.leases)) {
      if (now - l.expiresAt > HOLDER_EXPIRY_GRACE_MS || (l.closedAt !== null && now - l.closedAt > HOLDER_TOMBSTONE_MS)) {
        await this.deleteLease(id);
        continue;
      }
      for (const [b, rec] of Object.entries(l.bricks)) {
        if (rec.deletedAt !== null && now - rec.deletedAt > HOLDER_TOMBSTONE_MS) {
          await this.o.blobs.delete(brickBlob(id, b));
          delete l.bricks[b];
        }
      }
    }
    for (const [h, at] of Object.entries(st.spent)) if (now - at > 180 * 24 * 60 * 60_000) delete st.spent[h];
  }

  async status(): Promise<HolderStatus> {
    const st = await this.state();
    const B = this.info?.network.brickBytes ?? 0;
    let bricks = 0;
    for (const l of Object.values(st.leases)) bricks += Object.values(l.bricks).filter((b) => b.deletedAt === null).length;
    return {
      pikPubHex: await this.pikPubHex(),
      poolBytes: st.leavingSince !== null ? 0 : this.o.poolBytes(),
      realBytes: bricks * B,
      fillerBytes: st.fillerHeld * B,
      provenBytes: (st.provenSlots ?? 0) * (this.info ? this.info.network.slotBricks * B : 0),
      reliability: st.reliability,
      leases: Object.keys(st.leases).length,
      bricks,
      leaving: st.leavingSince !== null,
      lastCheckinAt: st.lastCheckinAt,
      lastError: st.lastError,
    };
  }
}
