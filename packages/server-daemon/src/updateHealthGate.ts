import {
  rebuildWorkspace,
  type PendingVerifyStore,
  type UpdateCommandRunner,
} from "./updateConsumer.js";

/**
 * Boot-time health gate + auto-rollback for the in-place self-update
 * (docs/server-update-mechanism.md §"Box-side update agent") — the
 * never-bricks guarantee.
 *
 * The update consumer stages new code (checkout + rebuild), writes a
 * pending-verify marker `{previousCommit, targetCommit, bootAttempts}` and
 * exits; systemd restarts the daemon into the new code. On EVERY boot this
 * gate runs first:
 *
 *   - no marker            → nothing staged, normal boot;
 *   - marker + attempts>N  → the new code failed N boots: ROLL BACK
 *                            (checkout previousCommit + rebuild + clear the
 *                            marker + restart) → `update-rolled-back`;
 *   - marker (attempts≤N)  → count this attempt (persisted BEFORE the health
 *                            wait, so a crash mid-boot still counts), then
 *                            wait for the boot to become HEALTHY — the tunnel
 *                            supervised-up AND a signed daemon-status
 *                            heartbeat fired (the same signals the hali
 *                            self-heal work anchors liveness on, injected via
 *                            `awaitHealthy` so tests are deterministic):
 *                              healthy   → COMMIT: clear the marker, report
 *                                          `update-applied` (targetCommit is
 *                                          simply the git HEAD now — nothing
 *                                          else to persist);
 *                              unhealthy → restart (systemd re-fires; the
 *                                          next boot's attempt count walks
 *                                          toward the rollback bound).
 *
 * A rollback that itself fails (checkout/rebuild error) KEEPS the marker and
 * restarts — the next boot retries the rollback rather than accepting
 * unverified code. Code swap only; /var/flagship keys/data are never touched.
 */

export const DEFAULT_MAX_BOOT_ATTEMPTS = 3;

export type UpdateReportEvent = "update-applied" | "update-rolled-back";

export interface RunUpdateBootGateOptions {
  pendingStore: PendingVerifyStore;
  /** The box's own code checkout (production: /opt/flagship). */
  repoPath: string;
  runner: UpdateCommandRunner;
  /**
   * Resolves true when THIS boot is healthy (tunnel supervised-up + a signed
   * heartbeat landed), false on timeout. Production wires
   * `buildUpdateHealthSignal().whenHealthy(...)`.
   */
  awaitHealthy: () => Promise<boolean>;
  /** Restart the daemon (production: process.exit(0) under systemd). */
  requestRestart: () => void;
  /** Boots the new code may fail before rollback. Default 3. */
  maxBootAttempts?: number;
  /** Surface the terminal verdict (phone/status channel; best-effort). */
  report?: (
    event: UpdateReportEvent,
    info: { previousCommit: string; targetCommit: string; bootAttempts: number },
  ) => void | Promise<void>;
  onLog?: (m: string) => void;
}

export type UpdateBootGateOutcome =
  | { action: "none" }
  | { action: "committed"; targetCommit: string }
  | { action: "retry-restart"; bootAttempts: number }
  | { action: "rolled-back"; previousCommit: string; targetCommit: string };

/** Run the boot gate. Never throws — returns an outcome. */
export async function runUpdateBootGate(
  opts: RunUpdateBootGateOptions,
): Promise<UpdateBootGateOutcome> {
  const log = opts.onLog ?? (() => {});
  const maxAttempts = opts.maxBootAttempts ?? DEFAULT_MAX_BOOT_ATTEMPTS;

  let marker;
  try {
    marker = await opts.pendingStore.read();
  } catch {
    marker = null;
  }
  if (!marker) return { action: "none" };

  const bootAttempts = marker.bootAttempts + 1;

  if (bootAttempts > maxAttempts) {
    // The new code burned its boot budget without ever verifying healthy —
    // roll back. The used-nonce marker (updateConsumer) makes the failed
    // order unreplayable after the rollback.
    log(
      `[self-update] ${marker.targetCommit} failed ${marker.bootAttempts} boot(s); ` +
        `ROLLING BACK to ${marker.previousCommit}`,
    );
    try {
      await opts.runner("git", ["-C", opts.repoPath, "checkout", marker.previousCommit]);
      await rebuildWorkspace(opts.runner, opts.repoPath, log);
    } catch (e) {
      // Keep the marker: the next boot retries the rollback rather than
      // silently running unverified code with no way back.
      log(`[self-update] rollback failed (${(e as Error).message}); will retry next boot`);
      opts.requestRestart();
      return { action: "retry-restart", bootAttempts: marker.bootAttempts };
    }
    try {
      await opts.pendingStore.clear();
    } catch (e) {
      log(`[self-update] could not clear marker after rollback: ${(e as Error).message}`);
    }
    try {
      await opts.report?.("update-rolled-back", {
        previousCommit: marker.previousCommit,
        targetCommit: marker.targetCommit,
        bootAttempts: marker.bootAttempts,
      });
    } catch {
      /* best-effort */
    }
    log(`[self-update] rolled back to ${marker.previousCommit}; restarting`);
    opts.requestRestart();
    return {
      action: "rolled-back",
      previousCommit: marker.previousCommit,
      targetCommit: marker.targetCommit,
    };
  }

  // Count this attempt BEFORE waiting on health, so a crash/hang during
  // bring-up still walks toward the rollback bound.
  try {
    await opts.pendingStore.write({ ...marker, bootAttempts });
  } catch (e) {
    log(`[self-update] could not persist boot attempt: ${(e as Error).message}`);
  }
  log(
    `[self-update] verifying staged update ${marker.targetCommit} ` +
      `(boot attempt ${bootAttempts}/${maxAttempts})`,
  );

  let healthy = false;
  try {
    healthy = await opts.awaitHealthy();
  } catch {
    healthy = false;
  }

  if (healthy) {
    try {
      await opts.pendingStore.clear();
    } catch (e) {
      log(`[self-update] could not clear marker after commit: ${(e as Error).message}`);
    }
    try {
      await opts.report?.("update-applied", {
        previousCommit: marker.previousCommit,
        targetCommit: marker.targetCommit,
        bootAttempts,
      });
    } catch {
      /* best-effort */
    }
    log(`[self-update] HEALTHY on ${marker.targetCommit} — update committed`);
    return { action: "committed", targetCommit: marker.targetCommit };
  }

  // Not healthy within the window: restart to retry (or, once the budget is
  // spent, to roll back on the next boot). This is what makes a wedged-but-
  // running bad build converge to rollback instead of sitting dead forever.
  log(
    `[self-update] boot did NOT verify healthy (attempt ${bootAttempts}/${maxAttempts}); restarting`,
  );
  opts.requestRestart();
  return { action: "retry-restart", bootAttempts };
}

// ──────────────────────────────────────────────────────────────────────
// Health signal latch (production wiring for `awaitHealthy`)
// ──────────────────────────────────────────────────────────────────────

export interface UpdateHealthSignal {
  /** The supervised tunnel client completed HELLO_ACK (runtime up). */
  markTunnelUp(): void;
  /** A signed daemon-status heartbeat fired (cert landed + report sent). */
  markHeartbeat(): void;
  /** Resolves true when BOTH signals have fired, false at the timeout. */
  whenHealthy(timeoutMs: number): Promise<boolean>;
}

/**
 * A tiny latch combining the two boot-health signals. index.ts marks
 * `markTunnelUp()` when startDaemonRuntime resolves (the supervised tunnel's
 * first HELLO_ACK) and `markHeartbeat()` from onCertIssued (which fires the
 * first signed daemon-status report). Timers are unref'd — the latch never
 * keeps the process alive.
 */
export function buildUpdateHealthSignal(): UpdateHealthSignal {
  let tunnelUp = false;
  let heartbeat = false;
  const waiters: Array<() => void> = [];
  function check(): void {
    if (tunnelUp && heartbeat) {
      for (const w of waiters.splice(0)) w();
    }
  }
  return {
    markTunnelUp() {
      tunnelUp = true;
      check();
    },
    markHeartbeat() {
      heartbeat = true;
      check();
    },
    whenHealthy(timeoutMs: number): Promise<boolean> {
      if (tunnelUp && heartbeat) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          resolve(false);
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        waiters.push(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}
