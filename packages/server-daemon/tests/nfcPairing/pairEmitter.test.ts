import { describe, expect, it } from "vitest";
import {
  PAIR_PROTOCOL_VERSION,
  signPair,
  stkPubToSuffix6,
  verifyPair,
} from "@flagship/protocol";
import {
  buildPairHint,
  buildPairPayload,
  generatePairKeys,
  type PairEmitterConfig,
} from "../../src/nfcPairing/pairEmitter.js";
import type { EntropyReader } from "../../src/nfcPairing/rngGate.js";
import type { Bytes } from "@flagship/protocol";

const okReader: EntropyReader = { read: () => 1024 };
const blockedReader: EntropyReader = { read: () => 64 };

const config: PairEmitterConfig = {
  mdnsBase: "flagship",
  cloudRendezvousBase: "rendezvous.flagshipserver.com",
};

describe("pair emitter (N-BOX-2 + N-BOX-7)", () => {
  it("blocks keygen when entropy gate is closed", () => {
    const r = generatePairKeys(blockedReader);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.entropy.ok).toBe(false);
  });

  it("generates a key set when entropy is sufficient", () => {
    const r = generatePairKeys(okReader);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keys.stkPub).toHaveLength(32);
    expect(r.keys.stkPriv).toHaveLength(32);
    expect(r.keys.eBoxPub).toHaveLength(32);
    expect(r.keys.eBoxPriv).toHaveLength(32);
    expect(r.keys.nonce).toHaveLength(16);
    expect(r.keys.sessionId).toHaveLength(16);
  });

  it("produces a hint with mdnsName + cloudRendezvousId + suffix6 from stkPub", () => {
    const stkPub = new Uint8Array(32);
    stkPub[30] = 0xab;
    stkPub[31] = 0xcd;
    const hint = buildPairHint(stkPub, config);
    expect(hint.suffix6).toBe("00abcd");
    expect(hint.mdnsName).toBe("flagship-00abcd");
    expect(hint.cloudRendezvousId).toBe("rendezvous.flagshipserver.com/00abcd");
  });

  it("composes a PairPayload that signs + verifies", () => {
    const r = generatePairKeys(okReader);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const payload = buildPairPayload(r.keys, config);
    expect(payload.v).toBe(PAIR_PROTOCOL_VERSION);
    expect(payload.hint.suffix6).toBe(stkPubToSuffix6(r.keys.stkPub));
    const sig = signPair(payload, { publicKey: r.keys.stkPub, privateKey: r.keys.stkPriv });
    expect(verifyPair(payload, sig)).toBe(true);
  });

  it("two key generations produce distinct keys + nonces", () => {
    const a = generatePairKeys(okReader);
    const b = generatePairKeys(okReader);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.keys.stkPub).not.toEqual(b.keys.stkPub);
    expect(a.keys.eBoxPub).not.toEqual(b.keys.eBoxPub);
    expect(a.keys.nonce).not.toEqual(b.keys.nonce);
    expect(a.keys.sessionId).not.toEqual(b.keys.sessionId);
  });

  it("respects an injected rng", () => {
    let calls = 0;
    const fakeRng = (n: number): Bytes => {
      calls++;
      // Distinct deterministic outputs so STK ≠ ephemeral etc.
      return new Uint8Array(n).fill(calls);
    };
    const r = generatePairKeys(okReader, fakeRng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Four calls: stkPriv (32), eBoxPriv (32), nonce (16), sessionId (16).
    expect(calls).toBe(4);
    expect(r.keys.nonce.every((x) => x === 3)).toBe(true);
  });
});
