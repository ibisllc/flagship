import acme from "acme-client";
import type { AcmeIssuer } from "../acme.js";
import { buildAlpnChallengeCert } from "./alpnChallengeCert.js";

export type LeEnvironment = "staging" | "production";

export interface AlpnChallengeServer {
  /**
   * Present the given (cert, key) when the ACME validator connects to
   * `sni:443` with ALPN protocol "acme-tls/1". Implementation lives in the
   * SNI router. Returns a disposer to remove the binding once the challenge
   * resolves.
   */
  present(sni: string, cert: { certPem: string; privateKeyPem: string }): () => void;
}

export interface DnsChallengeWriter {
  /**
   * Publish the given TXT record for `_acme-challenge.<name>`. The control
   * plane owns the `flagship.services` zone and writes via its DNS API; the
   * Flagship server tells the control plane what to publish.
   */
  publishTxt(host: string, value: string): Promise<() => Promise<void>>;
}

export interface LetsEncryptIssuerOptions {
  email: string;
  environment: LeEnvironment;
  /** PEM-encoded ACME account key. Persisted on the server alongside SWK-encrypted material. */
  accountKeyPem: string;
  /** Plug in the SNI router for HTTP/TLS-ALPN challenge presentation. */
  alpn: AlpnChallengeServer;
  /** Plug in the control plane bridge for DNS-01 (wildcards). */
  dns?: DnsChallengeWriter;
  /** Override directory URL for tests / private CAs. */
  directoryUrl?: string;
  /** Test seam: replace acme.Client. */
  clientFactory?: (cfg: { directoryUrl: string; accountKey: string }) => MinimalAcmeClient;
}

/** The subset of acme-client.Client we actually use, for substitutability in tests. */
export interface MinimalAcmeClient {
  createAccount(opts: { termsOfServiceAgreed: boolean; contact: string[] }): Promise<unknown>;
  createOrder(opts: { identifiers: { type: "dns"; value: string }[] }): Promise<AcmeOrder>;
  getAuthorizations(order: AcmeOrder): Promise<AcmeAuthorization[]>;
  getChallengeKeyAuthorization(challenge: AcmeChallenge): Promise<string>;
  completeChallenge(challenge: AcmeChallenge): Promise<unknown>;
  waitForValidStatus(challenge: AcmeChallenge): Promise<unknown>;
  finalizeOrder(order: AcmeOrder, csr: Buffer): Promise<AcmeOrder>;
  getCertificate(order: AcmeOrder): Promise<string>;
}

export interface AcmeChallenge {
  type: "tls-alpn-01" | "dns-01" | "http-01";
  url: string;
  status: string;
  token: string;
}

export interface AcmeAuthorization {
  identifier: { type: string; value: string };
  status: string;
  challenges: AcmeChallenge[];
}

export interface AcmeOrder {
  status: string;
  expires: string;
  identifiers: { type: string; value: string }[];
  authorizations: string[];
  finalize: string;
}

const DEFAULT_DIRECTORY: Record<LeEnvironment, string> = {
  staging: acme.directory.letsencrypt.staging,
  production: acme.directory.letsencrypt.production,
};

export class LetsEncryptIssuer implements AcmeIssuer {
  private readonly opts: LetsEncryptIssuerOptions;
  private accountReady = false;

  constructor(opts: LetsEncryptIssuerOptions) {
    this.opts = opts;
  }

  /** Lazily build the underlying acme-client (cheap; constructed per issuance). */
  private buildClient(): MinimalAcmeClient {
    const directoryUrl = this.opts.directoryUrl ?? DEFAULT_DIRECTORY[this.opts.environment];
    if (this.opts.clientFactory) {
      return this.opts.clientFactory({ directoryUrl, accountKey: this.opts.accountKeyPem });
    }
    return new acme.Client({
      directoryUrl,
      accountKey: this.opts.accountKeyPem,
    }) as unknown as MinimalAcmeClient;
  }

  async issue(
    names: string[],
  ): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }> {
    if (names.length === 0) throw new Error("issue() requires at least one name");
    const client = this.buildClient();

    if (!this.accountReady) {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${this.opts.email}`],
      });
      this.accountReady = true;
    }

    const order = await client.createOrder({
      identifiers: names.map((value) => ({ type: "dns", value })),
    });

    const authorizations = await client.getAuthorizations(order);
    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      for (const authz of authorizations) {
        const isWildcard = authz.identifier.value.startsWith("*.");
        const challenge = isWildcard
          ? authz.challenges.find((c) => c.type === "dns-01")
          : authz.challenges.find((c) => c.type === "tls-alpn-01") ??
            authz.challenges.find((c) => c.type === "dns-01");
        if (!challenge) {
          throw new Error(`no usable challenge for ${authz.identifier.value}`);
        }
        const keyAuth = await client.getChallengeKeyAuthorization(challenge);

        if (challenge.type === "tls-alpn-01") {
          const cert = await buildAlpnChallengeCert(keyAuth, authz.identifier.value);
          const dispose = this.opts.alpn.present(authz.identifier.value, cert);
          cleanups.push(() => dispose());
        } else if (challenge.type === "dns-01") {
          if (!this.opts.dns) throw new Error("dns-01 challenge required but no DNS writer configured");
          const host = authz.identifier.value.replace(/^\*\./, "");
          const dispose = await this.opts.dns.publishTxt(`_acme-challenge.${host}`, keyAuth);
          cleanups.push(() => dispose());
        } else {
          throw new Error(`unsupported challenge type ${challenge.type}`);
        }

        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      }

      const [csrKeyPem, csr] = await acme.crypto.createCsr({ commonName: names[0]!, altNames: names });
      const finalized = await client.finalizeOrder(order, csr);
      const certPem = await client.getCertificate(finalized);
      const notAfter = parseNotAfter(certPem);
      return { certPem, privateKeyPem: csrKeyPem.toString("utf8"), notAfter };
    } finally {
      for (const c of cleanups.reverse()) await c();
    }
  }

}

function parseNotAfter(certPem: string): number {
  const match = certPem.match(/-----BEGIN CERTIFICATE-----\n([\s\S]+?)\n-----END CERTIFICATE-----/);
  if (!match) return Date.now() + 90 * 24 * 60 * 60_000;
  try {
    const der = Buffer.from(match[1]!.replace(/\s+/g, ""), "base64");
    // Defer to acme-client's helper which does proper DER parsing.
    const info = (acme.crypto as unknown as { readCertificateInfo(buf: Buffer): { notAfter: Date } })
      .readCertificateInfo(der);
    return info.notAfter.getTime();
  } catch {
    return Date.now() + 90 * 24 * 60 * 60_000;
  }
}
