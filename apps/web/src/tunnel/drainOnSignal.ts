/**
 * Graceful shutdown for the `.services` relay. Fly sends `kill_signal` (fly.toml: SIGINT)
 * and kills the machine `kill_timeout` (30 s) later, so the grace must end well inside it:
 * the hub tells drain-v1 boxes to reconnect elsewhere, keeps serving their existing streams
 * for the grace, then everything closes. A second signal exits at once.
 */
export const DEFAULT_DRAIN_GRACE_MS = 20_000;

/*
 * Relay mesh (relay-mesh.md §10.4): a mesh relay's `drain` first marks it draining (`/api/health` 503, `load.draining`
 * to its peers) and sends each `mesh-v1` box a `retire` hint to the best other `full` relay, spread over the first
 * half of the grace (`MeshNode.beginDrain`); only the remaining `drain-v1` boxes get DRAIN_NOTICE. The signal handling
 * below is the same in both modes.
 */

export interface Drainable {
  drain(graceMs: number): Promise<void>;
  close(): Promise<void>;
}

export function drainOnSignal(
  target: Drainable,
  opts: {
    graceMs?: number;
    signals?: readonly NodeJS.Signals[];
    exit?: (code: number) => void;
    log?: (line: string) => void;
  } = {},
): () => void {
  const graceMs = opts.graceMs ?? DEFAULT_DRAIN_GRACE_MS;
  const signals = opts.signals ?? ["SIGINT", "SIGTERM"];
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  let started = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (started) {
      log(`[drain] second ${sig}, exiting now`);
      exit(1);
      return;
    }
    started = true;
    log(`[drain] ${sig}: draining tunnels for up to ${graceMs} ms`);
    void target
      .drain(graceMs)
      .then(() => target.close())
      .then(
        () => exit(0),
        (e: unknown) => {
          log(`[drain] shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
          exit(1);
        },
      );
  };
  for (const s of signals) process.on(s, onSignal);
  return () => {
    for (const s of signals) process.off(s, onSignal);
  };
}
