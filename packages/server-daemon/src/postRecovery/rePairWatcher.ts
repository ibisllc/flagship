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
 * Trust (docs/device-admin-tier-spec.md section 5): `.com` is not a trust
 * anchor, so its report that a swap completed is only a hint. The box applies
 * the swap (clears paired sessions, re-anchors membership, adopts the new IRK)
 * only when it can verify it from a key it already trusts:
 *
 *   - proof: the row carries a `proof` with two signatures over the same
 *     `RePairInitiate` bytes, one by the new IRK and one by the IRK this box
 *     currently trusts (the key-file / device-pair recovery routes make it); or
 *   - rotation: the box pins an admin root and its rotation consumer has
 *     re-pinned at or after the re-pair began (a recovery that re-mints the
 *     admin root signs old-root -> new-root, which the box verified itself).
 *
 * Anything else is left unapplied (`state.unverified`, kept for a week in case
 * the rotation reaches the box after the row disappears) and the owner's key
 * and sessions stay as they were.
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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRePairInitiate, type RePairInitiate } from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";
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
  /** What `.com` stored of the initiate, so the box can check it itself. */
  proof?: RePairProof | null;
}

export interface RePairProof {
  issuedAt: number;
  /** Hex Ed25519 by the NEW IRK over the RePairInitiate bytes. */
  newIrkSignature: string;
  /** Hex Ed25519 by the IRK the account had; only the key-file / device-pair routes have one. */
  oldIrkSignature?: string | null;
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const PROOF_SKEW_MS = 60 * 60_000;
const ROTATION_LEAD_MS = 10 * 60_000;
const UNVERIFIED_KEEP_MS = 7 * 24 * 60 * 60_000;

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Can the box verify this completed re-pair from a key it already trusts?
 * "proof" (the signatures chain from `currentIrkPubHex`), "rotation" (a
 * verified admin-root rotation was applied since the re-pair began), or null.
 */
export async function verifyRePairSwap(opts: {
  row: RePairPendingRow;
  username: string;
  currentIrkPubHex: string;
  /** True when the box's pinned admin root was re-pinned (by a chain it verified) at or after `sinceMs`. */
  rotationAppliedSince?: (sinceMs: number) => Promise<boolean>;
}): Promise<"proof" | "rotation" | null> {
  const { row } = opts;
  const oldHex = row.oldIrkPub.toLowerCase();
  const newHex = row.newIrkPub.toLowerCase();
  const proof = row.proof;
  if (
    proof &&
    HEX(64).test(oldHex) &&
    HEX(64).test(newHex) &&
    oldHex === opts.currentIrkPubHex.toLowerCase() &&
    typeof proof.issuedAt === "number" &&
    Math.abs(proof.issuedAt - row.initiatedAt) <= PROOF_SKEW_MS &&
    typeof proof.newIrkSignature === "string" &&
    HEX(128).test(proof.newIrkSignature.toLowerCase()) &&
    typeof proof.oldIrkSignature === "string" &&
    HEX(128).test(proof.oldIrkSignature.toLowerCase())
  ) {
    const claim: RePairInitiate = {
      username: opts.username,
      newIrkPub: fromHex(newHex),
      oldIrkPub: fromHex(oldHex),
      issuedAt: proof.issuedAt,
    };
    if (
      verifyRePairInitiate(claim, fromHex(proof.newIrkSignature.toLowerCase()), claim.newIrkPub) &&
      verifyRePairInitiate(claim, fromHex(proof.oldIrkSignature.toLowerCase()), claim.oldIrkPub)
    ) {
      return "proof";
    }
  }
  if (opts.rotationAppliedSince) {
    try {
      if (await opts.rotationAppliedSince(row.initiatedAt - ROTATION_LEAD_MS)) return "rotation";
    } catch {
      /* unreadable pin: no evidence */
    }
  }
  return null;
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
  /**
   * A swap `.com` reported but the box could not verify (yet). Nothing was
   * applied for it; it is re-checked each poll for a week.
   */
  unverified?: { row: RePairPendingRow; seenAt: number } | null;
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
  /**
   * True when the box's pinned admin root was re-pinned at or after the given
   * time by a rotation chain the box verified itself. Omit on a box that pins
   * no admin root: then only a signed proof can authorize a swap.
   */
  rotationAppliedSince?: (sinceMs: number) => Promise<boolean>;
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
        unverified: parsed.unverified ?? null,
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
  async pollOnce(): Promise<"none" | "initiated" | "objected" | "completed" | "unverified"> {
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
    let transition: "none" | "initiated" | "objected" | "completed" | "unverified" = "none";

    // A swap `.com` reported earlier that the box could not verify: the proof
    // may have arrived since (the rotation lane is polled separately).
    const waiting = this.state.unverified;
    if (waiting) {
      if (now - waiting.seenAt > UNVERIFIED_KEEP_MS) {
        this.state.unverified = null;
      } else if (await this.verified(waiting.row)) {
        this.state.unverified = null;
        await this.handleCompletedSwap(waiting.row, now);
        transition = "completed";
      }
    }

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
        if (this.state.lastSwapTo !== newHex && transition === "none") {
          if (await this.verified(prior)) {
            this.state.unverified = null;
            await this.handleCompletedSwap(prior, now);
            transition = "completed";
          } else {
            this.state.unverified = { row: prior, seenAt: now };
            this.state.lastError =
              "ignored a re-pair .com reported: it could not be verified from this server's trusted keys";
            transition = "unverified";
          }
        }
      }
    }

    this.state.lastSeen = observed;
    await this.persist();
    return transition;
  }

  private async verified(row: RePairPendingRow): Promise<boolean> {
    return (
      (await verifyRePairSwap({
        row,
        username: this.deps.username,
        currentIrkPubHex: this._currentIrkPubHex,
        ...(this.deps.rotationAppliedSince ? { rotationAppliedSince: this.deps.rotationAppliedSince } : {}),
      })) !== null
    );
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
            serviceId: app.serviceId,
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
    await writeFileDurable(this.deps.statePath, JSON.stringify(this.state, null, 2));
  }
}

export function defaultRePairWatcherPath(dataDir: string): string {
  return join(dataDir, "repair-watcher.json");
}
