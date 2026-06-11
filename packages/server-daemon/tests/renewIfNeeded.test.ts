import { describe, expect, it } from "vitest";
import {
  renewIfNeeded,
  renewalBackoffDelayMs,
  DEFAULT_RENEWAL_WINDOW_MS,
  RENEWAL_JITTER_BOUND_MS,
  RENEWAL_BACKOFF_BASE_MS,
  type RenewalBackoffState,
} from "../src/runtime.js";
import { CertManager } from "../src/certManager.js";

const SANS = ["home.alice.flagship.services", "*.home.alice.flagship.services"];
const DAY = 24 * 60 * 60_000;

class FakeIssuer {
  calls = 0;
  /** Names handed to the issuer on the most recent call. */
  lastNames: string[] | null = null;
  nextOutcome: "ok" | "fail" = "ok";
  nextNotAfter = 0;
  async issue(names: string[]): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }> {
    this.calls += 1;
    this.lastNames = names;
    if (this.nextOutcome === "fail") {
      throw new Error("synthetic LE failure");
    }
    return { certPem: "fresh-cert", privateKeyPem: "fresh-key", notAfter: this.nextNotAfter };
  }
}

const FQDN = "home.alice.flagship.services";

describe("renewIfNeeded — system-wide 30-day window + jitter", () => {
  it("the default window is 30 days (one issuance per ~60 on a 90-day cert)", () => {
    expect(DEFAULT_RENEWAL_WINDOW_MS).toBe(30 * DAY);
  });

  it("does nothing when more than the (jittered) window remains", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "c", privateKeyPem: "k" }, now + 60 * DAY);
    const issuer = new FakeIssuer();
    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0, // no jitter
    });
    expect(r.renewed).toBe(false);
    expect(r.reason).toBe("not in renewal window");
    expect(issuer.calls).toBe(0);
  });

  it("renews at exactly ≤30 days remaining with zero jitter", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    // 29 days left → inside the 30-day window even with no jitter.
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 29 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextNotAfter = now + 90 * DAY;

    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0,
    });
    expect(r.renewed).toBe(true);
    expect(issuer.calls).toBe(1);
    expect(m.msUntilExpiry(now)).toBe(90 * DAY);
  });

  it("issuance always requests the standard SANs (no short-lived/profile variation)", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 10 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextNotAfter = now + 90 * DAY;
    await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0,
    });
    // The issuer is fed exactly the box's A′ SANs — nothing selects a profile.
    expect(issuer.lastNames).toEqual(SANS);
  });

  it("jitter pulls the threshold IN deterministically under an injected RNG", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    // 28.5 days left: inside 30d, but a 3-day-max jitter at random()=1 pulls the
    // threshold to ~27 days, so the box must NOT yet renew.
    m.install({ certPem: "c", privateKeyPem: "k" }, now + 28.5 * DAY);
    const issuer = new FakeIssuer();

    const heldOff = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 1, // max jitter → threshold ≈ 30 − 3 = 27 days
    });
    expect(heldOff.renewed).toBe(false);
    expect(heldOff.reason).toBe("not in renewal window");
    expect(issuer.calls).toBe(0);

    // Same cert, but zero jitter → 28.5 < 30 → renews.
    issuer.nextNotAfter = now + 90 * DAY;
    const fired = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0,
    });
    expect(fired.renewed).toBe(true);
    expect(issuer.calls).toBe(1);
  });

  it("a maximally-jittered box still renews with ~27 days to spare (margin holds)", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "c", privateKeyPem: "k" }, now + 26 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextNotAfter = now + 90 * DAY;
    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 1, // threshold ≈ 27 days; 26 < 27 → fires
    });
    expect(r.renewed).toBe(true);
    expect(RENEWAL_JITTER_BOUND_MS).toBe(3 * DAY);
  });
});

describe("renewIfNeeded — failure backoff with jitter", () => {
  it("does not crash on issuer failure — reports error, leaves the old cert", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 10 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextOutcome = "fail";

    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0,
    });
    expect(r.renewed).toBe(false);
    expect(r.error).toMatch(/synthetic/);
    expect(m.msUntilExpiry(now)).toBe(10 * DAY);
  });

  it("a failure schedules a jittered backoff; the next tick before it is skipped, after it retries", async () => {
    const m = new CertManager();
    let t = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, t + 20 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextOutcome = "fail";
    const backoff: RenewalBackoffState = { failures: 0, nextAttemptAt: 0 };

    // First tick: fails, arms the backoff schedule.
    const first = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => t,
      random: () => 0.5,
      backoff,
    });
    expect(first.renewed).toBe(false);
    expect(first.error).toBeDefined();
    expect(backoff.failures).toBe(1);
    expect(backoff.nextAttemptAt).toBeGreaterThan(t);
    expect(issuer.calls).toBe(1);

    // A tick BEFORE nextAttemptAt is skipped (no new issuance attempt).
    t = backoff.nextAttemptAt - 1;
    const skipped = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => t,
      random: () => 0.5,
      backoff,
    });
    expect(skipped.renewed).toBe(false);
    expect(skipped.reason).toBe("backing off");
    expect(issuer.calls).toBe(1); // unchanged

    // A tick AFTER nextAttemptAt retries — this time it succeeds and resets.
    t = backoff.nextAttemptAt + 1;
    issuer.nextOutcome = "ok";
    issuer.nextNotAfter = t + 90 * DAY;
    const retried = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => t,
      random: () => 0.5,
      backoff,
    });
    expect(retried.renewed).toBe(true);
    expect(issuer.calls).toBe(2);
    expect(backoff.failures).toBe(0);
    expect(backoff.nextAttemptAt).toBe(0);
  });

  it("calls onCertIssued on successful renewal", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 10 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextNotAfter = now + 90 * DAY;
    const issuedCalls: Array<{ names: string[]; notAfter: number }> = [];

    await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: FQDN,
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      random: () => 0,
      onCertIssued: (_cert, notAfter, names) =>
        void issuedCalls.push({ names: [...names], notAfter }),
    });
    expect(issuedCalls).toEqual([{ names: SANS, notAfter: now + 90 * DAY }]);
  });
});

describe("renewalBackoffDelayMs", () => {
  it("grows exponentially with the failure count", () => {
    const noJitter = () => 0;
    const margin = 365 * DAY; // huge margin so the cap never bites
    const d1 = renewalBackoffDelayMs(1, margin, noJitter);
    const d2 = renewalBackoffDelayMs(2, margin, noJitter);
    const d3 = renewalBackoffDelayMs(3, margin, noJitter);
    expect(d1).toBe(RENEWAL_BACKOFF_BASE_MS); // 2^0
    expect(d2).toBe(RENEWAL_BACKOFF_BASE_MS * 2); // 2^1
    expect(d3).toBe(RENEWAL_BACKOFF_BASE_MS * 4); // 2^2
  });

  it("adds a 0..BASE jitter under the injected RNG", () => {
    const margin = 365 * DAY;
    const lo = renewalBackoffDelayMs(1, margin, () => 0);
    const hi = renewalBackoffDelayMs(1, margin, () => 1);
    expect(lo).toBe(RENEWAL_BACKOFF_BASE_MS);
    // random()=1 is clamped to <1, so the jitter approaches but never reaches BASE.
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(RENEWAL_BACKOFF_BASE_MS * 2);
  });

  it("caps the delay at half the remaining margin so a retry always fits before expiry", () => {
    // A tiny margin must clamp the (otherwise large) exponential delay.
    const margin = 4 * 60 * 60_000; // 4h left
    const d = renewalBackoffDelayMs(5, margin, () => 1);
    expect(d).toBeLessThanOrEqual(margin / 2);
    expect(d).toBeGreaterThan(0);
  });
});
