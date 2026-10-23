/**
 * Freshness checkpoints a box issues for itself (SECURITY-HARDENING-PLAN.md 18.7, N07).
 *
 * External (guest) access to an app is honoured only on a current checkpoint. A box renews its
 * checkpoint for an app when it can show, within a short window, that it holds the current list:
 *  - it has authenticated time;
 *  - `.com` answered its revocation poll recently;
 *  - the app is not waiting to catch up, and, when other servers run the app, this box compared its
 *    list with one of them recently (or none run it, so the list is the only one there is).
 * Lose any of these for long enough and the checkpoint lapses: guests are refused, the owner is not.
 */
import { createHash } from "node:crypto";
import type { AuthClock } from "./authClock.js";
import type { FreshnessLeases } from "./freshness.js";

export interface CheckpointInputs {
  apps: () => string[];
  digestOf: (app: string) => string;
  state: (app: string) => { shared: boolean; catchingUp: boolean; hasPeers: boolean; lastSyncAt: number | null };
  /** When `.com` last answered the revocation poll (wall ms), or null. */
  revocationAnsweredAt: () => number | null;
  authorityEpoch: () => number;
  /** The wall clock only compares with the timestamps above, which it also made; never a deadline. */
  wallNow: () => number;
}

/** How recent a poll or a comparison must be for the list to count as current. */
export const CURRENT_WITHIN_MS = 6 * 60_000;
/** How long one renewal authorizes guests; the renewal timer runs far more often than this. */
export const CHECKPOINT_TTL_MS = 10 * 60_000;

export class LocalCheckpoints {
  private last = new Map<string, { digest: string; revision: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly leases: FreshnessLeases,
    private readonly clock: AuthClock,
    private readonly inputs: CheckpointInputs,
  ) {}

  /** Renew every app that qualifies. Returns the apps renewed. */
  async renewAll(): Promise<string[]> {
    const authNow = this.clock.now();
    if (authNow === null) return [];
    const wall = this.inputs.wallNow();
    const answered = this.inputs.revocationAnsweredAt();
    if (answered === null || wall - answered > CURRENT_WITHIN_MS) return [];
    const renewed: string[] = [];
    for (const app of this.inputs.apps()) {
      const st = this.inputs.state(app);
      if (st.catchingUp) continue;
      if (st.shared && st.hasPeers && (st.lastSyncAt === null || wall - st.lastSyncAt > CURRENT_WITHIN_MS)) continue;
      const digest = createHash("sha256").update(this.inputs.digestOf(app)).digest("hex");
      const prev = this.last.get(app);
      // The revision only moves forward and changes when the list does: authenticated time is both.
      const revision = prev && prev.digest === digest ? prev.revision : authNow;
      const verdict = await this.leases.accept({
        app,
        authorityEpoch: this.inputs.authorityEpoch(),
        policyRevision: revision,
        revocationDigest: digest,
        leaderTerm: 1,
        freshUntil: authNow + CHECKPOINT_TTL_MS,
      });
      if (verdict.ok) {
        this.last.set(app, { digest, revision });
        renewed.push(app);
      }
    }
    return renewed;
  }

  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.renewAll().catch(() => {}), everyMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
