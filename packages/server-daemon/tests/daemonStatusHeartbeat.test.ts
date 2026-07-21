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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      sign: id,
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

  it("rides a SEPARATELY-SIGNED box-trust-status sibling when a snapshot is present", async () => {
    const id = makeKeypair(7);
    let captured: any = null;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await postDaemonStatus({
      serverDomain: "abc5.harry1.flagship.services",
      sign: id,
      controlPlaneBaseUrl: "https://flagshipserver.com/",
      cert: { certPem: DUMMY_PEM, privateKeyPem: "x" },
      certValidUntil: 1_800_000_000_000,
      appsServed: ["abc5.harry1.flagship.services"],
      trustStatus: {
        relayVerdict: "untrusted",
        lockedDown: false,
        failingCertHash: "ab".repeat(32),
        coveringExceptionCertHash: null,
      },
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    expect(captured.trustStatus).toBeTruthy();
    const bts = captured.trustStatus;
    expect(bts.report.serverDomain).toBe("abc5.harry1.flagship.services");
    expect(bts.report.relayVerdict).toBe("untrusted");
    expect(bts.report.failingCertHash).toBe("ab".repeat(32));
    // Its signature verifies under the box STK over the box-trust-status
    // canonical bytes — a DISTINCT signature from the daemon-status one.
    const btsCanonical = new TextEncoder().encode(
      [
        "flagship/box-trust-status/v1",
        bts.report.serverDomain,
        bts.report.relayVerdict,
        bts.report.lockedDown ? "1" : "0",
        bts.report.failingCertHash ?? "",
        bts.report.coveringExceptionCertHash ?? "",
        bts.report.nonce,
        String(bts.report.issuedAt),
      ].join("|"),
    );
    expect(
      ed.verify(hexToBytes(bts.signatureHex), btsCanonical, id.publicKey),
    ).toBe(true);
    expect(bts.signatureHex).not.toBe(captured.signature);
  });

  it("omits trustStatus when no snapshot is supplied (additive)", async () => {
    const id = makeKeypair(7);
    let captured: any = null;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await postDaemonStatus({
      serverDomain: "abc5.harry1.flagship.services",
      sign: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      cert: { certPem: DUMMY_PEM, privateKeyPem: "x" },
      certValidUntil: 1_800_000_000_000,
      appsServed: [],
      now: () => 1_700_000_000_000,
      fetchImpl,
    });
    expect(captured.trustStatus).toBeUndefined();
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
      sign: id,
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
        sign: id,
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
      sign: id,
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

/**
 * Self-healing: the heartbeat loop CANNOT die. A real box once sent exactly
 * ONE beat then went silent until a manual reboot; the loop must survive every
 * failure mode and keep beating on cadence — independent of the tunnel (it
 * POSTs straight to `.com`). `requestTimeoutMs: 0` disables the per-request
 * AbortSignal so the fake-timer clock only drives the beat cadence.
 */
describe("daemon-status heartbeat — loop resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cert = { certPem: DUMMY_PEM, privateKeyPem: "x" };

  it("a send that THROWS does not kill the loop — later scheduled beats still fire", async () => {
    const id = makeKeypair(21);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("network black hole");
    }) as unknown as typeof fetch;

    const hb = startDaemonStatusHeartbeat({
      serverDomain: "hali.harry.flagship.services",
      sign: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      intervalMs: 5 * 60_000,
      requestTimeoutMs: 0,
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    // First beat fires immediately on update (the "one beat" the box managed).
    hb.update(cert, 1_800_000_000_000, ["hali.harry.flagship.services"]);
    await Promise.resolve();
    expect(calls).toBe(1);

    // Every send throws — but the loop must keep ticking on cadence.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(4);

    hb.stop();
  });

  it("a readLeads() that THROWS does not kill the loop — beats keep posting", async () => {
    const id = makeKeypair(22);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const hb = startDaemonStatusHeartbeat({
      serverDomain: "hali.harry.flagship.services",
      sign: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      intervalMs: 5 * 60_000,
      requestTimeoutMs: 0,
      now: () => 1_700_000_000_000,
      // The gossip-loop read explodes on every beat.
      readLeads: () => {
        throw new Error("gossip loop exploded");
      },
      fetchImpl,
    });

    hb.update(cert, 1_800_000_000_000, ["hali.harry.flagship.services"]);
    await Promise.resolve();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(3);

    hb.stop();
  });

  it("keeps firing on cadence regardless of tunnel state (it POSTs .com directly)", async () => {
    const id = makeKeypair(23);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    // No tunnel is ever supplied — the heartbeat takes none. This proves
    // independence by construction; the cadence assertion proves it keeps
    // beating while a tunnel would be mid-reconnect.
    const hb = startDaemonStatusHeartbeat({
      serverDomain: "hali.harry.flagship.services",
      sign: id,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      intervalMs: 5 * 60_000,
      requestTimeoutMs: 0,
      now: () => 1_700_000_000_000,
      fetchImpl,
    });

    hb.update(cert, 1_800_000_000_000, []);
    await Promise.resolve();
    expect(calls).toBe(1);

    // Five intervals → five more beats, exactly one per interval.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(6);

    // stop() halts the loop: advancing further fires nothing more.
    hb.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(calls).toBe(6);
  });
});
