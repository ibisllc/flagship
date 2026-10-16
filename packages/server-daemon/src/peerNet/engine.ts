/**
 * Runs peer backup while this server's backup policy is Peer
 * (docs/peer-backup.md §11): the holder (others' bricks + filler in the
 * pool) and the owner (this server's newest archive on eight other
 * accounts' servers). On a change away from Peer it releases its own
 * bricks and leaves gracefully as a holder.
 */
import { join } from "node:path";
import { canonicalPbMailboxAnnounce, ed, pbMailboxEpoch } from "@flagship/protocol";
import { buildHttpPbCom, buildHttpPbTransport } from "./comClient.js";
import { HolderEngine, type HolderState, type HolderStatus } from "./holder.js";
import { fromHex, hex } from "./mailOps.js";
import { OwnerEngine, type OwnerState } from "./owner.js";
import { fetchPeerRoot, restoreFromPeers, type PeerRestoreResult } from "./restore.js";
import { FsBlobStore, FsStateFile } from "./stores.js";
import type { PbComClient, PbMailTransport } from "./types.js";

export type PeerPolicy = "unset" | "phone" | "peer" | "none";

export interface PeerEngineOptions {
  serverId: string;
  dataDir: string;
  /** PBK = derivePeerBackupKey(SWK). */
  pbk: Uint8Array;
  /** Signs with the server's STK. */
  sign: (msg: Uint8Array) => Uint8Array;
  comBaseUrl: string;
  policy: { current(): { policy: PeerPolicy }; onChange?(cb: () => void): () => void };
  /** 2/3 of the disk while the policy is Peer (backupPolicy/cap.ts), else null. */
  reservedForPeersBytes: () => number | null;
  /** Override the relay `.com` names (tests, the gym). */
  relayBase?: string;
  com?: PbComClient;
  transport?: PbMailTransport;
  fetchImpl?: typeof fetch;
  now?: () => number;
  tickMs?: number;
  log?: (m: string) => void;
}

/** A lost server's record, as a restoring device sees it. */
export interface PeerRootSummary {
  serverId: string;
  generation: number;
  revision: number;
  createdAt: number;
  archive: { archiveId: string; createdAt: number; bytes: number; sha256: string; backupFile: string };
  holders: number;
  needed: number;
  keepUntil: number;
}

export type PeerEngineState = "waiting-for-peers" | "filling" | "placing" | "protected" | "at-risk" | "leaving" | "off";

/** What the server page shows in the backup-policy slot. */
export interface PeerPolicyStatus {
  state: PeerEngineState;
  reason?: string;
  lastPlacedAt: number | null;
  healthyBricks: number;
  totalBricks: number;
  holders: number;
  archiveId: string | null;
  hostingBytes: number;
  provenBytes: number;
  poolBytes: number;
}

/** The full peer-backup screen. */
export interface PeerBackupStatusV2 extends PeerPolicyStatus {
  v: 2;
  policy: PeerPolicy;
  archiveCreatedAt: number | null;
  holderList: Array<{ label: string; state: "ok" | "checking" | "failing" | "offline"; lastProofAt: number | null; bricks: number }>;
  keepUntil: number | null;
  hosting: { poolBytes: number; realBytes: number; fillerBytes: number; provenBytes: number; leases: number; bricks: number; reliability: number | null; leaving: boolean };
}

export class PeerBackupEngine {
  readonly holder: HolderEngine;
  readonly owner: OwnerEngine;
  readonly com: PbComClient;
  readonly transport: PbMailTransport;
  private relayBase: string | null;
  private pinnedCache = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private released = false;

  constructor(private readonly o: PeerEngineOptions) {
    const dir = join(o.dataDir, "peer-net");
    this.com = o.com ?? buildHttpPbCom({ baseUrl: o.comBaseUrl, serverDomain: o.serverId, sign: o.sign, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.now ? { now: o.now } : {}) });
    this.relayBase = o.relayBase ?? null;
    this.transport =
      o.transport ??
      buildHttpPbTransport({
        relayBase: () => {
          if (!this.relayBase) throw new Error("the relay isn't known yet");
          return this.relayBase;
        },
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      });
    const pool = () => {
      const r = o.reservedForPeersBytes();
      return r === null || o.policy.current().policy !== "peer" ? 0 : Math.floor(r * 0.98);
    };
    this.holder = new HolderEngine({
      serverId: o.serverId,
      com: this.com,
      state: new FsStateFile<HolderState>(join(dir, "holder.json")),
      blobs: new FsBlobStore(join(dir, "pool")),
      poolBytes: pool,
      ...(o.now ? { now: o.now } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
    this.owner = new OwnerEngine({
      serverId: o.serverId,
      pbk: o.pbk,
      com: this.com,
      transport: this.transport,
      state: new FsStateFile<OwnerState>(join(dir, "owner.json")),
      blobs: new FsBlobStore(join(dir, "own")),
      ...(o.now ? { now: o.now } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }

  private isPeer(): boolean {
    return this.o.policy.current().policy === "peer";
  }

  start(): void {
    if (this.timer) return;
    const every = this.o.tickMs ?? 10 * 60_000;
    this.timer = setInterval(() => void this.tick(), every);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.o.policy.onChange?.(() => void this.tick());
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const hs = await this.holder.state();
      if (this.isPeer()) {
        await this.ensureRelay();
        this.released = false;
        if (hs.leavingSince !== null) await this.holder.rejoin();
        await this.holder.tick();
        await this.owner.step();
      } else {
        const has = Object.keys(hs.leases).length > 0 || hs.fillerHeld > 0 || (await this.owner.state()).current !== null;
        if (has && !this.released) {
          await this.ensureRelay();
          await this.owner.release();
          await this.holder.leave();
          this.released = true;
        }
        if (hs.leavingSince !== null && !(await this.holder.left())) await this.holder.tick();
      }
      this.pinnedCache = await this.owner.pinned();
    } catch (e) {
      this.o.log?.(`peer backup tick: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async ensureRelay(): Promise<void> {
    if (this.relayBase) return;
    try {
      this.relayBase = (await this.com.network()).relayBase;
    } catch (e) {
      this.o.log?.(`peer backup: ${(e as Error).message}`);
    }
  }

  /** serverArchive hook: a saved archive. */
  onArchiveSaved(meta: { archiveId: string; createdAt: number; bytes: number; sha256: string }, files: { dataPath: string; backupPath: string }): void {
    if (!this.isPeer()) return;
    void this.owner
      .offer({ archiveId: meta.archiveId, createdAt: meta.createdAt, bytes: meta.bytes, sha256: meta.sha256, dataPath: files.dataPath, backupPath: files.backupPath })
      .then(async () => {
        this.pinnedCache = await this.owner.pinned();
      });
  }

  /** serverArchive hook: archives retention must keep. */
  pinnedArchiveIds(): Set<string> {
    return new Set(this.pinnedCache);
  }

  /** A sealed request that reached this server's mailbox through the tunnel. */
  handleMail(mailboxId: string, envelope: Uint8Array): Promise<Uint8Array> {
    return this.holder.handleMail(mailboxId, envelope);
  }

  /** The mailbox announcements the tunnel sends the hub (current and next epoch). */
  async mailboxAnnouncements(): Promise<Array<{ pikPubHex: string; epoch: number; sigHex: string }>> {
    const st = await this.holder.state();
    const pik = await this.holder.pikPubHex();
    const e = pbMailboxEpoch((this.o.now ?? Date.now)());
    return [e, e + 1].map((epoch) => ({ pikPubHex: pik, epoch, sigHex: hex(ed.sign(canonicalPbMailboxAnnounce(pik, epoch), fromHex(st.pikSeedHex))) }));
  }

  async restore(a: { serverId: string; pbk: Uint8Array; outPath: string; onProgress?: (done: number, total: number) => void }): Promise<PeerRestoreResult> {
    if (!this.relayBase) this.relayBase = (await this.com.network()).relayBase;
    return restoreFromPeers({ ...a, com: this.com, transport: this.transport, ...(this.o.now ? { now: this.o.now } : {}) });
  }

  /** What a lost server's record holds, for the device restoring it. */
  async describeRoot(serverId: string, pbk: Uint8Array): Promise<PeerRootSummary> {
    const root = await fetchPeerRoot(this.com, serverId, pbk);
    return {
      serverId,
      generation: root.generation,
      revision: root.revision,
      createdAt: root.createdAt,
      archive: root.archive,
      holders: root.stripes.flat().length,
      needed: root.network.k,
      keepUntil: Math.min(...root.stripes.flat().map((m) => m.expiresAt)),
    };
  }

  /**
   * The restore fetcher the server-restore flow calls (`from-peers`): bring
   * the named archive's data file back from peers into `outPath`. Refuses
   * when the record on .com is for a different archive than the device chose.
   */
  async fetchArchive(a: { serverId: string; pbk: Uint8Array; archiveId: string; bytes: number; sha256: string; outPath: string; onProgress?: (done: number, total: number) => void }): Promise<{ dataPath: string }> {
    const root = await fetchPeerRoot(this.com, a.serverId, a.pbk);
    if (root.archive.archiveId !== a.archiveId || root.archive.sha256 !== a.sha256 || root.archive.bytes !== a.bytes) {
      throw new Error("The backup on other servers isn't the one this restore names.");
    }
    const r = await this.restore({ serverId: a.serverId, pbk: a.pbk, outPath: a.outPath, ...(a.onProgress ? { onProgress: a.onProgress } : {}) });
    return { dataPath: r.dataPath };
  }

  private engineState(own: Awaited<ReturnType<OwnerEngine["summary"]>>, h: HolderStatus): PeerEngineState {
    if (!this.isPeer()) return h.leaving ? "leaving" : "off";
    if (own.state === "off") return h.fillerBytes + h.realBytes < h.poolBytes * 0.5 ? "filling" : "waiting-for-peers";
    return own.state;
  }

  async policyStatus(): Promise<PeerPolicyStatus> {
    const own = await this.owner.summary();
    const h = await this.holder.status();
    return {
      state: this.engineState(own, h),
      ...(own.reason ? { reason: own.reason } : h.lastError ? { reason: h.lastError } : {}),
      lastPlacedAt: own.lastPlacedAt,
      healthyBricks: own.healthyBricks,
      totalBricks: own.totalBricks,
      holders: own.holders.length,
      archiveId: own.archiveId,
      hostingBytes: h.realBytes,
      provenBytes: h.provenBytes,
      poolBytes: h.poolBytes,
    };
  }

  async status(): Promise<PeerBackupStatusV2> {
    const own = await this.owner.summary();
    const h = await this.holder.status();
    const p = await this.policyStatus();
    return {
      v: 2,
      ...p,
      policy: this.o.policy.current().policy,
      archiveCreatedAt: own.archiveCreatedAt,
      holderList: own.holders,
      keepUntil: own.keepUntil,
      hosting: {
        poolBytes: h.poolBytes,
        realBytes: h.realBytes,
        fillerBytes: h.fillerBytes,
        provenBytes: h.provenBytes,
        leases: h.leases,
        bricks: h.bricks,
        reliability: h.reliability,
        leaving: h.leaving,
      },
    };
  }
}
