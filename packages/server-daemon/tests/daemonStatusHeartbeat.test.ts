/**
 * Signed daemon-status heartbeat — populates `daemon_status` with REAL cert
 * info + a fresh heartbeat so /pods shows true current liveness (the proper
 * fix for the "never came online" regression). These tests cover:
 *   - one report is POSTed to /api/daemon-status with a signature that
 *     verifies under the box STK over canonical bytes byte-identical to
 *     @flagship/control-plane's `canonicalDaemonStatusReport`;
 *   - `update` fires immediately + carries the served names;
 *   - a network failure never throws (best-effort).
 */

import { describe, expect, it } from "vitest";
import { ed, type Keypair } from "@flagship/protocol";
import {
  postDaemonStatus,
  startDaemonStatusHeartbeat,
} from "../src/daemonStatusHeartbeat.js";

function makeKeypair(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Byte-identical mirror of control-plane's canonicalDaemonStatusReport.
function canonical(r: {
  serverDomain: string;
  certSha256: string | null;
  certValidUntil: number | null;
  certIssuer: string | null;
  appsServed: string[];
  nonce: string;
  issuedAt: number;
}): Uint8Array {
  const apps = r.appsServed.slice().sort().join(",");
  return new TextEncoder().encode(
    [
      "flagship/daemon-status/v1",
      r.serverDomain,
      r.certSha256 ?? "",
      String(r.certValidUntil ?? ""),
      r.certIssuer ?? "",
      apps,
      r.nonce,
      String(r.issuedAt),
    ].join("|"),
  );
}

const DUMMY_PEM = "-----BEGIN CERTIFICATE-----\nnotarealcert\n-----END CERTIFICATE-----\n";

describe("daemon-status heartbeat", () => {
  it("POSTs a signed report whose signature verifies over canonical bytes", async () => {
    const id = makeKeypair(7);
    let captured: { url: string; body: any } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await postDaemonStatus({
      serverDomain: "abc5.harry1.flagship.services",
      identity: id,
      controlPlaneBaseUrl: "https://flagshipserver.com/",
      cert: { certPem: DUMMY_PEM, privateKeyPem: "x" },
      certValidUntil: 1_800_000_000_000,
      appsServed: ["abc5.harry1.flagship.services"],
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    expect(captured).not.toBeNull();
    const { url, body } = captured!;
    expect(url).toBe("https://flagshipserver.com/api/daemon-status");
    expect(body.request.serverDomain).toBe("abc5.harry1.flagship.services");
    expect(body.request.certValidUntil).toBe(1_800_000_000_000);
    expect(body.request.issuedAt).toBe(1_700_000_000_000);
    // Dummy PEM can't be parsed → certSha256 degrades to null but the report
    // still goes out (liveness > cert details).
    expect(body.request.certSha256).toBeNull();

    const ok = ed.verify(
      hexToBytes(body.signature),
      canonical(body.request),
      id.publicKey,
    );
    expect(ok).toBe(true);
  });

  it("update() fires one report immediately with the served names", async () => {
    const id = makeKeypair(9);
    const calls: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const hb = startDaemonStatusHeartbeat({
      serverDomain: "home1.harry.flagship.services",
      identity: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      intervalMs: 60_000,
      now: () => 1_700_000_000_000,
      fetchImpl,
    });
    // No cert yet → no report.
    expect(calls).toHaveLength(0);
    hb.update({ certPem: DUMMY_PEM, privateKeyPem: "x" }, 1_800_000_000_000, [
      "home1.harry.flagship.services",
    ]);
    // Let the fire() microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    hb.stop();
    expect(calls).toHaveLength(1);
    expect(calls[0].request.appsServed).toEqual(["home1.harry.flagship.services"]);
  });

  it("a network failure never throws (best-effort)", async () => {
    const id = makeKeypair(3);
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      postDaemonStatus({
        serverDomain: "home1.harry.flagship.services",
        identity: id,
        controlPlaneBaseUrl: "https://flagshipserver.com",
        cert: { certPem: DUMMY_PEM, privateKeyPem: "x" },
        certValidUntil: 1_800_000_000_000,
        appsServed: [],
        now: () => 1_700_000_000_000,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  // Regression: node's X509Certificate.issuer is a NEWLINE-separated DN
  // ("C=US\nO=Lets Encrypt\nCN=R11"). The canonical-bytes guard rejects control
  // chars, so the RAW issuer made signDaemonStatusReport THROW — swallowed
  // silently by postDaemonStatus — so NO box ever posted a cert-bearing report
  // and daemon_status stayed empty (currentCert/signedStatus null on /pods).
  // A real EC cert with a multi-RDN issuer below; the report must now post with
  // a single-line issuer and a signature that verifies.
  const REAL_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBujCCAV+gAwIBAgIUH7WZFo6yv08iclpgG7yjjRty/HQwCgYIKoZIzj0EAwIw
MjELMAkGA1UEBhMCVVMxFTATBgNVBAoMDExldHMgRW5jcnlwdDEMMAoGA1UEAwwD
UjExMB4XDTI2MDYxNDEwMTkxNFoXDTI2MDYxNjEwMTkxNFowMjELMAkGA1UEBhMC
VVMxFTATBgNVBAoMDExldHMgRW5jcnlwdDEMMAoGA1UEAwwDUjExMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAETZZP/X6443EC6PCK98VPWsWbqyNpCXbHgNyOBitN
aS4CIEcSszwZayEn48TZzwtWgVFO7+qMD0N3CRKviqpE56NTMFEwHQYDVR0OBBYE
FOgQ2l9j8rJtmqcG7MqXSh3J0gK0MB8GA1UdIwQYMBaAFOgQ2l9j8rJtmqcG7MqX
Sh3J0gK0MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAKUnlyT6
QX9GtjTqyre/j4m2NMk2wuppfEtNfn9HeS10AiEAhIx7FvMKCNtle3kw/vbRLaPs
DI8uD7t+By9uA9EEqQM=
-----END CERTIFICATE-----
`;

  it("sanitizes a newline-separated cert issuer so the report actually POSTs", async () => {
    const id = makeKeypair(11);
    let captured: { url: string; body: any } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await postDaemonStatus({
      serverDomain: "frank.harry.flagship.services",
      identity: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      cert: { certPem: REAL_CERT_PEM, privateKeyPem: "x" },
      certValidUntil: 1_800_000_000_000,
      appsServed: [],
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    // The POST MUST have gone out — before the fix the newline issuer threw and
    // was swallowed, so `captured` would stay null.
    expect(captured).not.toBeNull();
    const issuer: string = captured!.body.request.certIssuer;
    expect(issuer).not.toMatch(/[\r\n|]/); // single safe line, no separator
    expect(issuer).toBe("C=US, O=Lets Encrypt, CN=R11");
    // A real cert ⇒ a real fingerprint was extracted too.
    expect(captured!.body.request.certSha256).toMatch(/^[0-9a-f]{64}$/);
    // The signature verifies over the canonical bytes of exactly what was sent.
    const ok = ed.verify(
      hexToBytes(captured!.body.signature),
      canonical(captured!.body.request),
      id.publicKey,
    );
    expect(ok).toBe(true);
  });
});
