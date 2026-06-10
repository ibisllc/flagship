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
});
