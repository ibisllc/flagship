import { describe, expect, it } from "vitest";
import { revokeCurrentCert } from "../src/runtime.js";
import { CertManager } from "../src/certManager.js";

const CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIBliveCert=\n-----END CERTIFICATE-----\n";

class FakeIssuer {
  calls: { cert: string; reason?: number }[] = [];
  throwOnRevoke: Error | null = null;
  async revokeCertificate(certPem: string, reason?: number): Promise<void> {
    this.calls.push({ cert: certPem, reason });
    if (this.throwOnRevoke) throw this.throwOnRevoke;
  }
}

describe("revokeCurrentCert (runtime theft-response helper)", () => {
  it("revokes the installed leaf cert with default reason 1 (keyCompromise)", async () => {
    const certManager = new CertManager();
    certManager.install({ certPem: CERT_PEM, privateKeyPem: "k" }, Date.now() + 86_400_000);
    const issuer = new FakeIssuer();
    await revokeCurrentCert({ issuer, certManager });
    expect(issuer.calls).toHaveLength(1);
    expect(issuer.calls[0]!.cert).toBe(CERT_PEM);
    expect(issuer.calls[0]!.reason).toBe(1);
  });

  it("forwards an explicit reason code", async () => {
    const certManager = new CertManager();
    certManager.install({ certPem: CERT_PEM, privateKeyPem: "k" }, Date.now() + 86_400_000);
    const issuer = new FakeIssuer();
    await revokeCurrentCert({ issuer, certManager, reason: 4 });
    expect(issuer.calls[0]!.reason).toBe(4);
  });

  it("throws when no live cert is installed (never calls the issuer)", async () => {
    const certManager = new CertManager(); // nothing installed
    const issuer = new FakeIssuer();
    await expect(revokeCurrentCert({ issuer, certManager })).rejects.toThrow(/no live cert/i);
    expect(issuer.calls).toHaveLength(0);
  });

  it("surfaces an error thrown by the issuer", async () => {
    const certManager = new CertManager();
    certManager.install({ certPem: CERT_PEM, privateKeyPem: "k" }, Date.now() + 86_400_000);
    const issuer = new FakeIssuer();
    issuer.throwOnRevoke = new Error("urn:ietf:params:acme:error:unauthorized");
    await expect(revokeCurrentCert({ issuer, certManager })).rejects.toThrow(/unauthorized/);
  });
});

describe("CertManager.currentCertPem", () => {
  it("returns null before any cert is installed", () => {
    expect(new CertManager().currentCertPem()).toBeNull();
  });

  it("returns the installed leaf PEM", () => {
    const cm = new CertManager();
    cm.install({ certPem: CERT_PEM, privateKeyPem: "k" }, Date.now() + 1000);
    expect(cm.currentCertPem()).toBe(CERT_PEM);
  });
});
