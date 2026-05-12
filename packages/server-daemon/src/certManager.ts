import { createSecureContext, type SecureContext } from "node:tls";
import type { AlpnChallengeServer } from "./acme/letsEncryptIssuer.js";

/**
 * Holds the live TLS cert + private key used by the daemon's local TLS
 * server, plus a temporary slot for TLS-ALPN-01 challenge certs that
 * Let's Encrypt's validator hits during issuance.
 *
 * The cert store on disk is `EncryptedCertStore` (see acme.ts); this class
 * is the in-memory presentation surface. We keep them separate so the
 * disk format and the SNI/ALPN serving plane evolve independently.
 *
 * SNICallback fires before ALPN selection, so during the (~5-second)
 * challenge window we cannot tell yet whether the connecting client is
 * the LE validator or a real browser. We resolve this in the same way
 * hello-daemon did: while a challenge cert is queued for an SNI, present
 * it. Real browser traffic during the challenge window also gets the
 * challenge cert and is rejected — fine, because we don't advertise the
 * server publicly until the cert is installed for the first time, and
 * subsequent renewals overlap by ~30 days so a brief mismatch on the
 * tail end is tolerable.
 */
export interface CertMaterial {
  certPem: string;
  privateKeyPem: string;
}

export class CertManager implements AlpnChallengeServer {
  private real: CertMaterial | null = null;
  private alpn = new Map<string, CertMaterial>();
  private notAfterMs = 0;

  /** Install (or replace) the live cert. */
  install(cert: CertMaterial, notAfterMs: number): void {
    this.real = cert;
    this.notAfterMs = notAfterMs;
  }

  /** Implements AlpnChallengeServer. Returns a disposer to remove the slot. */
  present(sni: string, cert: CertMaterial): () => void {
    const key = sni.toLowerCase();
    this.alpn.set(key, cert);
    return () => {
      this.alpn.delete(key);
    };
  }

  /** Returns null if no cert is loaded for this SNI. */
  contextFor(sni: string): SecureContext | null {
    const key = sni.toLowerCase();
    const slot = this.alpn.get(key);
    if (slot) {
      return createSecureContext({ cert: slot.certPem, key: slot.privateKeyPem });
    }
    if (!this.real) return null;
    return createSecureContext({ cert: this.real.certPem, key: this.real.privateKeyPem });
  }

  hasReal(): boolean {
    return this.real !== null;
  }

  /** Time until the live cert expires, in ms. Returns 0 if no cert is loaded. */
  msUntilExpiry(now = Date.now()): number {
    if (!this.real) return 0;
    return Math.max(0, this.notAfterMs - now);
  }

  /**
   * True if the cert is missing or has less than `windowMs` left until
   * expiry. Default window: 60 days. LE issues 90-day certs, so a
   * 60-day-remaining gate means "renew once the cert is ~30 days old".
   * Wide on purpose to tolerate daemons that sleep, travel, or sit
   * behind flaky residential ISPs for weeks at a time.
   */
  needsRenewal(windowMs = 60 * 24 * 60 * 60 * 1000, now = Date.now()): boolean {
    if (!this.real) return true;
    return this.notAfterMs - now < windowMs;
  }
}
