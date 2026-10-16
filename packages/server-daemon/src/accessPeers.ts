/**
 * Where an app's other servers are, for one list per app
 * (docs/service-access-gating.md, "One list per app").
 *
 * The account's servers and their liveness come from `.com`'s `/pods` (the
 * box's read token), their positions from the server order the box holds and
 * verified itself. Which of them run an app the box asks them directly (an
 * authenticated pull with this box's digest: 404 means the app isn't there),
 * so nothing about apps or members is asked of `.com`. The app's leader is the
 * first live server in the order that runs it (this box included); a server
 * that stops answering drops out at the next refresh, so the next one leads.
 */
import type { AccessPeers } from "./accessSync.js";

export interface PodView {
  serverDomain: string;
  identityPubKey: string;
  liveness?: string;
  revokedAt?: number | null;
}

export interface PodsPeersOptions {
  selfFqdn: string;
  /** The account's servers (`/pods` `pods`), or null when `.com` can't be reached. */
  fetchPods: () => Promise<PodView[] | null>;
  /** Position of a server (by STK) in the held server order, or null when unlisted. */
  rankOf: (stkHex: string) => number | null;
  /** The apps installed on this box. */
  apps: () => string[];
  /** Whether `peer` runs `serviceRef` (and answers right now). */
  probe: (peer: string, serviceRef: string) => Promise<boolean>;
  log?: (m: string) => void;
}

export interface PodsPeers extends AccessPeers {
  /** Re-read the servers and ask each which of this box's apps it runs. */
  refresh(): Promise<void>;
  start(everyMs?: number): void;
  stop(): void;
}

export function buildPodsPeers(opts: PodsPeersOptions): PodsPeers {
  const self = opts.selfFqdn.toLowerCase();
  let pods: PodView[] = [];
  /** serviceRef → other servers that run it, in server order */
  let runners = new Map<string, string[]>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const rankOfDomain = (domain: string): number => {
    const p = domain === self ? pods.find((x) => x.serverDomain.toLowerCase() === self) : pods.find((x) => x.serverDomain.toLowerCase() === domain);
    const r = p ? opts.rankOf(p.identityPubKey.toLowerCase()) : null;
    return r ?? Number.MAX_SAFE_INTEGER;
  };
  const byOrder = (a: string, b: string) => rankOfDomain(a) - rankOfDomain(b) || a.localeCompare(b);

  async function refresh(): Promise<void> {
    const got = await opts.fetchPods().catch(() => null);
    if (got) pods = got.filter((p) => !p.revokedAt);
    const others = pods
      .map((p) => p.serverDomain.toLowerCase())
      .filter((d) => d !== self && pods.find((p) => p.serverDomain.toLowerCase() === d)?.liveness !== "never");
    const next = new Map<string, string[]>();
    for (const ref of opts.apps()) {
      const answers = await Promise.all(others.map(async (d) => ((await opts.probe(d, ref).catch(() => false)) ? d : null)));
      next.set(ref, answers.filter((d): d is string => d !== null).sort(byOrder));
    }
    runners = next;
  }

  return {
    leaderFor(ref) {
      const list = [self, ...(runners.get(ref) ?? [])].sort(byOrder);
      return list[0] ?? null;
    },
    runners(ref) {
      return [...(runners.get(ref) ?? [])];
    },
    refresh,
    start(everyMs = 30_000) {
      if (timer) return;
      void refresh().catch(() => {});
      timer = setInterval(() => void refresh().catch((e) => opts.log?.(`[access-peers] ${String(e)}`)), everyMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
