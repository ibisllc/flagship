/**
 * The co-manager cap across the account's servers (owner decision 2026-11-14,
 * docs/share-a-server.md §5.8): Free 5, Pro 10, Pro Max 25, Enterprise
 * unlimited, counted in active shares (one person on one server; a share's
 * keys are per share, so nobody can tell two shares are the same person).
 *
 * How the servers agree: a share lives on exactly one server, so the account's
 * count is a sum, not a merge. When a share is about to go live this box asks
 * each of the account's other servers how many it holds (`/api/access-sync/
 * shares`, the same box-to-box MAC under the cloud gossip key as the one-list
 * hand-over: `.com` sees neither the question nor the answer) and adds its own.
 * A server that doesn't answer counts with what it said last (kept here, so a
 * restart or a sibling that is off still counts); a server that left the
 * account's list a week ago stops counting. The plan comes from the CA-signed
 * plan attestation the box already holds (none, or an expired one: Free).
 *
 * Two servers accepting at the very same moment could each pass at cap - 1;
 * `.com` refuses the share link before either acceptance once the account's
 * open links and live shares reach the cap, which closes that in practice.
 */
import { readFile } from "node:fs/promises";
import {
  coManagerCapFor,
  coManagerCapRefusal,
  coManagerPlanOf,
  coManagerRoomFor,
  type CoManagerCapRefusal,
  type CoManagerCount,
} from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";

export interface CoManagerCapSource {
  /** The account's plan as this box can prove it (PlanCheck.tier). */
  tier(): string;
  /** Read the plan again soon (the owner may just have upgraded). */
  refreshPlan?(): Promise<unknown>;
  /** The account's other servers. */
  servers(): string[];
  /** How many shares `peer` holds; null when it didn't answer. */
  sharesOn(peer: string): Promise<number | null>;
}

export interface CoManagerCapOptions {
  /** Where the other servers' last answers are kept; null ⇒ memory only (tests). */
  path: string | null;
  /** Active shares on this server. */
  localCount: () => number;
  /** Null until the box-to-box hand-over is up (then: this server alone, Free). */
  source: () => CoManagerCapSource | null;
  askTimeoutMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

interface PeerCount {
  count: number;
  /** When it last answered. */
  at: number;
  /** When it was last among the account's servers. */
  listedAt: number;
}

const FORGET_UNLISTED_MS = 7 * 24 * 3600_000;
const ASK_AGAIN_MS = 60_000;

export class CoManagerCap {
  private readonly peers = new Map<string, PeerCount>();
  private readonly now: () => number;
  private askedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: CoManagerCapOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (!this.opts.path) return;
    try {
      const raw = JSON.parse(await readFile(this.opts.path, "utf8")) as Record<string, Partial<PeerCount>>;
      for (const [peer, v] of Object.entries(raw ?? {})) {
        if (typeof v?.count === "number" && Number.isSafeInteger(v.count) && v.count >= 0 && typeof v.at === "number") {
          this.peers.set(peer.toLowerCase(), { count: v.count, at: v.at, listedAt: typeof v.listedAt === "number" ? v.listedAt : v.at });
        }
      }
    } catch {
      // Missing or damaged: the next count asks every server again.
    }
  }

  /**
   * The account's active shares across its servers, and the plan's cap.
   * `fresh` asks the other servers now; otherwise at most once a minute
   * (the Shared with card reads this on every visit).
   */
  async count(opts: { fresh?: boolean } = {}): Promise<CoManagerCount> {
    const src = this.opts.source();
    const plan = coManagerPlanOf(src?.tier() ?? "free");
    if (src && (opts.fresh || this.now() - this.askedAt >= ASK_AGAIN_MS)) await this.ask(src);
    let total = this.opts.localCount();
    for (const p of this.peers.values()) total += p.count;
    return { count: total, cap: coManagerCapFor(plan), plan };
  }

  /** Null when one more share may go live; otherwise the refusal. */
  async admit(): Promise<CoManagerCapRefusal | null> {
    let c = await this.count({ fresh: true });
    if (coManagerRoomFor(c)) return null;
    const src = this.opts.source();
    if (src?.refreshPlan) {
      await src.refreshPlan().catch(() => {});
      const plan = coManagerPlanOf(src.tier());
      c = { count: c.count, cap: coManagerCapFor(plan), plan };
      if (coManagerRoomFor(c)) return null;
    }
    this.opts.log?.(`[shares] co-manager cap: ${c.count} of ${c.cap} on ${c.plan}`);
    return coManagerCapRefusal({ ...c, cap: c.cap as number });
  }

  private async ask(src: CoManagerCapSource): Promise<void> {
    const now = this.now();
    this.askedAt = now;
    const listed = [...new Set(src.servers().map((s) => s.toLowerCase()))];
    const timeout = this.opts.askTimeoutMs ?? 5_000;
    const answers = await Promise.all(listed.map((peer) => withTimeout(src.sharesOn(peer), timeout).then((n) => [peer, n] as const)));
    let changed = false;
    for (const [peer, n] of answers) {
      const prev = this.peers.get(peer);
      if (n !== null) {
        if (prev?.count !== n) changed = true;
        this.peers.set(peer, { count: n, at: now, listedAt: now });
      } else if (prev) {
        prev.listedAt = now;
      }
    }
    const inList = new Set(listed);
    for (const [peer, p] of this.peers) {
      if (!inList.has(peer) && now - p.listedAt > FORGET_UNLISTED_MS) {
        this.peers.delete(peer);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private async save(): Promise<void> {
    if (!this.opts.path) return;
    try {
      await writeFileDurable(this.opts.path, JSON.stringify(Object.fromEntries(this.peers)));
    } catch (e) {
      this.opts.log?.(`[shares] could not keep the other servers' share counts: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}
