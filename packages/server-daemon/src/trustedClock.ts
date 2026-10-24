/**
 * The box's authenticated clock (architecture v2, pq-suites.md §17).
 *
 * At boot, and every few hours, the box asks `.com` for the time over a fresh nonce
 * (`POST /api/time`); the answer counts only when it is signed by a CA key the box's own baked
 * maintainer pin authorizes at that time (signedTime.ts). From the newest accepted answer the box
 * runs its monotonic clock forward. It keeps a floor, the latest authenticated time it has seen,
 * on its encrypted disk and mirrored to `/boot/flagship-time-floor` for the boot client, so its
 * clock never reads earlier than that, across restarts too.
 *
 * `now()` is what expiry checks use: never earlier than the floor or the authenticated estimate,
 * so setting the clock back cannot revive an expired lease, grant, binding or CA lease. A clock
 * that runs ahead only makes things expire sooner (fail closed). Without any answer yet (`.com`
 * unreachable at first boot) it is the system clock raised to the floor, and `status()` says so.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { verifySignedTime, type CaTrustChain } from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

export interface TrustedClockOptions {
  comBaseUrl: string;
  /** The box's baked-pin CA chain (releaseVerifier `caTrustChainFromFolder`). */
  chain: () => CaTrustChain | null;
  /** `<dataDir>/time-floor.json` on the encrypted disk. */
  floorPath: string;
  /** `/boot/flagship-time-floor`, for the boot client; null where the box has none. */
  bootFloorPath?: string | null;
  fetchImpl?: typeof fetch;
  systemNow?: () => number;
  monotonic?: () => number;
  log?: (m: string) => void;
}

export interface TrustedClockStatus {
  /** "signed": a verified answer from `.com` this run; "floor": none yet, raised to the floor; "system": neither. */
  source: "signed" | "floor" | "system";
  floorMs: number;
  /** How far the system clock is behind the authenticated time (ms, positive = behind). */
  skewMs: number | null;
  lastRefusal: string | null;
}

export class TrustedClock {
  private anchor: { timeMs: number; mono: number } | null = null;
  private floorMs = 0;
  private lastRefusal: string | null = null;
  private readonly sysNow: () => number;
  private readonly mono: () => number;

  constructor(private readonly opts: TrustedClockOptions) {
    this.sysNow = opts.systemNow ?? Date.now;
    this.mono = opts.monotonic ?? (() => performance.now());
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.floorPath, "utf8")) as { floorMs?: unknown };
      if (typeof raw.floorMs === "number" && Number.isSafeInteger(raw.floorMs) && raw.floorMs > 0) this.floorMs = raw.floorMs;
    } catch {
      /* no floor yet */
    }
  }

  /** The authenticated estimate, or null before any verified answer. */
  authenticatedNow(): number | null {
    return this.anchor ? this.anchor.timeMs + Math.max(0, Math.floor(this.mono() - this.anchor.mono)) : null;
  }

  /** For expiry checks: never earlier than the floor or the authenticated estimate. */
  now(): number {
    return Math.max(this.sysNow(), this.floorMs, this.authenticatedNow() ?? 0);
  }

  status(): TrustedClockStatus {
    const auth = this.authenticatedNow();
    return {
      source: auth !== null ? "signed" : this.floorMs > 0 ? "floor" : "system",
      floorMs: this.floorMs,
      skewMs: auth !== null ? auth - this.sysNow() : null,
      lastRefusal: this.lastRefusal,
    };
  }

  /** Ask `.com` once; true when an answer verified. Never throws. */
  async refresh(timeoutMs = 10_000): Promise<boolean> {
    const nonce = randomBytes(32).toString("hex");
    const f = this.opts.fetchImpl ?? fetch;
    let body: unknown;
    try {
      const r = await f(`${this.opts.comBaseUrl.replace(/\/+$/, "")}/api/time`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.json();
    } catch (e) {
      this.lastRefusal = `unreachable: ${(e as Error).message}`;
      return false;
    }
    const v = verifySignedTime(body, nonce, this.opts.chain());
    if (!v.ok) {
      this.lastRefusal = v.code;
      this.opts.log?.(`[time] refused the time from .com (${v.code})`);
      return false;
    }
    if (v.timeMs < this.floorMs) {
      // An authorized key signed a time before one already accepted: keep the floor.
      this.lastRefusal = "behind-floor";
      this.opts.log?.("[time] .com's signed time is behind the floor this box already holds; keeping the floor");
      return false;
    }
    this.anchor = { timeMs: v.timeMs, mono: this.mono() };
    this.lastRefusal = null;
    const skew = v.timeMs - this.sysNow();
    if (Math.abs(skew) > 5 * 60_000) this.opts.log?.(`[time] the system clock is ${Math.round(skew / 1000)} s off the authenticated time`);
    await this.persistFloor(v.timeMs);
    return true;
  }

  /** Raise the floor to the current authenticated estimate and write it out (e.g. every few hours). */
  async checkpoint(): Promise<void> {
    const t = this.authenticatedNow();
    if (t !== null) await this.persistFloor(t);
  }

  private async persistFloor(t: number): Promise<void> {
    if (t <= this.floorMs) return;
    this.floorMs = t;
    try {
      await writeFileDurable(this.opts.floorPath, `${JSON.stringify({ floorMs: t })}\n`);
    } catch (e) {
      this.opts.log?.(`[time] could not save the time floor (${(e as Error).message})`);
    }
    if (this.opts.bootFloorPath) {
      try {
        await writeFileDurable(this.opts.bootFloorPath, `${t}\n`, 0o644);
      } catch {
        /* /boot read-only or absent: the boot client keeps its own clock */
      }
    }
  }
}

/** The clock expiry checks read; set at boot, the system clock until then (and in tests). */
let current: TrustedClock | null = null;

export function setTrustedClock(c: TrustedClock | null): void {
  current = c;
}

export function trustedNow(): number {
  return current ? current.now() : Date.now();
}
