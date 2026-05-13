/**
 * Daemon-side re-pair watcher (J.3 trigger).
 *
 * The phone-initiated re-pair flow runs on .com:
 *
 *   1. New phone signs `RePairInitiate` with NEW IRK → .com persists a
 *      `pending_re_pairs` row referencing old + new IRK pubs.
 *   2. Old phone (if still around) can object via `RePairObject` within
 *      a 24h grace window.
 *   3. After grace, anyone calls `POST /api/users/:username/re-pair/complete`;
 *      .com atomically swaps the user's IRK pub on success and deletes
 *      the pending row.
 *
 * The daemon learns about the swap by polling
 * `GET /api/users/:username/re-pair`. Transitions observed:
 *
 *   - `pending: null` → `pending: { ... objectedAt: null }`
 *     A re-pair just got initiated; nothing for the daemon to do yet —
 *     the user might still object on their old phone.
 *
 *   - `pending: { objectedAt: null }` → `pending: { objectedAt: T }`
 *     The OLD phone canceled it; clear local state and keep operating
 *     against the existing IRK.
 *
 *   - `pending: { newIrkPub: X, objectedAt: null }` → `pending: null`
 *     The pending row went away — either it was completed (good case)
 *     or it expired without completion (we ignore in v1 since the
 *     pending row currently persists until /complete is hit; future
 *     work: add an explicit "expired" flag and don't fire the J.3
 *     trigger here).
 *     On this transition, the daemon:
 *       a. Drops every paired-session token (they were authorized by
 *          the old phone; the new owner has to re-pair every browser).
 *       b. Triggers J.4 — `reissueStableIds(oldHex, X)` — which walks
 *          every installed app's membership table.
 *       c. Persists a "swap completed" marker so a restart doesn't
 *          re-fire the trigger.
 *
 * Persistence: a single JSON file at
 * `<dataDir>/repair-watcher.json` holding the last observed pending row
 * + the last IRK pubkey we successfully swapped to. The file is the
 * source of truth for transition detection across daemon restarts.
 *
 * Testability seam: `pollOnce()` is the atomic unit (one fetch + one
 * state update). `start()`/`stop()` are thin setInterval wrappers tests
 * never touch.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AlertInbox } from "../alertInbox.js";
import type { ReissuanceAlert } from "../phoneAlerts.js";
import type { ReissuanceReport, ReissuerDeps } from "./stableIdReissuer.js";
import { reissueStableIds } from "./stableIdReissuer.js";

export interface RePairPendingRow {
  newIrkPub: string;
  oldIrkPub: string;
  initiatedAt: number;
  completesAt: number;
  objectedAt: number | null;
}

export interface RePairWatcherState {
  /** Last `/api/users/<u>/re-pair` GET payload we observed. */
  lastSeen: RePairPendingRow | null;
  /** IRK pubkey we last successfully swapped to (so we don't re-fire on restart). */
  lastSwapTo: string | null;
  /** Timestamp of the last successful swap. */
  lastSwapAt: number | null;
  /** Last poll attempt (success or failure). */
  lastPolledAt: number;
  /** Most recent transient error, if any. */
  lastError: string | null;
}

export interface RePairWatcherDeps {
  /**
   * Username this daemon serves. Used to build the .com URL the
   * watcher polls.
   */
  username: string;
  /**
   * The IRK pubkey hex this daemon currently trusts as authoritative.
   * On boot it's whatever was baked into config; the watcher updates
   * it (and notifies the caller via `onIrkSwapped`) when a swap
   * completes.
   */
  currentIrkPubHex: string;
  /** .com base URL — typically `https://flagshipserver.com`. */
  comBaseUrl: string;
  /** node fetch (or a stub in tests). */
  fetchImpl: typeof fetch;
  /**
   * Persistence path. The watcher reads + writes
   * `<dataDir>/repair-watcher.json` atomically.
   */
  statePath: string;
  /** Wall clock. */
  now?: () => number;
  /** Poll interval. Defaults to 5 min. */
  pollIntervalMs?: number;
  /**
   * Called after the watcher has handled a completed swap. Caller is
   * responsible for updating any in-memory config that referenced the
   * old IRK (e.g. signature-verification gates on order envelopes).
   */
  onIrkSwapped?: (event: {
    oldIrkPubHex: string;
    newIrkPubHex: string;
    pairedSessionsCleared: number;
    reissue: ReissuanceReport | null;
  }) => void | Promise<void>;
  /**
   * Drop every paired-session token. The watcher returns the count so
   * the report carries it. Pass a no-op for tests that don't care
   * about paired sessions.
   */
  clearPairedSessions: () => Promise<number>;
  /**
   * J.4 — re-issue stable IDs across every installed app. Pass null
   * to skip (tests that don't exercise membership rewriting).
   */
  reissuerDeps: ReissuerDeps | null;
  /**
   * Phone alert inbox. When the reissuer reports per-app rewrites,
   * the watcher emits one `membership-reissued` alert per app with a
   * non-zero rewritten count so the phone can show a per-app review
   * screen. Optional — pass null in tests that don't care about
   * alert emission.
   */
  alertInbox?: AlertInbox | null;
}

const FIVE_MIN_MS = 5 * 60_000;

export class RePairWatcher {
  state: RePairWatcherState = {
    lastSeen: null,
    lastSwapTo: null,
    lastSwapAt: null,
    lastPolledAt: 0,
    lastError: null,
  };

  /**
   * Latest ReissuanceReport from the most recent completed swap on
   * this daemon. The screens HTTP `/post-recovery/status` snapshot
   * pulls from here; null until a swap has actually fired.
   */
  lastReissue: ReissuanceReport | null = null;

  /** Updated after a successful swap; readable by the rest of the daemon. */
  private _currentIrkPubHex: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RePairWatcherDeps) {
    this._currentIrkPubHex = deps.currentIrkPubHex.toLowerCase();
  }

  get currentIrkPubHex(): string {
    return this._currentIrkPubHex;
  }

  /**
   * JSON-safe snapshot for the phone-facing
   * /api/screens/post-recovery/status endpoint. Returns enough for
   * the iOS reattach-progress screen to render without a second
   * fetch.
   */
  snapshot(): {
    currentIrkPubHex: string;
    state: RePairWatcherState;
    lastReissue: ReissuanceReport | null;
  } {
    return {
      currentIrkPubHex: this._currentIrkPubHex,
      state: { ...this.state },
      lastReissue: this.lastReissue,
    };
  }

  async load(): Promise<void> {
    if (!existsSync(this.deps.statePath)) return;
    try {
      const raw = await readFile(this.deps.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RePairWatcherState>;
      this.state = {
        lastSeen: parsed.lastSeen ?? null,
        lastSwapTo: parsed.lastSwapTo ?? null,
        lastSwapAt: parsed.lastSwapAt ?? null,
        lastPolledAt: parsed.lastPolledAt ?? 0,
        lastError: parsed.lastError ?? null,
      };
      if (this.state.lastSwapTo) {
        this._currentIrkPubHex = this.state.lastSwapTo.toLowerCase();
      }
    } catch {
      // Treat unreadable / malformed as no prior state.
    }
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.pollIntervalMs ?? FIVE_MIN_MS;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => { /* errors land in state.lastError */ });
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll + transition-detect + (maybe) swap. Idempotent: if no
   * transition fires, only `lastPolledAt` / `lastSeen` change. Returns
   * the transition that fired (or `"none"`) for test assertions.
   */
  async pollOnce(): Promise<"none" | "initiated" | "objected" | "completed"> {
    const now = (this.deps.now ?? (() => Date.now()))();
    let observed: RePairPendingRow | null;
    try {
      observed = await this.fetchPending();
      this.state.lastError = null;
    } catch (e) {
      this.state.lastError = (e as Error).message;
      this.state.lastPolledAt = now;
      await this.persist();
      return "none";
    }
    this.state.lastPolledAt = now;

    const prior = this.state.lastSeen;
    let transition: "none" | "initiated" | "objected" | "completed" = "none";

    if (!prior && observed) {
      transition = "initiated";
    } else if (prior && observed && !prior.objectedAt && observed.objectedAt) {
      transition = "objected";
    } else if (prior && !observed) {
      // pending row went away. Two cases distinguished by completion:
      //   - prior had no objection AND swap target ≠ already-swapped → completed
      //   - prior had an objection → just clear state, nothing to do
      if (!prior.objectedAt) {
        const newHex = prior.newIrkPub.toLowerCase();
        if (this.state.lastSwapTo !== newHex) {
          await this.handleCompletedSwap(prior, now);
          transition = "completed";
        }
      }
    }

    this.state.lastSeen = observed;
    await this.persist();
    return transition;
  }

  private async fetchPending(): Promise<RePairPendingRow | null> {
    const url = `${this.deps.comBaseUrl.replace(/\/$/, "")}/api/users/${encodeURIComponent(this.deps.username)}/re-pair`;
    const r = await this.deps.fetchImpl(url, { method: "GET" });
    if (!r.ok) throw new Error(`re-pair GET ${url} → ${r.status}`);
    const body = (await r.json()) as { pending?: RePairPendingRow | null };
    return body.pending ?? null;
  }

  private async handleCompletedSwap(prior: RePairPendingRow, now: number): Promise<void> {
    const oldHex = prior.oldIrkPub.toLowerCase();
    const newHex = prior.newIrkPub.toLowerCase();

    const pairedSessionsCleared = await this.deps.clearPairedSessions();

    let reissue: ReissuanceReport | null = null;
    if (this.deps.reissuerDeps) {
      reissue = await reissueStableIds({
        deps: this.deps.reissuerDeps,
        oldIrkPubHex: oldHex,
        newIrkPubHex: newHex,
      });
      this.lastReissue = reissue;
      if (this.deps.alertInbox) {
        for (const app of reissue.apps) {
          if (app.rewrittenCount === 0) continue;
          const alert: ReissuanceAlert = {
            kind: "membership-reissued",
            appId: app.appId,
            slug: app.slug,
            rewrittenCount: app.rewrittenCount,
            oldIrkPrefix: reissue.oldIrkPrefix,
            newIrkPrefix: reissue.newIrkPrefix,
            completedAt: app.completedAt,
            undoWindowExpiresAt: reissue.undoWindowExpiresAt,
          };
          this.deps.alertInbox.emit(alert);
        }
      }
    }

    this._currentIrkPubHex = newHex;
    this.state.lastSwapTo = newHex;
    this.state.lastSwapAt = now;

    if (this.deps.onIrkSwapped) {
      await this.deps.onIrkSwapped({
        oldIrkPubHex: oldHex,
        newIrkPubHex: newHex,
        pairedSessionsCleared,
        reissue,
      });
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(tmp, this.deps.statePath);
  }
}

export function defaultRePairWatcherPath(dataDir: string): string {
  return join(dataDir, "repair-watcher.json");
}
