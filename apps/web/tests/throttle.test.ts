import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountThrottle,
  DEFAULT_THROTTLE_BYTES_PER_SEC,
  SourcePauser,
  overQuotaBytesPerSec,
} from "../src/tunnel/throttle.js";
import { UsageMeter } from "../src/tunnel/usageMeter.js";

const RATE = 32_000; // bytes/s
const CHUNK = 16 * 1024;

/**
 * Drive N sources that each send CHUNK-sized writes as fast as they're
 * allowed, honouring the pause the throttle asks for, for `seconds` of fake
 * time. Returns the bytes each source got through.
 */
async function pump(
  throttle: AccountThrottle,
  accounts: string[],
  seconds: number,
): Promise<number[]> {
  const sent = accounts.map(() => 0);
  const pausers = accounts.map(() => new SourcePauser(() => {}, () => {}));
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    for (let i = 0; i < accounts.length; i++) {
      if (pausers[i]!.paused) continue;
      sent[i]! += CHUNK;
      pausers[i]!.hold(throttle.charge(accounts[i]!, CHUNK));
    }
    await vi.advanceTimersByTimeAsync(10);
  }
  for (const p of pausers) p.dispose();
  return sent;
}

describe("AccountThrottle — per-account token bucket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets a burst through, then asks the source to wait for the debt to refill", () => {
    const t = new AccountThrottle(RATE);
    expect(t.charge("alice", RATE)).toBe(0); // the one-second burst
    expect(t.charge("alice", RATE / 2)).toBe(500); // half a second of debt
    vi.advanceTimersByTime(500);
    expect(t.charge("alice", 0)).toBe(0); // repaid
  });

  it("keeps a greedy source under the cap over time", async () => {
    const t = new AccountThrottle(RATE);
    const [bytes] = await pump(t, ["alice"], 10);
    // burst (1 s) + 10 s at the rate, plus at most one chunk in flight
    expect(bytes!).toBeLessThanOrEqual(RATE * 11 + CHUNK);
    expect(bytes!).toBeGreaterThan(RATE * 9);
  });

  it("two streams of one account share one bucket", async () => {
    const t = new AccountThrottle(RATE);
    const [a, b] = await pump(t, ["alice", "alice"], 10);
    expect(a! + b!).toBeLessThanOrEqual(RATE * 11 + 2 * CHUNK);
    expect(Math.abs(a! - b!)).toBeLessThanOrEqual(2 * CHUNK); // fair-ish split
  });

  it("another account is unaffected by a throttled one", async () => {
    const t = new AccountThrottle(RATE);
    const [alice, bob] = await pump(t, ["alice", "bob"], 10);
    expect(alice!).toBeLessThanOrEqual(RATE * 11 + CHUNK);
    expect(bob!).toBeGreaterThan(RATE * 9); // its own full allowance, not half
  });

  it("rejects a non-positive rate", () => {
    expect(() => new AccountThrottle(0)).toThrow();
  });
});

describe("SourcePauser", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pauses once, resumes after the hold, and extends to the latest deadline", () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const p = new SourcePauser(pause, resume);
    p.hold(0);
    expect(pause).not.toHaveBeenCalled();
    p.hold(100);
    p.hold(50); // shorter — ignored
    p.hold(300); // longer — extends
    expect(pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(299);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(p.paused).toBe(false);
  });

  it("dispose() on close mid-throttle leaks no timer and never resumes", () => {
    const resume = vi.fn();
    const p = new SourcePauser(() => {}, resume);
    p.hold(1000);
    expect(vi.getTimerCount()).toBe(1);
    p.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("UsageMeter — over quota means slower, not refused", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const verdict = (admit: boolean) =>
    (async () =>
      ({ ok: true, json: async () => ({ ok: true, results: [{ username: "alice", admit }] }) }) as unknown as Response) as unknown as typeof fetch;

  function meterWith(admit: boolean) {
    return new UsageMeter({ reportUrl: "https://x/api/usage/report", secret: "s", fetchImpl: verdict(admit), throttleBytesPerSec: RATE });
  }

  it("within quota: never delayed, and no bucket is created", async () => {
    const m = meterWith(true);
    m.add("alice", 1);
    await m.flush();
    for (let i = 0; i < 100; i++) expect(m.throttleDelayMs("alice", CHUNK)).toBe(0);
    expect(m.throttleDelayMs(null, CHUNK)).toBe(0);
  });

  it("over quota: delayed past the burst; un-throttled by the next admitting flush", async () => {
    const fetches = [verdict(false), verdict(true)];
    let n = 0;
    const m = new UsageMeter({
      reportUrl: "https://x/api/usage/report",
      secret: "s",
      fetchImpl: ((...a: Parameters<typeof fetch>) => fetches[n++]!(...a)) as typeof fetch,
      throttleBytesPerSec: RATE,
    });
    m.add("alice", 1);
    await m.flush(); // .com: over quota
    expect(m.admits("alice")).toBe(false);
    expect(m.throttleDelayMs("alice", RATE)).toBe(0); // burst
    expect(m.throttleDelayMs("alice", RATE)).toBe(1000);
    expect(m.throttleDelayMs("bob", RATE * 10)).toBe(0); // other accounts untouched

    m.add("alice", 1);
    await m.flush(); // .com: new month / upgraded
    expect(m.throttleDelayMs("alice", RATE * 10)).toBe(0);
    expect(m.blockedCount()).toBe(0);
  });
});

describe("overQuotaBytesPerSec (FLAGSHIP_OVER_QUOTA_KBPS)", () => {
  it("converts kbit/s and falls back to the default on anything unusable", () => {
    expect(overQuotaBytesPerSec("256")).toBe(32_000);
    expect(overQuotaBytesPerSec("1000")).toBe(125_000);
    for (const bad of [undefined, "", " ", "0", "-5", "fast"]) expect(overQuotaBytesPerSec(bad)).toBeUndefined();
    expect(DEFAULT_THROTTLE_BYTES_PER_SEC).toBe(32_000);
  });
});
