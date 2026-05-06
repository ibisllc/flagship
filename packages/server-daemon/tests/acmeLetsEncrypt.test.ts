import { describe, expect, it } from "vitest";
import {
  buildAlpnChallengeCert,
  _internal,
} from "../src/acme/alpnChallengeCert.js";
import {
  LetsEncryptIssuer,
  type AcmeAuthorization,
  type AcmeChallenge,
  type AcmeOrder,
  type AlpnChallengeServer,
  type DnsChallengeWriter,
  type MinimalAcmeClient,
} from "../src/acme/letsEncryptIssuer.js";
import { sha256 } from "@noble/hashes/sha256";

describe("ALPN-01 challenge cert (RFC 8737 §3)", () => {
  it("generates a self-signed cert with the SNI as a SAN and a critical acmeIdentifier extension", async () => {
    const sni = "harry.flagship.services";
    const keyAuth = "tok.thumb";
    const { certPem, privateKeyPem } = await buildAlpnChallengeCert(keyAuth, sni);

    expect(certPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    // Parse the cert with the same library to introspect extensions.
    const { X509Certificate } = await import("@peculiar/x509");
    const cert = new X509Certificate(certPem);

    const sanExt = cert.extensions.find((e) => e.type === "2.5.29.17");
    expect(sanExt).toBeDefined();

    const acmeExt = cert.extensions.find((e) => e.type === _internal.ACME_IDENTIFIER_OID);
    expect(acmeExt).toBeDefined();
    expect(acmeExt!.critical).toBe(true);

    // The ACME extension's value is a DER-encoded OCTET STRING wrapping the
    // SHA-256 of the keyAuthorization. Cheap structural check: last 32 bytes
    // are the digest.
    const der = new Uint8Array(acmeExt!.value);
    const expected = sha256(new TextEncoder().encode(keyAuth));
    const tail = der.slice(der.length - 32);
    expect(Array.from(tail)).toEqual(Array.from(expected));
  });

  it("digestKeyAuth is deterministic", () => {
    const a = _internal.digestKeyAuth("hello");
    const b = _internal.digestKeyAuth("hello");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("LetsEncryptIssuer — orchestration against a fake ACME client", () => {
  function makeFakeClient(): {
    client: MinimalAcmeClient;
    calls: string[];
    presented: { sni: string; cert: { certPem: string; privateKeyPem: string } }[];
    publishedTxt: { host: string; value: string }[];
  } {
    const calls: string[] = [];
    const presented: { sni: string; cert: { certPem: string; privateKeyPem: string } }[] = [];
    const publishedTxt: { host: string; value: string }[] = [];

    const order: AcmeOrder = {
      status: "pending",
      expires: new Date(Date.now() + 60_000).toISOString(),
      identifiers: [],
      authorizations: ["https://acme/authz/1"],
      finalize: "https://acme/finalize",
    };
    const alpnChallenge: AcmeChallenge = {
      type: "tls-alpn-01",
      url: "https://acme/chall/alpn",
      status: "pending",
      token: "tok-alpn",
    };
    const dnsChallenge: AcmeChallenge = {
      type: "dns-01",
      url: "https://acme/chall/dns",
      status: "pending",
      token: "tok-dns",
    };

    const client: MinimalAcmeClient = {
      async createAccount() {
        calls.push("createAccount");
        return {};
      },
      async createOrder(opts) {
        calls.push(`createOrder:${opts.identifiers.map((i) => i.value).join(",")}`);
        return { ...order, identifiers: opts.identifiers };
      },
      async getAuthorizations(o: AcmeOrder): Promise<AcmeAuthorization[]> {
        calls.push("getAuthorizations");
        return o.identifiers.map((id) => ({
          identifier: { type: id.type, value: id.value },
          status: "pending",
          challenges: [alpnChallenge, dnsChallenge],
        }));
      },
      async getChallengeKeyAuthorization(c) {
        calls.push(`getKeyAuth:${c.type}`);
        return `${c.token}.thumb`;
      },
      async completeChallenge(c) {
        calls.push(`completeChallenge:${c.type}`);
        return {};
      },
      async waitForValidStatus(c) {
        calls.push(`waitForValidStatus:${c.type}`);
        return {};
      },
      async finalizeOrder(o) {
        calls.push("finalizeOrder");
        return { ...o, status: "valid" };
      },
      async getCertificate() {
        calls.push("getCertificate");
        return [
          "-----BEGIN CERTIFICATE-----",
          "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
          "-----END CERTIFICATE-----",
          "",
        ].join("\n");
      },
    };

    const alpn: AlpnChallengeServer = {
      present(sni, cert) {
        presented.push({ sni, cert });
        return () => {
          calls.push(`alpnDispose:${sni}`);
        };
      },
    };
    const dns: DnsChallengeWriter = {
      async publishTxt(host, value) {
        publishedTxt.push({ host, value });
        return async () => {
          calls.push(`dnsDispose:${host}`);
        };
      },
    };

    const issuer = new LetsEncryptIssuer({
      email: "ops@flagshipserver.com",
      environment: "staging",
      accountKeyPem: "FAKEKEY",
      alpn,
      dns,
      clientFactory: () => client,
      // Tests run a fake ACME server, so no DNS propagation to wait for.
      dns01PropagationDelayMs: 0,
    });

    return { client, calls, presented, publishedTxt, issuer } as unknown as {
      client: MinimalAcmeClient;
      calls: string[];
      presented: { sni: string; cert: { certPem: string; privateKeyPem: string } }[];
      publishedTxt: { host: string; value: string }[];
      issuer: LetsEncryptIssuer;
    };
  }

  it("walks createAccount → createOrder → ALPN-01 → finalize for a non-wildcard name", async () => {
    const { issuer, calls, presented } = makeFakeClient();
    const out = await issuer.issue(["harry.flagship.services"]);
    expect(out.certPem).toMatch(/BEGIN CERTIFICATE/);
    expect(calls).toContain("createAccount");
    expect(calls).toContain("getKeyAuth:tls-alpn-01");
    expect(calls).toContain("completeChallenge:tls-alpn-01");
    expect(calls).toContain("alpnDispose:harry.flagship.services");
    expect(calls).toContain("finalizeOrder");
    expect(presented).toHaveLength(1);
    expect(presented[0]!.sni).toBe("harry.flagship.services");
    expect(presented[0]!.cert.certPem).toMatch(/BEGIN CERTIFICATE/);
  });

  it("uses DNS-01 (and strips the leading *.) for a wildcard name", async () => {
    const { issuer, calls, publishedTxt, presented } = makeFakeClient();
    await issuer.issue(["*.harry.flagship.services"]);
    expect(calls).toContain("getKeyAuth:dns-01");
    expect(calls).toContain("completeChallenge:dns-01");
    expect(publishedTxt[0]!.host).toBe("_acme-challenge.harry.flagship.services");
    expect(presented).toHaveLength(0);
  });

  it("only creates the ACME account once across multiple issuances", async () => {
    const { issuer, calls } = makeFakeClient();
    await issuer.issue(["a.flagship.services"]);
    await issuer.issue(["b.flagship.services"]);
    const accountCalls = calls.filter((c) => c === "createAccount");
    expect(accountCalls).toHaveLength(1);
  });

  it("rejects empty name lists", async () => {
    const { issuer } = makeFakeClient();
    await expect(issuer.issue([])).rejects.toThrow(/at least one name/);
  });
});
