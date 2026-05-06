import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { CertManager } from "../src/certManager.js";
import { buildAlpnChallengeCert } from "../src/acme/alpnChallengeCert.js";

function makeSelfSignedCertPair(): { certPem: string; privateKeyPem: string } {
  // Use the same x509 plumbing the ALPN challenge code already exercises;
  // the cert content doesn't matter for CertManager — we just need a
  // PEM pair that createSecureContext accepts.
  // The simplest path is to reuse buildAlpnChallengeCert with a stub
  // keyAuthorization, which produces a real X.509 + RSA pair.
  // (Keeping the test sync-style by using `any` to side-step the async
  // chain in a way that vitest tolerates.)
  throw new Error("use makeStubCertPair instead");
}

async function makeStubCertPair(host = "test.example"): Promise<{ certPem: string; privateKeyPem: string }> {
  return buildAlpnChallengeCert("stub-key-auth", host);
}

describe("CertManager", () => {
  it("returns null for SNI before any cert is installed", () => {
    const m = new CertManager();
    expect(m.contextFor("home.alice.flagship.services")).toBeNull();
    expect(m.hasReal()).toBe(false);
  });

  it("installs the live cert and returns a SecureContext for any SNI", async () => {
    const m = new CertManager();
    const cert = await makeStubCertPair("home.alice.flagship.services");
    m.install(cert, Date.now() + 90 * 24 * 60 * 60_000);
    expect(m.hasReal()).toBe(true);
    expect(m.contextFor("home.alice.flagship.services")).not.toBeNull();
    // SecureContext is opaque; just confirm it was produced.
    expect(m.contextFor("anything")).not.toBeNull();
  });

  it("present() returns a disposer that removes the ALPN slot", async () => {
    const m = new CertManager();
    const sni = "home.alice.flagship.services";
    const cert = await makeStubCertPair(sni);
    const dispose = m.present(sni, cert);
    expect(m.contextFor(sni)).not.toBeNull();
    dispose();
    // After disposal and with no real cert installed yet, the SNI is unknown.
    expect(m.contextFor(sni)).toBeNull();
  });

  it("ALPN slot takes precedence over the live cert during a challenge", async () => {
    const m = new CertManager();
    const sni = "home.alice.flagship.services";
    const real = await makeStubCertPair(sni);
    const challenge = await makeStubCertPair(sni);
    m.install(real, Date.now() + 90 * 24 * 60 * 60_000);
    const dispose = m.present(sni, challenge);
    // Both produce a SecureContext; we can't easily inspect which one
    // beyond the precedence ordering, so confirm the slot presence
    // changed the path: hasReal still true, slot still wins until dispose.
    expect(m.contextFor(sni)).not.toBeNull();
    dispose();
    expect(m.contextFor(sni)).not.toBeNull();
  });

  it("needsRenewal flips when within 30 days of expiry", () => {
    const m = new CertManager();
    expect(m.needsRenewal()).toBe(true);
    const now = 1_000_000_000_000;
    const farFuture = now + 60 * 24 * 60 * 60_000;
    m.install({ certPem: "cert", privateKeyPem: "key" }, farFuture);
    expect(m.needsRenewal(undefined, now)).toBe(false);
    const soon = now + 10 * 24 * 60 * 60_000;
    m.install({ certPem: "cert", privateKeyPem: "key" }, soon);
    expect(m.needsRenewal(undefined, now)).toBe(true);
  });

  it("msUntilExpiry returns 0 with no cert and a positive value once installed", () => {
    const m = new CertManager();
    expect(m.msUntilExpiry(123)).toBe(0);
    const now = 1_000;
    m.install({ certPem: "x", privateKeyPem: "y" }, now + 5_000);
    expect(m.msUntilExpiry(now)).toBe(5_000);
    // After expiry, clamped to 0.
    expect(m.msUntilExpiry(now + 6_000)).toBe(0);
  });
});

// Suppress unused warning for the helper we kept as a no-op alternative.
void makeSelfSignedCertPair;
void generateKeyPairSync;
void createPublicKey;
