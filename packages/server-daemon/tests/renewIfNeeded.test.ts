import { describe, expect, it } from "vitest";
import { renewIfNeeded } from "../src/runtime.js";
import { CertManager } from "../src/certManager.js";

const SANS = ["home.alice.flagship.services", "*.home.alice.flagship.services"];
const DAY = 24 * 60 * 60_000;

class FakeIssuer {
  calls = 0;
  /** When ≥0, the next call resolves; when <0, the next call rejects. */
  nextOutcome: "ok" | "fail" = "ok";
  /** notAfter for the next successful issuance. */
  nextNotAfter = 0;
  async issue(_names: string[]): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }> {
    this.calls += 1;
    if (this.nextOutcome === "fail") {
      throw new Error("synthetic LE failure");
    }
    return { certPem: "fresh-cert", privateKeyPem: "fresh-key", notAfter: this.nextNotAfter };
  }
}

describe("renewIfNeeded", () => {
  it("does nothing when the cert isn't in the renewal window", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "c", privateKeyPem: "k" }, now + 60 * DAY);
    const issuer = new FakeIssuer();
    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.alice.flagship.services",
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
    });
    expect(r.renewed).toBe(false);
    expect(r.reason).toBe("not in renewal window");
    expect(issuer.calls).toBe(0);
  });

  it("renews + hot-swaps the live cert when within the renewal window", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 10 * DAY); // 10d left, inside 30d window
    const issuer = new FakeIssuer();
    issuer.nextNotAfter = now + 90 * DAY;

    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.alice.flagship.services",
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
    });
    expect(r.renewed).toBe(true);
    expect(issuer.calls).toBe(1);
    // CertManager now reflects the new cert
    expect(m.msUntilExpiry(now)).toBe(90 * DAY);
  });

  it("doesn't crash on issuer failure — reports error, leaves the old cert in place", async () => {
    const m = new CertManager();
    const now = 1_700_000_000_000;
    m.install({ certPem: "old", privateKeyPem: "k-old" }, now + 10 * DAY);
    const issuer = new FakeIssuer();
    issuer.nextOutcome = "fail";

    const r = await renewIfNeeded({
      issuer,
      certManager: m,
      store: null,
      serverFqdn: "home.alice.flagship.services",
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
    });
    expect(r.renewed).toBe(false);
    expect(r.error).toMatch(/synthetic/);
    // Old cert is still installed
    expect(m.msUntilExpiry(now)).toBe(10 * DAY);
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
      serverFqdn: "home.alice.flagship.services",
      sans: SANS,
      renewalWindowMs: 30 * DAY,
      now: () => now,
      onCertIssued: (_cert, notAfter, names) =>
        void issuedCalls.push({ names: [...names], notAfter }),
    });
    expect(issuedCalls).toEqual([{ names: SANS, notAfter: now + 90 * DAY }]);
  });
});
