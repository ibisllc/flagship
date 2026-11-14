/**
 * Serializes the daemon's self-restarts with its consume-once claims.
 *
 * Several post-boot consumers (SWK, CGK, admin-root rotation, ...) exit(0) so
 * systemd restarts the daemon into the new state, while other claims (the
 * phone-deposited entitlement, the pairing order) read a `.com` deposit that is
 * deleted on first read and only then persist it. A restart that lands between
 * that read and the write loses the deposit for good: on a fresh hosted box the
 * CGK restart fired 19 ms after the entitlement deposit was consumed, so the
 * daemon came back with no entitlement and asked the owner for a second
 * approval.
 *
 * `guard` marks a claim as in flight; `request` defers the restart until no
 * guarded claim is running, and coalesces several requests into one restart.
 *
 * `settle` registers a check run once before the restart (after `settleMs`): the
 * other post-boot deposits a new box gets within seconds of each other (SWK, CGK)
 * are claimed in this run instead of each costing its own restart. Each restart
 * of a new box also dropped the certificate order in flight (Windows acceptance,
 * Failure 5: 3 to 5 restarts on first boot).
 */
export interface RestartCoordinator {
  guard<T>(claim: () => Promise<T>): Promise<T>;
  request(reason: string): void;
  settle(check: () => Promise<unknown>): void;
}

export function buildRestartCoordinator(opts: {
  exit: () => void;
  onLog?: (m: string) => void;
  /** Wait before the settle checks run (other deposits may still be on their way). Default 0. */
  settleMs?: number;
  /** Bound on the settle checks together. Default 30 s. */
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): RestartCoordinator {
  let inFlight = 0;
  const reasons: string[] = [];
  let exited = false;
  const checks: Array<() => Promise<unknown>> = [];
  let settling = false;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function runChecks(): Promise<void> {
    if ((opts.settleMs ?? 0) > 0) await sleep(opts.settleMs!);
    const all = Promise.allSettled(checks.map((c) => Promise.resolve().then(c)));
    await Promise.race([all, sleep(opts.settleTimeoutMs ?? 30_000)]);
  }

  function maybeExit(): void {
    if (exited || reasons.length === 0 || inFlight > 0) return;
    exited = true;
    opts.onLog?.(`[daemon] restarting: ${reasons.join("; ")}`);
    opts.exit();
  }

  async function guard<T>(claim: () => Promise<T>): Promise<T> {
    inFlight++;
    try {
      return await claim();
    } finally {
      inFlight--;
      maybeExit();
    }
  }

  return {
    guard,
    request(reason: string): void {
      if (!reasons.includes(reason)) reasons.push(reason);
      if (!settling && checks.length > 0) {
        settling = true;
        opts.onLog?.(`[daemon] restart requested (${reason}); first claiming what else has arrived`);
        void guard(runChecks).catch(() => {});
        return;
      }
      if (inFlight > 0) opts.onLog?.(`[daemon] restart deferred until in-flight claims finish (${reason})`);
      maybeExit();
    },
    settle(check: () => Promise<unknown>): void {
      checks.push(check);
    },
  };
}

/** The daemon's single coordinator (tests build their own). */
export const daemonRestarts: RestartCoordinator = buildRestartCoordinator({
  exit: () => process.exit(0),
  onLog: (m) => console.log(m),
  settleMs: 5_000,
});
