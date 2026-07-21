// Per-cert RELAY-trust aggregation (lib/relayTrust.js) — the Layer-3 client
// half of maintainer-trust enforcement. Each box signs a
// `flagship/box-trust-status/v1` verdict with its STK; `.com` relays it on
// `/pods` as `pod.trustStatus`. The client re-verifies EACH signature under
// that pod's STK (`identityPubKey`) and aggregates the untrusted ones BY
// `failingCertHash` across ALL pods — one sliver line + one override per
// DISTINCT faulty relay authority. Signing here uses REAL WebCrypto Ed25519
// (the same verify path the module runs), so the verify is genuine, not mocked.

import { describe, expect, it, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

const RELAY_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/relayTrust.js"),
).href;
const TRUST_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/serverTrust.js"),
).href;
const SLIVER_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/trustSliver.js"),
).href;

async function loadRelay() {
  return import(RELAY_URL);
}
async function loadTrust() {
  return import(TRUST_URL);
}
async function loadSliver() {
  return import(SLIVER_URL);
}

const CERT_A = "aa".repeat(32); // 64 hex — one faulty relay authority
const CERT_B = "bb".repeat(32); // a distinct faulty relay authority

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** A box (STK) keypair via WebCrypto Ed25519; export the raw pub as the STK hex. */
async function boxKey() {
  const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, stkHex: bytesToHex(rawPub) };
}

/** Build a `/pods` entry with an STK-signed trustStatus over the module's own
 *  canonical bytes (so the signature genuinely verifies). */
async function signedPod(
  relay: {
    canonicalBoxTrustStatusBytes: (r: unknown) => Uint8Array;
  },
  serverDomain: string,
  report: Record<string, unknown>,
  tamper = false,
) {
  const { priv, stkHex } = await boxKey();
  const full = { serverDomain, nonce: "00", issuedAt: 1, lockedDown: false, ...report };
  const bytes = relay.canonicalBoxTrustStatusBytes(full);
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, priv, bytes));
  const signatureHex = tamper ? "00".repeat(64) : bytesToHex(sig);
  return { identityPubKey: stkHex, serverDomain, trustStatus: { report: full, signatureHex } };
}

describe("relayTrust — aggregate by failingCertHash across pods", () => {
  it("two pods, SAME failingCertHash → ONE entry spanning both servers", async () => {
    const relay = await loadRelay();
    const pods = [
      await signedPod(relay, "a.harry1.flagship.services", {
        relayVerdict: "untrusted",
        failingCertHash: CERT_A,
      }),
      await signedPod(relay, "b.harry1.flagship.services", {
        relayVerdict: "untrusted",
        failingCertHash: CERT_A,
      }),
    ];
    const out = await relay.aggregateRelayFailures(pods);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ certClass: "relay", certHash: CERT_A, serverCount: 2 });
    expect(out[0].servers).toEqual([
      "a.harry1.flagship.services",
      "b.harry1.flagship.services",
    ]);
    expect(out[0].overridden).toBe(false);
  });

  it("distinct failingCertHashes → distinct entries", async () => {
    const relay = await loadRelay();
    const pods = [
      await signedPod(relay, "a.x", { relayVerdict: "untrusted", failingCertHash: CERT_A }),
      await signedPod(relay, "b.x", { relayVerdict: "untrusted", failingCertHash: CERT_B }),
    ];
    const out = await relay.aggregateRelayFailures(pods);
    expect(out.map((e: { certHash: string }) => e.certHash).sort()).toEqual([CERT_A, CERT_B]);
  });

  it("a coveringExceptionCertHash on the wire marks the entry overridden (standing)", async () => {
    const relay = await loadRelay();
    // A covered box keeps reporting `untrusted` for the cert but ALSO names it
    // as covered — the override marker is driven from that relayed wire field.
    const pods = [
      await signedPod(relay, "a.x", {
        relayVerdict: "untrusted",
        failingCertHash: CERT_A,
        coveringExceptionCertHash: CERT_A,
      }),
    ];
    const out = await relay.aggregateRelayFailures(pods);
    expect(out).toHaveLength(1);
    expect(out[0].overridden).toBe(true);
  });

  it("DROPS a pod whose box-trust-status signature does not verify (unauthenticated)", async () => {
    const relay = await loadRelay();
    const pods = [
      await signedPod(relay, "a.x", { relayVerdict: "untrusted", failingCertHash: CERT_A }, true),
    ];
    expect(await relay.aggregateRelayFailures(pods)).toEqual([]);
  });

  it("ignores trusted / unknown verdicts and pods without a trustStatus", async () => {
    const relay = await loadRelay();
    const pods = [
      await signedPod(relay, "a.x", { relayVerdict: "trusted", failingCertHash: null }),
      await signedPod(relay, "b.x", { relayVerdict: "unknown", failingCertHash: null }),
      { identityPubKey: "cc".repeat(32), serverDomain: "c.x" }, // no trustStatus
    ];
    expect(await relay.aggregateRelayFailures(pods)).toEqual([]);
  });
});

describe("relayTrust — feeds the sliver WITHOUT the control-CA global halt", () => {
  beforeEach(async () => {
    const { serverTrust } = await loadTrust();
    serverTrust._reset();
  });

  it("aggregated relay failure → ONE sliver line; isServerTrusted stays true", async () => {
    const relay = await loadRelay();
    const { serverTrust } = await loadTrust();
    const sliver = await loadSliver();
    const pods = [
      await signedPod(relay, "a.x", {
        relayVerdict: "untrusted",
        failingCertHash: CERT_A,
        coveringExceptionCertHash: CERT_A,
      }),
      await signedPod(relay, "b.x", { relayVerdict: "untrusted", failingCertHash: CERT_A }),
    ];
    await relay.updateRelayTrustFromPods(pods);

    // The relay failure surfaces as ONE red sliver line (deduped by cert-hash),
    // carrying the affected-server count and the wire-driven "continuing" mark.
    const lines = sliver.trustSliverLines(serverTrust.failingCerts());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      certClass: "relay",
      certHash: CERT_A,
      serverCount: 2,
      overridden: true,
      label: `Relay certificate expired · ${CERT_A.slice(0, 8)}`,
    });

    // A relay-cert failure is a WARNING + override — NOT the control-CA global
    // halt. `.com` I/O must keep flowing (no control verdict was set).
    expect(serverTrust.isServerTrusted()).toBe(true);
  });
});
