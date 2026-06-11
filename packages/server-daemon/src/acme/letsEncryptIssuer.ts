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
  /**
   * Wait this long after publishing a DNS-01 TXT before notifying Let's
   * Encrypt to validate. Cloudflare DNS propagates fast (~few seconds)
   * but LE caches NXDOMAIN responses, so notifying too early causes the
   * very first lookup to land on a stale negative cache and fail the
   * challenge. Default 10s — empirically reliable on the CF→LE path.
   * Tests can override to 0 to keep them fast.
   */
  dns01PropagationDelayMs?: number;
  /**
   * Fine-grained issuance observability. The issuer calls this as it
   * walks the order so the daemon can push a named PHASE checkpoint per
   * step (`acme-order` → `dns01-publish-*` → `tlsalpn-served` →
   * `acme-validating`). Best-effort: errors thrown by the hook are
   * swallowed so observability never breaks issuance.
   */
  onPhase?: (phase: AcmeIssuancePhase) => void;
}

/**
 * Issuance sub-phases the issuer reports via `onPhase`. Mirrors
 * `@flagship/protocol` `ACME_PROVISION_SUBPHASES` so the daemon can map
 * them straight onto signed ProvisionEvent phases. Kept as a local
 * string-union (not an import) so this package has no protocol dep just
 * for the names.
 */
export type AcmeIssuancePhase =
  | "acme-order"
  | "dns01-publish-attempt"
  | "dns01-publish-ok"
  | "dns01-propagation-wait"
  | "tlsalpn-served"
  | "acme-validating";

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
  /**
   * RFC 8555 §7.6 certificate revocation. Authorized by the ACME account
   * key the client already holds (no separate authorization step). `reason`
   * is an RFC 5280 CRL reason code (1 = keyCompromise).
   */
  revokeCertificate(cert: string, opts?: { reason?: number }): Promise<void>;
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
  /** Built once and reused across in-process retries — see issue(). */
  private client?: MinimalAcmeClient;

  constructor(opts: LetsEncryptIssuerOptions) {
    this.opts = opts;
  }

  /** Build the underlying acme-client. Cached on `this.client` after the
   *  first issue() so the registered account survives in-process retries. */
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
    const reportPhase = (p: AcmeIssuancePhase) => {
      try {
        this.opts.onPhase?.(p);
      } catch {
        // observability is best-effort; never break issuance
      }
    };
    // Reuse ONE client across in-process retries. buildClient() makes a
    // FRESH acme-client with no registered account; the cached
    // `accountReady` flag would then skip createAccount, and the order
    // fails with "No account URL found, register account first" on every
    // retry after the first. Caching the client keeps the registered
    // account aligned with the flag.
    this.client ??= this.buildClient();
    const client = this.client;

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
    reportPhase("acme-order");
    const cleanups: Array<() => Promise<void> | void> = [];

    const dns01PropagationDelayMs = this.opts.dns01PropagationDelayMs ?? 10_000;

    try {
      // Two-pass walk. PASS 1 sets up ALL challenges (publishes every
      // DNS-01 TXT, presents every TLS-ALPN-01 cert) BEFORE asking LE to
      // validate any of them. This is the critical ordering fix: the old
      // single-pass loop did setup→complete→wait per authz, so when the
      // FIRST authz (the apex name, validated via TLS-ALPN-01)
      // failed validation, the loop threw and the order aborted BEFORE
      // the later wildcard authorizations ever published their DNS-01
      // TXT records. The TXT therefore never landed. Publishing all
      // challenges up front means the TXT is written regardless of the
      // TLS-ALPN-01 outcome, and gives the DNS-01 records the maximum
      // head start to propagate while the other challenges are set up.
      interface PreparedChallenge {
        challenge: AcmeChallenge;
        identifier: string;
        usedDns01: boolean;
      }
      const prepared: PreparedChallenge[] = [];
      let anyDns01 = false;
      for (const authz of authorizations) {
        const isWildcard = authz.identifier.value.startsWith("*.");
        // Prefer DNS-01 for EVERY name (wildcard and non-wildcard alike)
        // whenever a DNS writer is configured — which it always is on the
        // production demo path via the control-plane bridge. The
        // non-wildcard SAN (the box apex `<server>.<user>.flagship.services`)
        // used to take TLS-ALPN-01, which requires
        // Let's Encrypt to reach the daemon over the Fly SNI-passthrough
        // chain. That leg fails on the demo path ("Error getting
        // validation data"), so the whole order never validated. DNS-01
        // validates entirely over the Cloudflare zone we control and is
        // already proven working for the wildcards, so routing the
        // non-wildcard authorizations through it too makes issuance depend
        // only on the path that works. Wildcards have no TLS-ALPN-01
        // option, so they were always DNS-01. TLS-ALPN-01 remains the
        // fallback for non-wildcards only when no DNS writer is available.
        const challenge = this.opts.dns
          ? authz.challenges.find((c) => c.type === "dns-01") ??
            (isWildcard ? undefined : authz.challenges.find((c) => c.type === "tls-alpn-01"))
          : isWildcard
            ? authz.challenges.find((c) => c.type === "dns-01")
            : authz.challenges.find((c) => c.type === "tls-alpn-01") ??
              authz.challenges.find((c) => c.type === "dns-01");
        if (!challenge) {
          throw new Error(`no usable challenge for ${authz.identifier.value}`);
        }
        const keyAuth = await client.getChallengeKeyAuthorization(challenge);

        let usedDns01 = false;
        if (challenge.type === "tls-alpn-01") {
          const cert = await buildAlpnChallengeCert(keyAuth, authz.identifier.value);
          const dispose = this.opts.alpn.present(authz.identifier.value, cert);
          cleanups.push(() => dispose());
          reportPhase("tlsalpn-served");
        } else if (challenge.type === "dns-01") {
          if (!this.opts.dns) throw new Error("dns-01 challenge required but no DNS writer configured");
          const host = authz.identifier.value.replace(/^\*\./, "");
          reportPhase("dns01-publish-attempt");
          const dispose = await this.opts.dns.publishTxt(`_acme-challenge.${host}`, keyAuth);
          cleanups.push(() => dispose());
          reportPhase("dns01-publish-ok");
          usedDns01 = true;
          anyDns01 = true;
        } else {
          throw new Error(`unsupported challenge type ${challenge.type}`);
        }
        prepared.push({ challenge, identifier: authz.identifier.value, usedDns01 });
      }

      // PASS 1.5 — wait once for DNS-01 propagation AFTER all TXT records
      // are published. LE caches negative (NXDOMAIN) responses, so a
      // too-fast lookup pins the stale cache until the SOA TTL expires;
      // we wait so the very first LE lookup hits the live record. One
      // shared wait covers every DNS-01 challenge in the order.
      if (anyDns01 && dns01PropagationDelayMs > 0) {
        reportPhase("dns01-propagation-wait");
        await new Promise((r) => setTimeout(r, dns01PropagationDelayMs));
      }

      // PASS 2 — now tell LE to validate every challenge. A failure here
      // (e.g. TLS-ALPN-01 unreachable) still leaves all the DNS-01 TXT
      // records published, so the next in-process retry's order finds
      // them already propagated.
      reportPhase("acme-validating");
      for (const { challenge } of prepared) {
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

  /**
   * Revoke a previously-issued leaf cert (RFC 8555 §7.6), authorized by the
   * ACME ACCOUNT key this issuer already holds — the same account that
   * issued the cert. `reason` is an RFC 5280 CRL reason code; default 1
   * (keyCompromise), the correct reason for a STOLEN server whose cert
   * private key is now exposed.
   *
   * BLAST RADIUS (cert model A′): the box's own cert is per-box
   * (`[<server>.<user>, *.<server>.<user>]`, box-local key), so revoking it
   * affects only the stolen box. A stolen box may ALSO have held a shared
   * tier-2 service cert (`<service>.<user>`); for that one the multi-box flow
   * MUST re-mint for the SURVIVING boxes FIRST, let them cut over, and only
   * THEN revoke — revoke-before-re-mint would black-hole the survivors until
   * their next renewal. This method is the single-daemon capability; the
   * cross-box orchestration lives above it and needs a live 2-box exercise
   * to validate.
   */
  async revokeCertificate(certPem: string, reason = 1): Promise<void> {
    // Build/reuse the account-key-authorized client. Mirrors issue(): the
    // account that minted the cert is the one authorized to revoke it, so
    // ensure it's registered before calling through.
    this.client ??= this.buildClient();
    const client = this.client;
    if (!this.accountReady) {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${this.opts.email}`],
      });
      this.accountReady = true;
    }
    await client.revokeCertificate(certPem, { reason });
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
