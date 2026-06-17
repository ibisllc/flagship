/**
 * RelayTrustVerifier — the box-side OBSERVE verifier driven off HELLO_ACK
 * (docs/maintainer-trust-enforcement.md, task #5). Builds a REAL maintainer
 * chain via verifyMandateChainFromPin (served through a mocked
 * GET /api/maintainer-blessing), runs shouldRelayThroughHub, and checks the
 * hubSig proof-of-possession over the box's HELLO nonce.
 *
 * Every case asserts that OBSERVE never refuses — the verifier only ever
 * computes + logs a verdict; relaying is the caller's concern (enforcement
 * lives in relayLockdown.ts behind the flag).
 */
import { describe, expect, it, vi } from "vitest";
import {
  generateKeypair,
  mandatePinHash,
  signCaEndorsement,
  signMandate,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { ed, signServiceBlessing, type Keypair } from "@flagship/protocol";
import { RelayTrustVerifier } from "../src/relayTrustVerifier.js";

const ISO_MANDATE_FROM = "2026-05-01T00:00:00.000Z";
const ISO_MANDATE_TO = "2026-11-01T00:00:00.000Z";
const ISO_LEASE_FROM = "2026-05-15T00:00:00.000Z";
const ISO_LEASE_TO = "2026-07-15T00:00:00.000Z";
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
const DAY = 86400;

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function protocolKeypair(m: { privKey: string; pubKey: string }): Keypair {
  return { privateKey: hexToBytes(m.privKey), publicKey: hexToBytes(m.pubKey) };
}

const authority = kp(7);
const genesis: Mandate = signMandate(
  {
    kind: "Mandate",
    version: 1,
    mandateId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
    track: "ca",
    holder: authority.pubKey,
    issuedAt: ISO_MANDATE_FROM,
    expiresAt: ISO_MANDATE_TO,
    successors: [authority.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * DAY,
    defaultDurationSeconds: 180 * DAY,
    signedBy: authority.pubKey,
  },
  [{ privKey: authority.privKey }],
);
const PIN = mandatePinHash(genesis);
const hotCaKey = kp(0xca);

function endorsement(caPubkey: string): CaEndorsement {
  return signCaEndorsement(
    {
      kind: "CaEndorsement",
      version: 1,
      endorsementId: "ce000000-0000-4000-8000-000000000001",
      track: "ca",
      caPubkey,
      scope: "flagship/directory-attestation",
      notBefore: ISO_LEASE_FROM,
      notAfter: ISO_LEASE_TO,
      issuedAt: ISO_LEASE_FROM,
      signedBy: authority.pubKey,
    },
    [{ privKey: authority.privKey }],
  );
}

// A real hub keypair (the .services self-key).
const hubPriv = ed.utils.randomPrivateKey();
const hubPub = ed.getPublicKey(hubPriv);
const hubPubHex = Buffer.from(hubPub).toString("hex");

function mintBlessing(issuedAt = NOW - 1000, ttlMs = 26 * 60 * 60_000) {
  return signServiceBlessing(
    {
      hubKeyPub: hubPubHex,
      hubHost: "flagship.services",
      nonce: "n1",
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    },
    protocolKeypair(hotCaKey),
  );
}

function chainMaterialFetch(caKey = hotCaKey.pubKey): typeof fetch {
  return (async (url: string | URL | Request) => {
    expect(String(url)).toContain("/api/maintainer-blessing");
    return new Response(
      JSON.stringify({ mandates: [genesis], caEndorsements: [endorsement(caKey)] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function nonceAndSig(): { nonce: Uint8Array; sig: string } {
  const nonce = new Uint8Array(32).fill(9);
  const sig = Buffer.from(ed.sign(nonce, hubPriv)).toString("hex");
  return { nonce, sig };
}

describe("RelayTrustVerifier (OBSERVE)", () => {
  it("verifies a good blessing + hubSig through the real chain", async () => {
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: chainMaterialFetch(),
      now: () => NOW,
      log: () => {},
    });
    const { nonce, sig } = nonceAndSig();
    const verdict = await v.verify(mintBlessing(), sig, nonce);
    expect(verdict).toEqual({ verified: true, reason: "ok", hubKeyPub: hubPubHex });
  });

  it("verified=false when the blessing chains but the hubSig is wrong (replay defense)", async () => {
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: chainMaterialFetch(),
      now: () => NOW,
      log: () => {},
    });
    const nonce = new Uint8Array(32).fill(9);
    // signature over a DIFFERENT nonce — a MITM that replayed an observed
    // blessing can't produce a hubSig over THIS box's fresh nonce.
    const wrongSig = Buffer.from(ed.sign(new Uint8Array(32).fill(1), hubPriv)).toString("hex");
    const verdict = await v.verify(mintBlessing(), wrongSig, nonce);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe("hubsig-mismatch");
  });

  it("verified=false (hubsig-missing) when no hubSig is presented", async () => {
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: chainMaterialFetch(),
      now: () => NOW,
      log: () => {},
    });
    const { nonce } = nonceAndSig();
    const verdict = await v.verify(mintBlessing(), undefined, nonce);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe("hubsig-missing");
  });

  it("verified=false when the blessing is signed by an unauthorized key", async () => {
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      // endorse a DIFFERENT hot key than the one that signed the blessing
      fetchImpl: chainMaterialFetch(kp(0xee).pubKey),
      now: () => NOW,
      log: () => {},
    });
    const { nonce, sig } = nonceAndSig();
    const verdict = await v.verify(mintBlessing(), sig, nonce);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe("signature-unverified");
  });

  it("verified=undefined (no verdict) on a chain-fetch error — never bricks", async () => {
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      now: () => NOW,
      log: () => {},
    });
    const { nonce, sig } = nonceAndSig();
    const verdict = await v.verify(mintBlessing(), sig, nonce);
    expect(verdict.verified).toBeUndefined();
    expect(verdict.reason).toBe("chain-fetch-error");
  });

  it("verified=undefined (no-blessing) when the hub presents none (old hub)", async () => {
    const fetchImpl = vi.fn();
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log: () => {},
    });
    const verdict = await v.verify(undefined, undefined, new Uint8Array(32));
    expect(verdict.verified).toBeUndefined();
    expect(verdict.reason).toBe("no-blessing");
    expect(fetchImpl).not.toHaveBeenCalled(); // no chain fetch needed
  });

  it("caches the chain across calls (one fetch for a reconnect storm)", async () => {
    const fetchImpl = vi.fn(chainMaterialFetch());
    const v = new RelayTrustVerifier({
      comBaseUrl: "https://flagshipserver.com",
      pinnedMandateHash: PIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log: () => {},
    });
    const { nonce, sig } = nonceAndSig();
    await v.verify(mintBlessing(), sig, nonce);
    await v.verify(mintBlessing(), sig, nonce);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
