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
 */
export interface RestartCoordinator {
  guard<T>(claim: () => Promise<T>): Promise<T>;
  request(reason: string): void;
}

export function buildRestartCoordinator(opts: {
  exit: () => void;
  onLog?: (m: string) => void;
}): RestartCoordinator {
  let inFlight = 0;
  const reasons: string[] = [];
  let exited = false;

  function maybeExit(): void {
    if (exited || reasons.length === 0 || inFlight > 0) return;
    exited = true;
    opts.onLog?.(`[daemon] restarting: ${reasons.join("; ")}`);
    opts.exit();
  }

  return {
    async guard<T>(claim: () => Promise<T>): Promise<T> {
      inFlight++;
      try {
        return await claim();
      } finally {
        inFlight--;
        maybeExit();
      }
    },
    request(reason: string): void {
      if (!reasons.includes(reason)) reasons.push(reason);
      if (inFlight > 0) opts.onLog?.(`[daemon] restart deferred until in-flight claims finish (${reason})`);
      maybeExit();
    },
  };
}

/** The daemon's single coordinator (tests build their own). */
export const daemonRestarts: RestartCoordinator = buildRestartCoordinator({
  exit: () => process.exit(0),
  onLog: (m) => console.log(m),
});
