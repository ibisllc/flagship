/**
 * The owner: cuts this server's newest archive into bricks, places them on
 * holders it picks from the directory, proves they're still there, renews
 * their leases, and moves them when a holder fails (docs/peer-backup.md
 * §4, §5, §6.1, §8). Everything here is resumable: a restart picks up from
 * the saved state and the bitmap of placed bricks.
 */
import { open, readFile } from "node:fs/promises";
import {
  blindPrepare,
  derivePbBrickId,
  derivePbBrickKey,

  encodeShards,


  pbTokenMessage,
  pbVerifyLeaf,
  rsaBlind,
  rsaFinalize,
  sealPbRoot,
  type PbNetwork,
  type PbRoot,
  type PbRootMember,
  type RsaPublicKey,
} from "@flagship/protocol";
import { brickCrypt, merkleRoot } from "./fastCrypto.js";
import { PbRefused, callHolder, fromHex, hex, sha256Hex } from "./mailOps.js";
import {
  PbComError,
  PbUnreachable,
  type PbBlobStore,
  type PbComClient,
  type PbDirectory,
  type PbDirectoryEntry,
  type PbMailTransport,
  type PbStateFile,
} from "./types.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export interface ArchiveRef {
  archiveId: string;
  createdAt: number;
  bytes: number;
  sha256: string;
  dataPath: string;
  backupPath: string;
}

export interface Token {
  serialHex: string;
  prefixHex: string;
  sigHex: string;
}

export interface MemberStats {
  failStreak: number;
  placedAt: number;
  lastOkAt: number | null;
  lastContactAt: number | null;
  lastChallengeAt: number | null;
  lastFailure: string | null;
  /** First time the directory didn't list it (leaving, or gone quiet for a day). */
  unlistedSince?: number | null;
}

interface RetiredLease {
  pikPubHex: string;
  xPubHex: string;
  leaseId: string;
  leaseKeySeedHex: string;
}

export interface Gen {
  root: PbRoot;
  dataPath: string;
  /** Bitmap (hex) over positions seg * n + shard: placed on the member's current rev. */
  placedHex: string;
  members: Record<string, MemberStats>;
  /** The revision on .com, or 0 before the first deposit. */
  depositedRevision: number;
  retired: RetiredLease[];
}

export interface OwnerState {
  v: 1;
  nextGeneration: number;
  candidate: ArchiveRef | null;
  current: Gen | null;
  pending: Gen | null;
  wallet: Token[];
  lastPlacedAt: number | null;
  /** Why nothing is being placed right now, as the owner should read it. */
  waiting: string | null;
  lastError: string | null;
}

export interface OwnerOptions {
  serverId: string;
  pbk: Uint8Array;
  com: PbComClient;
  transport: PbMailTransport;
  state: PbStateFile<OwnerState>;
  /** Merkle roots and shard hashes per generation. */
  blobs: PbBlobStore;
  readPayload?: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  readText?: (path: string) => Promise<string>;
  now?: () => number;
  random?: () => number;
  /** At most one new generation this often. Default 7 days. */
  generationEveryMs?: number;
  /** Each member is challenged this often. Default 6 h. */
  challengeEveryMs?: number;
  /** A member unreachable this long is replaced. Default 72 h. */
  offlineLimitMs?: number;
  /** Failed proofs in a row before a member is replaced. Default 3. */
  failLimit?: number;
  /** Bricks in flight. Default 4. */
  concurrency?: number;
  log?: (m: string) => void;
}

async function defaultReadPayload(path: string, offset: number, length: number): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

function bitGet(hexStr: string, i: number): boolean {
  const byte = parseInt(hexStr.slice((i >> 3) * 2, (i >> 3) * 2 + 2) || "00", 16);
  return (byte & (1 << (i & 7))) !== 0;
}

function bitSet(hexStr: string, i: number, on: boolean): string {
  const at = (i >> 3) * 2;
  let byte = parseInt(hexStr.slice(at, at + 2) || "00", 16);
  byte = on ? byte | (1 << (i & 7)) : byte & ~(1 << (i & 7));
  return hexStr.slice(0, at) + byte.toString(16).padStart(2, "0") + hexStr.slice(at + 2);
}

const rootsBlob = (g: number) => `roots-${g}`;
const hashesBlob = (g: number) => `hashes-${g}`;

export class OwnerEngine {
  private st: OwnerState | null = null;
  private dir: { at: number; d: PbDirectory } | null = null;
  private tokenKey: RsaPublicKey | null = null;
  private busy = false;

  constructor(private readonly o: OwnerOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private rand(): number {
    return (this.o.random ?? Math.random)();
  }

  async state(): Promise<OwnerState> {
    if (this.st) return this.st;
    const loaded = await this.o.state.load();
    this.st =
      loaded && loaded.v === 1
        ? loaded
        : { v: 1, nextGeneration: 1, candidate: null, current: null, pending: null, wallet: [], lastPlacedAt: null, waiting: null, lastError: null };
    return this.st;
  }

  private async save(): Promise<void> {
    if (this.st) await this.o.state.save(this.st);
  }

  /** A new archive was saved; it becomes the next generation when one is due. */
  async offer(a: ArchiveRef): Promise<void> {
    const st = await this.state();
    st.candidate = a;
    await this.save();
  }

  /** Archives that must stay on disk: the one on peers, the one going there, the next one. */
  async pinned(): Promise<Set<string>> {
    const st = await this.state();
    const out = new Set<string>();
    if (st.current) out.add(st.current.root.archive.archiveId);
    if (st.pending) out.add(st.pending.root.archive.archiveId);
    if (st.candidate) out.add(st.candidate.archiveId);
    return out;
  }

  // ────────────────────────────────────────────────────────────────────
  // The step the engine runs every few minutes
  // ────────────────────────────────────────────────────────────────────

  async step(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const st = await this.state();
    try {
      await this.maybeStartGeneration();
      if (st.pending) await this.place(st.pending);
      if (st.current) {
        await this.maintain(st.current);
        if (this.missing(st.current) > 0) await this.place(st.current);
      }
      st.lastError = null;
    } catch (e) {
      st.lastError = (e as Error).message;
      this.o.log?.(`owner step: ${st.lastError}`);
    } finally {
      this.busy = false;
      await this.save();
    }
  }

  private async directory(force = false): Promise<PbDirectory> {
    if (force || !this.dir || this.now() - this.dir.at > HOUR) {
      this.dir = { at: this.now(), d: await this.o.com.directory() };
    }
    return this.dir.d;
  }

  private async key(): Promise<RsaPublicKey> {
    if (!this.tokenKey) this.tokenKey = (await this.o.com.network()).tokenKey;
    return this.tokenKey;
  }

  private async maybeStartGeneration(): Promise<void> {
    const st = await this.state();
    const c = st.candidate;
    if (!c || st.pending) return;
    if (st.current && st.current.root.archive.archiveId === c.archiveId) {
      st.candidate = null;
      return;
    }
    const every = this.o.generationEveryMs ?? 7 * DAY;
    if (st.current && (this.missing(st.current) > 0 || this.now() - st.current.root.createdAt < every)) return;
    const d = await this.directory(true);
    const net = d.network;
    const segBytes = net.k * net.brickBytes;
    const S = Math.max(1, Math.ceil(c.bytes / segBytes));
    const T = Math.max(1, Math.ceil((S * net.n * 32) / segBytes));
    const total = S + T;

    const plan = this.planStripes(d, total, new Set());
    if (typeof plan === "string") {
      st.waiting = plan;
      return;
    }
    const backupFile = await (this.o.readText ?? ((p: string) => readFile(p, "utf8")))(c.backupPath);
    const generation = st.nextGeneration;
    const root: PbRoot = {
      v: 1,
      serverId: this.o.serverId,
      generation,
      revision: 0,
      createdAt: this.now(),
      network: net,
      archive: { archiveId: c.archiveId, createdAt: c.createdAt, bytes: c.bytes, sha256: c.sha256, backupFile },
      payloadBytes: c.bytes,
      segments: S,
      indexSegments: T,
      stripes: [],
      indexShardHashes: new Array<string>(T * net.n).fill(""),
    };
    const gen: Gen = { root, dataPath: c.dataPath, placedHex: "00".repeat(Math.ceil((total * net.n) / 8)), members: {}, depositedRevision: 0, retired: [] };
    const stripes: PbRootMember[][] = [];
    const used = new Set<string>();
    for (let j = 0; j < plan.stripes; j++) {
      const stripe: PbRootMember[] = [];
      for (let i = 0; i < net.n; i++) {
        const m = await this.openMember(d, gen, plan.slots, stripe, used);
        if (!m) {
          await this.closeMembers(stripes.flat().concat(stripe));
          st.waiting = this.waitingSentence(d, net);
          return;
        }
        stripe.push(m);
        used.add(m.pikPubHex);
      }
      stripes.push(stripe);
    }
    root.stripes = stripes;
    st.nextGeneration = generation + 1;
    st.pending = gen;
    st.candidate = null;
    st.waiting = null;
    await this.o.blobs.put(rootsBlob(generation), new Uint8Array(total * net.n * 32));
    await this.o.blobs.put(hashesBlob(generation), new Uint8Array(S * net.n * 32));
    await this.save();
    this.o.log?.(`generation ${generation}: ${total} segments on ${plan.stripes} stripe(s) of ${net.n}`);
  }

  private waitingSentence(d: PbDirectory, net: PbNetwork): string {
    const usable = this.countDiverse(this.eligible(d, net), net);
    return `Peer backup starts once ${net.n} other servers can hold it. ${usable} can now.`;
  }

  private eligible(d: PbDirectory, net: PbNetwork): PbDirectoryEntry[] {
    return d.entries.filter(
      (e) =>
        e.reliability >= 30 &&
        e.accountTag !== d.self.accountTag &&
        (net.diversity !== "account+network" || !e.netTag || e.netTag !== d.self.netTag),
    );
  }

  /** How many stripes, and slots per member, the directory can carry; or why not. */
  private planStripes(d: PbDirectory, totalSegments: number, exclude: Set<string>): { stripes: number; slots: number } | string {
    const net = d.network;
    const pool = this.eligible(d, net).filter((e) => !exclude.has(e.pikPubHex));
    for (let stripes = 1; stripes <= 16; stripes++) {
      const perMember = Math.ceil(totalSegments / stripes);
      const slots = Math.ceil(perMember / net.slotBricks);
      const fits = pool.filter((e) => e.freeSlots >= slots);
      if (this.countDiverse(fits, net) >= net.n && fits.length >= net.n * stripes) return { stripes, slots };
    }
    return this.waitingSentence(d, net);
  }

  private countDiverse(entries: PbDirectoryEntry[], net: PbNetwork): number {
    const acct = new Set<string>();
    const nets = new Set<string>();
    let n = 0;
    for (const e of entries) {
      if (acct.has(e.accountTag)) continue;
      if (net.diversity === "account+network" && e.netTag && nets.has(e.netTag)) continue;
      acct.add(e.accountTag);
      if (e.netTag) nets.add(e.netTag);
      n++;
    }
    return n;
  }

  /** Draw a holder that fits beside `stripe`, pay for a lease and open it. */
  private async openMember(
    d: PbDirectory,
    gen: Gen,
    slots: number,
    stripe: ReadonlyArray<PbRootMember>,
    used: Set<string>,
    rev = 0,
  ): Promise<PbRootMember | null> {
    const net = d.network;
    const byPik = new Map(d.entries.map((e) => [e.pikPubHex, e]));
    const takenAcct = new Set(stripe.map((m) => byPik.get(m.pikPubHex)?.accountTag).filter((x): x is string => !!x));
    const takenNet = new Set(stripe.map((m) => byPik.get(m.pikPubHex)?.netTag).filter((x): x is string => !!x));
    const tried = new Set<string>();
    for (;;) {
      const pool = this.eligible(d, net).filter(
        (e) =>
          !used.has(e.pikPubHex) &&
          !tried.has(e.pikPubHex) &&
          !stripe.some((m) => m.pikPubHex === e.pikPubHex) &&
          e.freeSlots >= slots &&
          !takenAcct.has(e.accountTag) &&
          (net.diversity !== "account+network" || !e.netTag || !takenNet.has(e.netTag)),
      );
      if (pool.length === 0) return null;
      const weights = pool.map((e) => e.reliability * Math.min(e.freeSlots, slots));
      let r = this.rand() * weights.reduce((a, b) => a + b, 0);
      let pick = pool[pool.length - 1]!;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i]!;
        if (r <= 0) {
          pick = pool[i]!;
          break;
        }
      }
      tried.add(pick.pikPubHex);
      const tokens = await this.takeTokens(slots);
      const seed = crypto.getRandomValues(new Uint8Array(32));
      try {
        const reply = await callHolder(this.o.transport, pick, {
          op: "lease.open",
          leaseId: null,
          leaseKeySeed: seed,
          includeLkPub: true,
          args: { slots, tokens },
          now: this.now(),
        });
        const leaseId = reply.header.leaseId;
        const expiresAt = reply.header.expiresAt;
        if (typeof leaseId !== "string" || typeof expiresAt !== "number") throw new PbRefused("bad reply");
        gen.members[pick.pikPubHex] = { failStreak: 0, placedAt: this.now(), lastOkAt: null, lastContactAt: this.now(), lastChallengeAt: null, lastFailure: null };
        return { pikPubHex: pick.pikPubHex, xPubHex: pick.xPubHex, leaseId, leaseKeySeedHex: hex(seed), rev, expiresAt };
      } catch (e) {
        // A refused lease doesn't spend the tokens (the holder never redeemed
        // them); an unreachable one might have, so they're dropped.
        if (e instanceof PbRefused) await this.returnTokens(tokens);
        this.o.log?.(`lease at ${pick.pikPubHex.slice(0, 8)} not opened: ${(e as Error).message}`);
      }
    }
  }

  private async closeMembers(members: ReadonlyArray<PbRootMember | RetiredLease>): Promise<void> {
    for (const m of members) {
      try {
        await callHolder(this.o.transport, m, { op: "lease.close", leaseId: m.leaseId, leaseKeySeed: fromHex(m.leaseKeySeedHex), args: {}, now: this.now() });
      } catch {
        /* the lease expires on its own */
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Tokens
  // ────────────────────────────────────────────────────────────────────

  private async takeTokens(count: number): Promise<Token[]> {
    const st = await this.state();
    while (st.wallet.length < count) {
      const want = Math.min(256, count - st.wallet.length + 8);
      const pk = await this.key();
      const items = Array.from({ length: want }, () => {
        const serialHex = hex(crypto.getRandomValues(new Uint8Array(32)));
        const prefix = crypto.getRandomValues(new Uint8Array(32));
        const prepared = blindPrepare(pbTokenMessage(serialHex), prefix);
        return { serialHex, prefixHex: hex(prefix), prepared, b: rsaBlind(pk, prepared) };
      });
      let sigs: string[];
      try {
        sigs = await this.o.com.tokens(items.map((i) => hex(i.b.blindedMsg)));
      } catch (e) {
        if (e instanceof PbComError && e.status === 429) {
          st.waiting = e.message;
          if (want > count - st.wallet.length) {
            // Ask for exactly what's needed before giving up.
            const exact = count - st.wallet.length;
            if (exact < want) {
              const sub = items.slice(0, exact);
              sigs = await this.o.com.tokens(sub.map((i) => hex(i.b.blindedMsg)));
              items.length = exact;
            } else throw e;
          } else throw e;
        } else throw e;
      }
      items.forEach((it, j) => {
        const sig = rsaFinalize(pk, it.prepared, fromHex(sigs[j]!), it.b.inv);
        st.wallet.push({ serialHex: it.serialHex, prefixHex: it.prefixHex, sigHex: hex(sig) });
      });
      await this.save();
    }
    const out = st.wallet.splice(0, count);
    await this.save();
    return out;
  }

  private async returnTokens(tokens: Token[]): Promise<void> {
    const st = await this.state();
    st.wallet.unshift(...tokens);
    await this.save();
  }

  // ────────────────────────────────────────────────────────────────────
  // Placing bricks
  // ────────────────────────────────────────────────────────────────────

  private totalSegments(g: Gen): number {
    return g.root.segments + g.root.indexSegments;
  }

  private memberFor(g: Gen, seg: number, shard: number): PbRootMember {
    const stripes = g.root.stripes;
    return stripes[seg % stripes.length]![shard]!;
  }

  missing(g: Gen): number {
    const n = g.root.network.n;
    let m = 0;
    for (let p = 0; p < this.totalSegments(g) * n; p++) if (!bitGet(g.placedHex, p)) m++;
    return m;
  }

  /** The n shards of segment `seg` (data from the archive, index from the shard hashes). */
  private async segmentShards(g: Gen, seg: number): Promise<Uint8Array[]> {
    const net = g.root.network;
    const segBytes = net.k * net.brickBytes;
    let data: Uint8Array;
    if (seg < g.root.segments) {
      const read = await (this.o.readPayload ?? defaultReadPayload)(g.dataPath, seg * segBytes, Math.min(segBytes, g.root.payloadBytes - seg * segBytes));
      data = new Uint8Array(segBytes);
      data.set(read);
    } else {
      const idx = (await this.o.blobs.get(hashesBlob(g.root.generation))) ?? new Uint8Array(0);
      const from = (seg - g.root.segments) * segBytes;
      data = new Uint8Array(segBytes);
      data.set(idx.subarray(from, Math.min(idx.length, from + segBytes)));
    }
    return encodeShards(data, net.k, net.n).shards;
  }

  private async place(g: Gen): Promise<void> {
    const st = await this.state();
    const net = g.root.network;
    const roots = (await this.o.blobs.get(rootsBlob(g.root.generation))) ?? new Uint8Array(this.totalSegments(g) * net.n * 32);
    const hashes = (await this.o.blobs.get(hashesBlob(g.root.generation))) ?? new Uint8Array(g.root.segments * net.n * 32);
    const failures = new Map<string, number>();
    const concurrency = this.o.concurrency ?? 4;
    const order: number[] = [];
    for (let s = 0; s < this.totalSegments(g); s++) order.push(s);
    for (const seg of order) {
      if (seg === g.root.segments) {
        // Data done: the index (shard hashes) is final; store it before coding it.
        await this.o.blobs.put(hashesBlob(g.root.generation), hashes);
      }
      const todo: number[] = [];
      for (let i = 0; i < net.n; i++) if (!bitGet(g.placedHex, seg * net.n + i)) todo.push(i);
      if (todo.length === 0) continue;
      const shards = await this.segmentShards(g, seg);
      if (seg < g.root.segments) {
        for (let i = 0; i < net.n; i++) hashes.set(fromHex(sha256Hex(shards[i]!)), (seg * net.n + i) * 32);
      } else {
        for (let i = 0; i < net.n; i++) g.root.indexShardHashes[(seg - g.root.segments) * net.n + i] = sha256Hex(shards[i]!);
      }
      const queue = [...todo];
      const run = async () => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
          const m = this.memberFor(g, seg, i);
          if ((failures.get(m.pikPubHex) ?? 0) >= 3) continue;
          const brickId = derivePbBrickId(this.o.pbk, g.root.generation, seg, i, m.rev);
          const brick = brickCrypt(derivePbBrickKey(this.o.pbk, brickId), shards[i]!);
          try {
            await callHolder(this.o.transport, m, {
              op: "brick.put",
              leaseId: m.leaseId,
              leaseKeySeed: fromHex(m.leaseKeySeedHex),
              args: { brickId, sha256: sha256Hex(brick) },
              body: brick,
              now: this.now(),
            });
            roots.set(merkleRoot(brick, net.leafBytes), (seg * net.n + i) * 32);
            g.placedHex = bitSet(g.placedHex, seg * net.n + i, true);
            const ms = g.members[m.pikPubHex];
            if (ms) ms.lastContactAt = this.now();
          } catch (e) {
            failures.set(m.pikPubHex, (failures.get(m.pikPubHex) ?? 0) + 1);
            const ms = g.members[m.pikPubHex];
            if (ms) ms.lastFailure = (e as Error).message;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, run));
      await this.o.blobs.put(rootsBlob(g.root.generation), roots);
      await this.o.blobs.put(hashesBlob(g.root.generation), hashes);
      await this.save();
    }

    // A member that kept failing is replaced; the next step places its share.
    for (const [pik, n] of failures) if (n >= 3) await this.replace(g, pik, "it didn't take bricks");

    if (this.missing(g) === 0) await this.deposit(g);
    st.lastPlacedAt = this.now();
  }

  private async deposit(g: Gen): Promise<void> {
    const st = await this.state();
    const revision = g.depositedRevision + 1;
    g.root.revision = revision;
    const sealed = sealPbRoot(g.root, this.o.pbk);
    await this.o.com.putRoot(this.o.serverId, g.root.generation, revision, sealed);
    g.depositedRevision = revision;
    this.o.log?.(`generation ${g.root.generation} revision ${revision} recorded`);
    if (g.retired.length > 0) {
      await this.closeMembers(g.retired);
      g.retired = [];
    }
    if (st.pending === g) {
      const old = st.current;
      st.current = g;
      st.pending = null;
      if (old) {
        await this.closeMembers([...old.root.stripes.flat(), ...old.retired]);
        await this.o.blobs.delete(rootsBlob(old.root.generation));
        await this.o.blobs.delete(hashesBlob(old.root.generation));
      }
    }
    await this.save();
  }

  // ────────────────────────────────────────────────────────────────────
  // Proofs, renewals, repair
  // ────────────────────────────────────────────────────────────────────

  private async maintain(g: Gen): Promise<void> {
    const net = g.root.network;
    const now = this.now();
    const every = this.o.challengeEveryMs ?? 6 * HOUR;
    let d: PbDirectory | null = null;
    try {
      d = await this.directory();
    } catch {
      d = null;
    }
    const listed = new Set(d?.entries.map((e) => e.pikPubHex) ?? []);
    const roots = await this.o.blobs.get(rootsBlob(g.root.generation));
    for (let j = 0; j < g.root.stripes.length; j++) {
      for (let i = 0; i < net.n; i++) {
        const m = g.root.stripes[j]![i]!;
        const ms = g.members[m.pikPubHex];
        if (!ms) continue;
        if (roots && (ms.lastChallengeAt === null || now - ms.lastChallengeAt >= every)) {
          await this.challenge(g, j, i, roots);
        }
        if (m.expiresAt - now < (net.leaseMs * 2) / 3) await this.renew(m, ms);
        if (d) ms.unlistedSince = listed.has(m.pikPubHex) ? null : (ms.unlistedSince ?? now);
        const lastHeard = Math.max(ms.lastContactAt ?? 0, ms.placedAt);
        const why =
          ms.failStreak >= (this.o.failLimit ?? 3)
            ? "it failed its proofs"
            : now - lastHeard >= (this.o.offlineLimitMs ?? 72 * HOUR)
              ? "it has been offline too long"
              : ms.unlistedSince != null && now - ms.unlistedSince >= 12 * HOUR
                ? "it left peer backup"
                : null;
        if (why) await this.replace(g, m.pikPubHex, why);
      }
    }
  }

  private async challenge(g: Gen, stripe: number, shard: number, roots: Uint8Array): Promise<void> {
    const net = g.root.network;
    const m = g.root.stripes[stripe]![shard]!;
    const ms = g.members[m.pikPubHex]!;
    const segs: number[] = [];
    for (let s = stripe; s < this.totalSegments(g); s += g.root.stripes.length) if (bitGet(g.placedHex, s * net.n + shard)) segs.push(s);
    if (segs.length === 0) return;
    const seg = segs[Math.floor(this.rand() * segs.length)]!;
    const leafCount = net.brickBytes / net.leafBytes;
    const leaves = [Math.floor(this.rand() * leafCount), Math.floor(this.rand() * leafCount)];
    const brickId = derivePbBrickId(this.o.pbk, g.root.generation, seg, shard, m.rev);
    const root = roots.subarray((seg * net.n + shard) * 32, (seg * net.n + shard + 1) * 32);
    ms.lastChallengeAt = this.now();
    try {
      const r = await callHolder(this.o.transport, m, {
        op: "brick.prove",
        leaseId: m.leaseId,
        leaseKeySeed: fromHex(m.leaseKeySeedHex),
        args: { brickId, leaves },
        now: this.now(),
      });
      ms.lastContactAt = this.now();
      const paths = r.header.paths;
      const good =
        Array.isArray(paths) &&
        paths.length === leaves.length &&
        r.body.length === leaves.length * net.leafBytes &&
        leaves.every((li, k) =>
          pbVerifyLeaf(root, r.body.subarray(k * net.leafBytes, (k + 1) * net.leafBytes), li, (paths[k] as string[]).map(fromHex), leafCount),
        );
      if (good) {
        ms.failStreak = 0;
        ms.lastOkAt = this.now();
        ms.lastFailure = null;
      } else {
        ms.failStreak += 1;
        ms.lastFailure = "a proof didn't match";
      }
    } catch (e) {
      if (e instanceof PbRefused) {
        ms.lastContactAt = this.now();
        ms.failStreak += 1;
        ms.lastFailure = e.message;
      } else {
        ms.lastFailure = "unreachable";
      }
    }
  }

  private async renew(m: PbRootMember, ms: MemberStats): Promise<void> {
    const net = (await this.directory()).network;
    const slots = Math.ceil(this.bricksOf(m) / net.slotBricks) || 1;
    let tokens: Token[];
    try {
      tokens = await this.takeTokens(slots);
    } catch {
      return;
    }
    try {
      const r = await callHolder(this.o.transport, m, {
        op: "lease.renew",
        leaseId: m.leaseId,
        leaseKeySeed: fromHex(m.leaseKeySeedHex),
        args: { tokens },
        now: this.now(),
      });
      if (typeof r.header.expiresAt === "number") m.expiresAt = r.header.expiresAt;
      ms.lastContactAt = this.now();
    } catch (e) {
      if (e instanceof PbRefused) await this.returnTokens(tokens);
    }
  }

  private bricksOf(m: PbRootMember): number {
    const st = this.st!;
    for (const g of [st.current, st.pending]) {
      if (!g) continue;
      for (let j = 0; j < g.root.stripes.length; j++) {
        if (g.root.stripes[j]!.includes(m)) {
          let n = 0;
          for (let s = j; s < this.totalSegments(g); s += g.root.stripes.length) n++;
          return n;
        }
      }
    }
    return 1;
  }

  /** Move a member's share to a new holder (new rev, so new brick ids and keys). */
  private async replace(g: Gen, pik: string, why: string): Promise<void> {
    const net = g.root.network;
    let d: PbDirectory;
    try {
      d = await this.directory(true);
    } catch {
      return;
    }
    for (let j = 0; j < g.root.stripes.length; j++) {
      const stripe = g.root.stripes[j]!;
      const i = stripe.findIndex((m) => m.pikPubHex === pik);
      if (i < 0) continue;
      const old = stripe[i]!;
      const others = stripe.filter((_, k) => k !== i);
      const used = new Set(g.root.stripes.flat().map((m) => m.pikPubHex));
      let n = 0;
      for (let s = j; s < this.totalSegments(g); s += g.root.stripes.length) n++;
      const fresh = await this.openMember(d, g, Math.ceil(n / net.slotBricks), others, used, old.rev + 1);
      if (!fresh) {
        const st = await this.state();
        st.waiting = this.waitingSentence(d, net);
        return;
      }
      this.o.log?.(`moving ${n} bricks off a holder: ${why}`);
      stripe[i] = fresh;
      delete g.members[pik];
      g.retired.push({ pikPubHex: old.pikPubHex, xPubHex: old.xPubHex, leaseId: old.leaseId, leaseKeySeedHex: old.leaseKeySeedHex });
      for (let s = j; s < this.totalSegments(g); s += g.root.stripes.length) g.placedHex = bitSet(g.placedHex, s * net.n + i, false);
    }
    await this.save();
  }

  // ────────────────────────────────────────────────────────────────────
  // Status
  // ────────────────────────────────────────────────────────────────────

  async summary(): Promise<{
    state: "waiting-for-peers" | "placing" | "protected" | "at-risk" | "off";
    reason: string | null;
    archiveId: string | null;
    archiveCreatedAt: number | null;
    lastPlacedAt: number | null;
    totalBricks: number;
    healthyBricks: number;
    holders: Array<{ label: string; state: "ok" | "checking" | "failing" | "offline"; lastProofAt: number | null; bricks: number }>;
    keepUntil: number | null;
  }> {
    const st = await this.state();
    const g = st.current ?? st.pending;
    if (!g) {
      return {
        state: st.waiting ? "waiting-for-peers" : "off",
        reason: st.waiting ?? st.lastError,
        archiveId: null,
        archiveCreatedAt: null,
        lastPlacedAt: st.lastPlacedAt,
        totalBricks: 0,
        healthyBricks: 0,
        holders: [],
        keepUntil: null,
      };
    }
    const net = g.root.network;
    const now = this.now();
    const healthyMember = (m: PbRootMember) => {
      const ms = g.members[m.pikPubHex];
      return !!ms && ms.failStreak === 0 && now - Math.max(ms.lastContactAt ?? 0, ms.placedAt) < (this.o.offlineLimitMs ?? 72 * HOUR) / 3;
    };
    let total = 0;
    let healthy = 0;
    let weakest = net.n;
    for (let s = 0; s < this.totalSegments(g); s++) {
      let ok = 0;
      for (let i = 0; i < net.n; i++) {
        total++;
        const m = this.memberFor(g, s, i);
        if (bitGet(g.placedHex, s * net.n + i) && healthyMember(m)) {
          healthy++;
          ok++;
        }
      }
      weakest = Math.min(weakest, ok);
    }
    const holders = g.root.stripes.flat().map((m, idx) => {
      const ms = g.members[m.pikPubHex];
      const offline = !ms || now - Math.max(ms.lastContactAt ?? 0, ms.placedAt) >= (this.o.offlineLimitMs ?? 72 * HOUR) / 3;
      return {
        label: `Server ${idx + 1}`,
        state: (ms && ms.failStreak > 0 ? "failing" : offline ? "offline" : ms?.lastOkAt ? "ok" : "checking") as "ok" | "checking" | "failing" | "offline",
        lastProofAt: ms?.lastOkAt ?? null,
        bricks: this.bricksOf(m),
      };
    });
    const placing = st.pending !== null || this.missing(g) > 0;
    const keepUntil = Math.min(...g.root.stripes.flat().map((m) => m.expiresAt));
    return {
      state: st.current === null ? "placing" : weakest < net.k ? "at-risk" : placing ? "placing" : "protected",
      reason: st.waiting ?? st.lastError,
      archiveId: g.root.archive.archiveId,
      archiveCreatedAt: g.root.archive.createdAt,
      lastPlacedAt: st.lastPlacedAt,
      totalBricks: total,
      healthyBricks: healthy,
      holders,
      keepUntil,
    };
  }

  /** Close every lease (the policy moved away from Peer). */
  async release(): Promise<void> {
    const st = await this.state();
    for (const g of [st.current, st.pending]) if (g) await this.closeMembers([...g.root.stripes.flat(), ...g.retired]);
    st.current = null;
    st.pending = null;
    st.candidate = null;
    st.waiting = null;
    await this.save();
  }
}

