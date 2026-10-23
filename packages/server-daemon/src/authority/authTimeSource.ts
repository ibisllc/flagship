/**
 * Fetches `.com`'s signed time and anchors the box's AuthClock to it (SECURITY-HARDENING-PLAN.md
 * 18.5, N07). Wall-clock time is never used for a privileged deadline; this is where trusted time
 * comes from. A failed or unverifiable answer changes nothing: the clock keeps counting forward
 * from its last anchor and, with none, stays unsynced (time-sensitive authority pauses).
 */
import { randomBytes } from "node:crypto";
import { parseAuthTime, verifyAuthTime, type CaTrustChain } from "@flagship/protocol";
import type { AuthClock } from "./authClock.js";

/** A round trip longer than this is not trusted to place the stamp. */
export const MAX_AUTH_TIME_RTT_MS = 10_000;

export interface AuthTimeSourceOptions {
  controlPlaneBaseUrl: string;
  clock: AuthClock;
  /** The CA trust chain this box ships with (re-read each time: a lease can be renewed). */
  chain: () => CaTrustChain | null;
  mono: () => number;
  fetchImpl?: typeof fetch;
  nonce?: () => string;
  log?: (m: string) => void;
}

export type AuthTimeResult = { ok: true; nowMs: number } | { ok: false; reason: string };

export class AuthTimeSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  lastOkAt: number | null = null;

  constructor(private readonly o: AuthTimeSourceOptions) {}

  async refresh(): Promise<AuthTimeResult> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const nonce = (this.o.nonce ?? (() => randomBytes(16).toString("hex")))();
    const started = this.o.mono();
    let body: { stamp?: unknown };
    try {
      const res = await fetchImpl(`${this.o.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/auth-time?nonce=${nonce}`, { method: "GET" });
      if (!res.ok) return this.fail(`http-${res.status}`);
      body = (await res.json()) as typeof body;
    } catch {
      return this.fail("unreachable");
    }
    const rtt = this.o.mono() - started;
    if (rtt > MAX_AUTH_TIME_RTT_MS) return this.fail("slow-answer");
    const stamp = parseAuthTime(body?.stamp);
    if (!stamp) return this.fail("malformed");
    const verdict = verifyAuthTime(stamp, nonce, this.o.chain());
    if (!verdict.ok) return this.fail(verdict.reason);
    // The stamp was made somewhere inside the round trip, so the earliest honest reading is its own
    // time; the clock lags real time by at most the round trip, which never extends a deadline by more.
    this.o.clock.observe(stamp.nowMs);
    this.lastOkAt = this.o.mono();
    return { ok: true, nowMs: stamp.nowMs };
  }

  start(everyMs = 60_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private fail(reason: string): AuthTimeResult {
    this.o.log?.(`[auth-time] not updated: ${reason}`);
    return { ok: false, reason };
  }
}
