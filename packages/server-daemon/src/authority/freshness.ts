/**
 * Current authorization, separate from convergence (SECURITY-HARDENING-PLAN.md 18.7, N07).
 *
 * A signed access list proves who wrote an entry, not that a newer withdrawal is absent. So a
 * guest's access to an app also needs the box to hold a current checkpoint for that app's exact
 * policy revision. A checkpoint binds the app installation, the authority epoch, the ordered
 * policy revision, a digest of the revocations, the leader term and a freshness deadline.
 *
 * Each of those only moves forward; the high-water marks are kept in the state directory outside
 * app data, so restoring an app cannot make an old list look current. When no checkpoint is fresh,
 * external access to that app is refused and the owner's own control is not touched.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";
import type { AuthClock } from "./authClock.js";

export interface FreshnessCheckpoint {
  /** The app installation (slug + install id) this is for. */
  app: string;
  authorityEpoch: number;
  policyRevision: number;
  /** Digest of the revocations in force at that revision. */
  revocationDigest: string;
  leaderTerm: number;
  /** Authenticated-time ms after which this checkpoint no longer authorizes external access. */
  freshUntil: number;
}

export type CheckpointVerdict =
  | { ok: true }
  | { ok: false; reason: "no-trusted-time" | "stale-policy" | "old-term" | "old-epoch" | "already-expired" | "same-revision-different-digest" };

/** Longest a checkpoint may authorize external access, whatever a peer claims. */
export const MAX_FRESHNESS_MS = 15 * 60_000;

interface Persisted {
  v: 1;
  marks: Record<string, { policyRevision: number; leaderTerm: number; authorityEpoch: number; digest: string }>;
}

export class FreshnessLeases {
  private current = new Map<string, FreshnessCheckpoint>();
  private marks = new Map<string, Persisted["marks"][string]>();
  private failedClosed = false;

  constructor(
    private readonly path: string,
    private readonly clock: AuthClock,
    private readonly maxMs = MAX_FRESHNESS_MS,
  ) {}

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const p = JSON.parse(read.text) as Persisted;
      if (p?.v !== 1 || typeof p.marks !== "object") throw new Error("not a freshness file");
      for (const [k, v] of Object.entries(p.marks)) this.marks.set(k, v);
    } catch (e) {
      await keepCorruptAside(this.path, e, "External access to shared apps pauses until the box hears from its leader again.");
      // High-water marks are lost: refuse to guess. Nothing is fresh until new checkpoints arrive,
      // and they may start from any revision because there is nothing to compare with.
      this.failedClosed = true;
    }
  }

  /**
   * Accept a verified checkpoint (the caller has checked the underlying owner and device
   * signatures; the lead cannot invent membership). The deadline is capped, never trusted.
   */
  async accept(cp: FreshnessCheckpoint): Promise<CheckpointVerdict> {
    const now = this.clock.now();
    if (now === null) return { ok: false, reason: "no-trusted-time" };
    const mark = this.marks.get(cp.app);
    if (mark) {
      if (cp.authorityEpoch < mark.authorityEpoch) return { ok: false, reason: "old-epoch" };
      if (cp.leaderTerm < mark.leaderTerm) return { ok: false, reason: "old-term" };
      if (cp.policyRevision < mark.policyRevision) return { ok: false, reason: "stale-policy" };
      if (cp.policyRevision === mark.policyRevision && cp.revocationDigest !== mark.digest && cp.leaderTerm === mark.leaderTerm) {
        return { ok: false, reason: "same-revision-different-digest" };
      }
    }
    const freshUntil = Math.min(cp.freshUntil, now + this.maxMs);
    if (freshUntil <= now) return { ok: false, reason: "already-expired" };
    const accepted = { ...cp, freshUntil };
    this.current.set(cp.app, accepted);
    this.marks.set(cp.app, {
      policyRevision: Math.max(cp.policyRevision, mark?.policyRevision ?? 0),
      leaderTerm: Math.max(cp.leaderTerm, mark?.leaderTerm ?? 0),
      authorityEpoch: Math.max(cp.authorityEpoch, mark?.authorityEpoch ?? 0),
      digest: cp.revocationDigest,
    });
    this.failedClosed = false;
    await this.persist();
    return { ok: true };
  }

  /**
   * May external (non-owner) access to `app` be honoured now? Only on a current checkpoint at or
   * above the policy revision the access decision was made against, with trusted time.
   */
  externalAccessAllowed(app: string, policyRevision: number): boolean {
    const now = this.clock.now();
    if (now === null) return false;
    const cp = this.current.get(app);
    if (!cp) return false;
    return cp.policyRevision >= policyRevision && now < cp.freshUntil;
  }

  status(app: string): { fresh: boolean; freshUntil: number | null; policyRevision: number | null; trustedTime: boolean } {
    const cp = this.current.get(app) ?? null;
    const now = this.clock.now();
    return {
      fresh: cp !== null && now !== null && now < cp.freshUntil,
      freshUntil: cp?.freshUntil ?? null,
      policyRevision: cp?.policyRevision ?? null,
      trustedTime: now !== null,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body: Persisted = { v: 1, marks: Object.fromEntries(this.marks) };
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}
