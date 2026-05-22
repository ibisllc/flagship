import { describe, expect, it } from "vitest";
import { startCertRetryLoop } from "../src/runtime.js";
import { CertManager } from "../src/certManager.js";

const SANS = [
  "demoent1.flagship.services",
  "*.demoent1.flagship.services",
  "*.home.demoent1.flagship.services",
];
const DAY = 24 * 60 * 60_000;

/**
 * A deterministic setTimeout substitute. Callbacks are queued with their
 * requested delay; `flushAll()` drains them in FIFO order (synchronously
 * draining the queue including timers scheduled during draining). This
 * lets a test step the in-process ACME retry loop without real time.
 */
function makeFakeTimers() {
  const queue: Array<{ cb: () => void; ms: number }> = [];
  const setTimeoutImpl = (cb: () => void, ms: number) => {
    queue.push({ cb, ms });
    return queue.length;
  };
  async function flushAll(): Promise<number[]> {
    const delays: number[] = [];
    // Drain until quiescent. Each cb may be async (it kicks `void run()`),
    // so yield to the microtask queue between cbs so the next setTimeout
    // is registered before we pull it.
    let guard = 0;
    while (queue.length > 0) {
      if (guard++ > 1000) throw new Error("fake-timer flush did not converge");
      const next = queue.shift()!;
      delays.push(next.ms);
      next.cb();
      // let the async run() settle (issueAndInstall is awaited inside)
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    return delays;
  }
  return { setTimeoutImpl, flushAll, pending: () => queue.length };
}

class ScriptedIssuer {
  calls = 0;
  /** Per-attempt outcomes; clamps to the last entry. */
  constructor(
    private readonly script: Array<"ok" | "fail">,
    private readonly notAfter: number,
  ) {}
  async issue(): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }> {
    const idx = Math.min(this.calls, this.script.length - 1);
    this.calls += 1;
    if (this.script[idx] === "fail") throw new Error(`synthetic LE failure #${this.calls}`);
    return { certPem: "fresh-cert", privateKeyPem: "fresh-key", notAfter: this.notAfter };
  }
}

describe("startCertRetryLoop — in-process ACME retry (no crash)", () => {
  it("installs the cert on the first attempt and never schedules a retry", async () => {
    const timers = makeFakeTimers();
    const m = new CertManager();
    const now = 1_700_000_000_000;
    const issuer = new ScriptedIssuer(["ok"], now + 90 * DAY);
    const failures: Array<{ attempt: number; error: string }> = [];

    startCertRetryLoop({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.demoent1.flagship.services",
      sans: SANS,
      onCertAttemptFailed: (attempt, error) => failures.push({ attempt, error }),
      backoffMs: [10, 20, 30],
      setTimeoutImpl: timers.setTimeoutImpl,
    });

    const delays = await timers.flushAll();
    // Only the initial kick (delay 0) ran; no retry was scheduled.
    expect(delays).toEqual([0]);
    expect(issuer.calls).toBe(1);
    expect(failures).toHaveLength(0);
    expect(m.msUntilExpiry(now)).toBe(90 * DAY);
  });

  it("does NOT throw / exit on failure — backs off and retries until success", async () => {
    const timers = makeFakeTimers();
    const m = new CertManager();
    const now = 1_700_000_000_000;
    // Fail twice, then succeed.
    const issuer = new ScriptedIssuer(["fail", "fail", "ok"], now + 90 * DAY);
    const failures: Array<{ attempt: number; error: string }> = [];

    startCertRetryLoop({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.demoent1.flagship.services",
      sans: SANS,
      onCertAttemptFailed: (attempt, error) => failures.push({ attempt, error }),
      backoffMs: [10, 20, 30],
      setTimeoutImpl: timers.setTimeoutImpl,
    });

    const delays = await timers.flushAll();
    // Initial kick(0) → fail → retry@10 → fail → retry@20 → ok.
    expect(delays).toEqual([0, 10, 20]);
    expect(issuer.calls).toBe(3);
    // Two failures surfaced (for the daemon's `failed` phase), but the
    // loop never threw — it kept the box up and eventually installed.
    expect(failures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(failures[0]!.error).toMatch(/synthetic LE failure #1/);
    expect(m.msUntilExpiry(now)).toBe(90 * DAY);
  });

  it("clamps backoff to the last entry on repeated failure", async () => {
    const timers = makeFakeTimers();
    const m = new CertManager();
    const now = 1_700_000_000_000;
    // Fail 4 times then succeed; backoff has only 2 entries → clamp.
    const issuer = new ScriptedIssuer(["fail", "fail", "fail", "fail", "ok"], now + 90 * DAY);

    startCertRetryLoop({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.demoent1.flagship.services",
      sans: SANS,
      backoffMs: [10, 50],
      setTimeoutImpl: timers.setTimeoutImpl,
    });

    const delays = await timers.flushAll();
    // kick(0) → @10 → @50 → @50(clamp) → @50(clamp) → ok
    expect(delays).toEqual([0, 10, 50, 50, 50]);
    expect(issuer.calls).toBe(5);
  });

  it("stop() halts the loop — no further attempts after a pending retry is cancelled", async () => {
    const timers = makeFakeTimers();
    const m = new CertManager();
    const now = 1_700_000_000_000;
    const issuer = new ScriptedIssuer(["fail", "fail", "fail"], now + 90 * DAY);

    const handle = startCertRetryLoop({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.demoent1.flagship.services",
      sans: SANS,
      backoffMs: [10, 20, 30],
      setTimeoutImpl: timers.setTimeoutImpl,
    });

    // Run the first kick (which fails + schedules a retry), then stop.
    // Manually pull just the first queued cb.
    expect(timers.pending()).toBe(1);
    handle.stop();
    // Now flush everything; stop() short-circuits run() so no issuance.
    await timers.flushAll();
    expect(issuer.calls).toBe(0);
  });

  it("empty backoff schedule ⇒ a single attempt, no retry", async () => {
    const timers = makeFakeTimers();
    const m = new CertManager();
    const now = 1_700_000_000_000;
    const issuer = new ScriptedIssuer(["fail"], now + 90 * DAY);
    const failures: number[] = [];

    startCertRetryLoop({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.demoent1.flagship.services",
      sans: SANS,
      onCertAttemptFailed: (attempt) => failures.push(attempt),
      backoffMs: [],
      setTimeoutImpl: timers.setTimeoutImpl,
    });

    const delays = await timers.flushAll();
    expect(delays).toEqual([0]);
    expect(issuer.calls).toBe(1);
    expect(failures).toEqual([1]);
  });
});
