import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { Bytes, ServerId } from "@flagship/protocol";

/**
 * TLS subkey: derived from SWK via HKDF; used to encrypt the per-server TLS
 * private key at rest. Separate from the chunk-encryption subkey so the
 * blast radius of either is independent.
 */
export function deriveTlsKey(swk: Bytes, serverId: ServerId): Bytes {
  return hkdf(
    sha256,
    swk,
    new TextEncoder().encode(serverId),
    new TextEncoder().encode("flagship.tls.v1"),
    32,
  );
}

export interface StoredCert {
  /** PEM-encoded certificate chain. */
  certPem: string;
  /** Encrypted PEM-encoded private key (ciphertext + nonce). */
  encryptedKey: { ciphertext: Bytes; nonce: Bytes };
  /** Subject names this cert covers. */
  names: string[];
  /** RFC 5280 NotAfter as ms unix timestamp. */
  notAfter: number;
  /** When we issued or renewed it (ms unix). */
  issuedAt: number;
}

/**
 * Cert + private-key store. Private keys are encrypted at rest with a TLS
 * subkey derived from SWK; the SWK lives only on this server, so a stolen
 * disk image is useless without first compromising boot.
 */
export class EncryptedCertStore {
  private readonly store = new Map<string, StoredCert>();
  private readonly tlsKey: Bytes;

  constructor(swk: Bytes, serverId: ServerId) {
    this.tlsKey = deriveTlsKey(swk, serverId);
  }

  put(name: string, certPem: string, privateKeyPem: string, names: string[], notAfter: number): void {
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ciphertext = gcm(this.tlsKey, nonce).encrypt(
      new TextEncoder().encode(privateKeyPem),
    );
    this.store.set(name, {
      certPem,
      encryptedKey: { ciphertext, nonce },
      names,
      notAfter,
      issuedAt: Date.now(),
    });
  }

  get(name: string): { certPem: string; privateKeyPem: string; notAfter: number } | undefined {
    const e = this.store.get(name);
    if (!e) return undefined;
    const decrypted = gcm(this.tlsKey, e.encryptedKey.nonce).decrypt(e.encryptedKey.ciphertext);
    return {
      certPem: e.certPem,
      privateKeyPem: new TextDecoder().decode(decrypted),
      notAfter: e.notAfter,
    };
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  needsRenewal(name: string, beforeMs: number = 60 * 24 * 60 * 60 * 1000): boolean {
    const e = this.store.get(name);
    if (!e) return true;
    return e.notAfter - Date.now() < beforeMs;
  }

  list(): Array<{ name: string; names: string[]; notAfter: number }> {
    return Array.from(this.store.entries()).map(([name, e]) => ({
      name,
      names: e.names,
      notAfter: e.notAfter,
    }));
  }
}

/**
 * Interface to the ACME client. The live implementation
 * (`./acme/letsEncryptIssuer.ts`) wraps `acme-client` for the protocol
 * state machine and `@peculiar/x509` to mint TLS-ALPN-01 challenge certs.
 */
export interface AcmeIssuer {
  /**
   * Obtain or renew a cert covering `names`. For wildcards (e.g.
   * `*.harry.flagship.services`), uses DNS-01 with the control plane
   * publishing the TXT record on the server's behalf. Otherwise prefers
   * TLS-ALPN-01.
   */
  issue(names: string[]): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }>;
}

/**
 * Compute the SHA-256 of a key authorization, the value placed in the
 * acmeIdentifier (1.3.6.1.5.5.7.1.31) extension of the TLS-ALPN-01 cert.
 * RFC 8737 §3.
 */
export function alpnChallengeDigest(keyAuthorization: string): Bytes {
  return sha256(new TextEncoder().encode(keyAuthorization));
}
