// Is the private relay carrying proxy boxes' setup calls
// (docs/outbound-proxy.md §OHTTP)? Two signals: direct arrivals marked as
// relay fallbacks in the last day, and the daily synthetic probe through the
// relay. Either one means boxes are reaching Flagship directly, which the
// status page says and an operator is told about.

import { sendPrivately, type OhttpRelay } from "@flagship/protocol";
import type { RelayHealthStorage, RelayProbeRecord } from "@flagship/storage";
import { OHTTP_PROBE_PATH } from "./ohttpGateway.js";

export const RELAY_DOWN_MESSAGE = "Private relay down: servers are reaching Flagship directly";

export type PrivateRelayState = "ok" | "down" | "unconfigured";

export interface PrivateRelayStatus {
  state: PrivateRelayState;
  /** Shown on /status/ when state is down. */
  message?: string;
  /** Arrivals over the last two UTC days (today and yesterday). */
  arrivals: { ohttp: number; directFallback: number };
  lastProbe: RelayProbeRecord | null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function privateRelayStatus(
  storage: RelayHealthStorage,
  opts: { now: number; configured: boolean },
): Promise<PrivateRelayStatus> {
  const days = [utcDay(opts.now), utcDay(opts.now - 86_400_000)];
  const c = await storage.counts(days);
  const lastProbe = await storage.lastProbe();
  const arrivals = { ohttp: c.ohttp, directFallback: c["direct-fallback"] };
  const probeFailed = !!lastProbe && !lastProbe.ok && opts.now - lastProbe.at < 2 * 86_400_000;
  if (arrivals.directFallback > 0 || probeFailed) {
    return { state: "down", message: RELAY_DOWN_MESSAGE, arrivals, lastProbe };
  }
  return { state: opts.configured ? "ok" : "unconfigured", arrivals, lastProbe };
}

export interface RelayProbeDeps {
  storage: RelayHealthStorage;
  relay: OhttpRelay | null;
  apexHost: string;
  now: () => number;
  fetch?: Parameters<typeof sendPrivately>[1]["fetch"];
  /** Page a human (deduplicated by the caller). */
  notifyOperator?: (detail: string) => Promise<void>;
}

/** One synthetic request through the relay to our own probe path. Never falls back. */
export async function runRelayProbe(deps: RelayProbeDeps): Promise<RelayProbeRecord> {
  const at = deps.now();
  let rec: RelayProbeRecord;
  if (!deps.relay) {
    rec = { ok: false, at, detail: "no relay configured" };
  } else {
    try {
      const res = await sendPrivately(
        { url: `https://${deps.apexHost}${OHTTP_PROBE_PATH}`, method: "GET" },
        { relay: deps.relay, fallbackDirect: false, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      );
      rec = res.status === 200
        ? { ok: true, at, detail: "ok" }
        : { ok: false, at, detail: `gateway answered ${res.status}` };
    } catch (e) {
      rec = { ok: false, at, detail: (e as Error).message };
    }
  }
  // Without a relay there is nothing to page about; the status says "unconfigured".
  if (deps.relay) {
    await deps.storage.recordProbe(rec);
    if (!rec.ok) await deps.notifyOperator?.(rec.detail).catch(() => {});
  }
  return rec;
}
