/**
 * Whether app containers can start in gVisor (docs/app-runtimes.md §5.1),
 * read by every `docker run` of an app or staging copy. Fails closed: once the
 * box has started setting gVisor up, an app waits for it, and doesn't start at
 * all without it. A process that never starts it (tests, tools) runs no
 * sandbox args.
 */
import { GVISOR_RUNTIME, type GvisorResult } from "./gvisor.js";

export type AppSandboxStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "ready"; version: string }
  | { state: "unavailable"; reason: string };

let current: Promise<GvisorResult> | null = null;
let settled: GvisorResult | null = null;
let egressFence: (() => { enforced: boolean; reason?: string }) | null = null;

/**
 * The egress gateway is part of an app's sandbox: an app without it would
 * reach the whole internet, past its owner-signed access list. Once the box
 * arms this (runtime.ts, unless FLAGSHIP_EGRESS=off), no app or staging copy
 * starts while the gateway is down, and the server page says why.
 */
export function setEgressFence(status: (() => { enforced: boolean; reason?: string }) | null): void {
  egressFence = status;
}

function egressRefusal(): string | null {
  const s = egressFence?.();
  if (!s || s.enforced) return null;
  return `its internet firewall isn't running: ${s.reason ?? "it hasn't started"}`;
}

/** Begin (or redo) the setup; `docker run` waits on it. */
export function startAppSandbox(setup: () => Promise<GvisorResult>): Promise<GvisorResult> {
  settled = null;
  const p = setup().catch((e: Error): GvisorResult => ({ ok: false, reason: e.message }));
  current = p;
  void p.then((r) => {
    if (current === p) settled = r;
  });
  return p;
}

/** Forget it (tests). */
export function resetAppSandbox(): void {
  current = null;
  settled = null;
  egressFence = null;
}

export function appSandboxStatus(): AppSandboxStatus {
  const gvisor = gvisorStatus();
  if (gvisor.state === "unavailable" || gvisor.state === "starting") return gvisor;
  const fence = egressRefusal();
  return fence ? { state: "unavailable", reason: fence } : gvisor;
}

function gvisorStatus(): AppSandboxStatus {
  if (!current) return { state: "off" };
  if (!settled) return { state: "starting" };
  return settled.ok ? { state: "ready", version: settled.version } : { state: "unavailable", reason: settled.reason };
}

/** The `docker run` args an app container needs; throws while its sandbox isn't usable here. */
export async function appSandboxRunArgs(): Promise<string[]> {
  const args: string[] = [];
  if (current) {
    const r = await current;
    if (!r.ok) throw new Error(`apps can't start on this server without their sandbox: ${r.reason}`);
    args.push(`--runtime=${GVISOR_RUNTIME}`);
  }
  const fence = egressRefusal();
  if (fence) throw new Error(`apps can't start on this server without their sandbox: ${fence}`);
  return args;
}

/**
 * Set it up at boot and keep retrying while it fails (a download that hit a
 * bad network, a dpkg lock); `onRecovered` restarts the apps that couldn't
 * start meanwhile.
 */
export function keepAppSandbox(opts: {
  setup: () => Promise<GvisorResult>;
  retryMs?: number;
  onRecovered?: () => void;
  log?: (m: string) => void;
}): { stop(): void } {
  const log = opts.log ?? (() => {});
  const retryMs = opts.retryMs ?? 10 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const attempt = (afterFailure: boolean) => {
    void startAppSandbox(opts.setup).then((r) => {
      if (stopped) return;
      if (r.ok) {
        log(`[app-sandbox] apps run in gVisor (${r.version})`);
        if (afterFailure) opts.onRecovered?.();
        return;
      }
      log(`[app-sandbox] apps can't start until gVisor works: ${r.reason}; retrying in ${Math.round(retryMs / 60_000)} min`);
      timer = setTimeout(() => attempt(true), retryMs);
      timer.unref?.();
    });
  };
  attempt(false);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
