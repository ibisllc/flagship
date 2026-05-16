/**
 * CustomDomainCert envelope tests (#79B / Phase 4 C4.1c).
 *
 * This is the IRK-attested bundle the LEAD pod replicates to a user's
 * other pods over the sibling-sync channel. A receiving sibling MUST
 * be able to cryptographically reject anything a compromised peer
 * fabricates — these tests pin that property + the fresher-wins key
 * (issuedAt) + the PEM-binding (a swapped cert/key fails verify).
 */
import { describe, expect, it } from "vitest";
import {
  type CustomDomainCert,
  customDomainCertActiveAt,
  signCustomDomainCert,
  verifyCustomDomainCert,
} from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const otherUmk = { seed: new Uint8Array(32).fill(8) };

function base(overrides: Partial<CustomDomainCert> = {}): CustomDomainCert {
  return {
    username: "trent",
    fqdn: "shop.example.com",
    certPem: "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
    notAfter: 2_000_000_000_000,
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CustomDomainCert", () => {
  it("round-trips sign → verify under the user's IRK", async () => {
    const irk = deriveIRK(umk);
    const c = base();
    const sig = await signCustomDomainCert(c, irk);
    expect(await verifyCustomDomainCert(c, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a signature from a different IRK (compromised peer)", async () => {
    const irk = deriveIRK(umk);
    const evil = deriveIRK(otherUmk);
    const c = base();
    const sig = await signCustomDomainCert(c, evil);
    expect(await verifyCustomDomainCert(c, sig, irk.publicKey)).toBe(false);
  });

  it("binds the exact cert + key bytes (a swapped PEM fails verify)", async () => {
    const irk = deriveIRK(umk);
    const c = base();
    const sig = await signCustomDomainCert(c, irk);
    expect(
      await verifyCustomDomainCert(
        { ...c, certPem: c.certPem + "tampered" },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
    expect(
      await verifyCustomDomainCert(
        { ...c, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nEVIL\n-----END PRIVATE KEY-----\n" },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
  });

  it("binds fqdn (case-insensitively) + the validity window", async () => {
    const irk = deriveIRK(umk);
    const c = base();
    const sig = await signCustomDomainCert(c, irk);
    // fqdn is lower-cased in canonical bytes, so casing doesn't break it…
    expect(
      await verifyCustomDomainCert({ ...c, fqdn: "SHOP.EXAMPLE.COM" }, sig, irk.publicKey),
    ).toBe(true);
    // …but a different domain or a moved window does.
    expect(
      await verifyCustomDomainCert({ ...c, fqdn: "evil.example.com" }, sig, irk.publicKey),
    ).toBe(false);
    expect(
      await verifyCustomDomainCert({ ...c, notAfter: c.notAfter + 1 }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects structurally invalid bundles", async () => {
    const irk = deriveIRK(umk);
    await expect(signCustomDomainCert(base({ notAfter: 1, issuedAt: 2 }), irk)).rejects.toThrow();
    await expect(signCustomDomainCert(base({ fqdn: "a|b.example.com" }), irk)).rejects.toThrow();
    await expect(signCustomDomainCert(base({ certPem: "" }), irk)).rejects.toThrow();
  });

  it("customDomainCertActiveAt windows on [issuedAt, notAfter)", () => {
    const c = base();
    expect(customDomainCertActiveAt(c, c.issuedAt)).toBe(true);
    expect(customDomainCertActiveAt(c, c.issuedAt - 1)).toBe(false);
    expect(customDomainCertActiveAt(c, c.notAfter)).toBe(false);
    expect(customDomainCertActiveAt(c, c.notAfter - 1)).toBe(true);
  });
});
