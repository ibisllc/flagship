/**
 * Envelope assembly tests — these are the protocol-correctness checks
 * for the wrapper functions in src/envelopes.ts. We don't re-test the
 * protocol library's signing here; we test that what the UI assembles
 * round-trips through the verifier.
 */

import { describe, expect, it } from "vitest";
import {
  currentAuthority,
  generateKeypair,
  verifyTrack,
} from "@maintainers/protocol";
import {
  buildGenesisMandate,
  buildKeyFile,
  buildRenewalMandate,
  buildTakeoverMandate,
  makeTrackPolicy,
  pathForKeyFile,
  pathForMandate,
  serializeEnvelope,
} from "../src/envelopes.js";

function kp(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

describe("envelopes", () => {
  it("buildGenesisMandate produces a mandate that verifies under the verifier", () => {
    const alice = kp(1);
    const policy = makeTrackPolicy("release", 60);
    const m = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "Alice",
      holderEmail: "alice@example.com",
      successors: [],
      track: "release",
      now: new Date("2026-05-01T00:00:00Z"),
      durationDays: 60,
    });
    const verified = verifyTrack("release", policy, [m]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections).toHaveLength(0);
  });

  it("buildRenewalMandate chains correctly off the genesis", () => {
    const alice = kp(1);
    const policy = makeTrackPolicy("release", 60);
    const genesis = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "Alice",
      holderEmail: "a@example.com",
      successors: [alice.pubKey],
      track: "release",
      now: new Date("2026-01-01T00:00:00Z"),
      durationDays: 60,
    });
    const renewal = buildRenewalMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      successors: [alice.pubKey],
      track: "release",
      now: new Date("2026-02-15T00:00:00Z"),
      durationDays: 60,
    });
    const verified = verifyTrack("release", policy, [genesis, renewal]);
    expect(verified.validMandates).toHaveLength(2);
    const auth = currentAuthority(verified, new Date("2026-03-01T00:00:00Z"));
    expect(auth?.holder).toBe(alice.pubKey);
    expect(auth?.mandate.mandateId).toBe(renewal.mandateId);
  });

  it("buildTakeoverMandate is accepted after the predecessor expires", () => {
    const alice = kp(1);
    const bob = kp(2);
    const policy = makeTrackPolicy("release", 30);
    const genesis = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "A",
      holderEmail: "a@e.com",
      successors: [bob.pubKey],
      track: "release",
      now: new Date("2026-01-01T00:00:00Z"),
      durationDays: 30,
    });
    const takeover = buildTakeoverMandate({
      successorPub: bob.pubKey,
      successorPriv: bob.privKey,
      newSuccessors: [bob.pubKey],
      track: "release",
      now: new Date("2026-02-15T00:00:00Z"),
      durationDays: 30,
    });
    const verified = verifyTrack("release", policy, [genesis, takeover]);
    expect(verified.rejections).toEqual([]);
    expect(verified.validMandates).toHaveLength(2);
    const auth = currentAuthority(verified, new Date("2026-02-20T00:00:00Z"));
    expect(auth?.holder).toBe(bob.pubKey);
  });

  it("takeover is rejected when the successor was not named", () => {
    const alice = kp(1);
    const eve = kp(99);
    const policy = makeTrackPolicy("release", 30);
    const genesis = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "A",
      holderEmail: "a@e.com",
      successors: [],
      track: "release",
      now: new Date("2026-01-01T00:00:00Z"),
      durationDays: 30,
    });
    const stolen = buildTakeoverMandate({
      successorPub: eve.pubKey,
      successorPriv: eve.privKey,
      newSuccessors: [eve.pubKey],
      track: "release",
      now: new Date("2026-02-15T00:00:00Z"),
      durationDays: 30,
    });
    const verified = verifyTrack("release", policy, [genesis, stolen]);
    expect(verified.rejections).toHaveLength(1);
    expect(verified.rejections[0]!.reason).toBe("signer-not-authorized");
  });

  it("buildKeyFile produces a self-signed envelope", () => {
    const alice = kp(1);
    const kf = buildKeyFile({
      pub: alice.pubKey,
      priv: alice.privKey,
      displayName: "Alice",
      email: "alice@example.com",
      introductionMandate: "intro-1",
    });
    expect(kf.signature).toMatch(/^[0-9a-f]+$/);
    expect(kf.pubkey).toBe(alice.pubKey);
  });

  it("pathForMandate produces a deterministic, sortable path", () => {
    const p = pathForMandate("release", "2026-05-11T12:34:56Z", "Genesis");
    expect(p).toBe("tracks/release/mandates/2026-05-11T12-34-56-genesis.json");
  });

  it("pathForKeyFile uses email verbatim", () => {
    expect(pathForKeyFile("alice@example.com")).toBe("keys/alice@example.com.json");
  });

  it("serializeEnvelope round-trips through JSON.parse", () => {
    const alice = kp(1);
    const kf = buildKeyFile({
      pub: alice.pubKey,
      priv: alice.privKey,
      displayName: "Alice",
      email: "alice@example.com",
      introductionMandate: "intro-1",
    });
    const bytes = serializeEnvelope(kf);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.kind).toBe("KeyFile");
    expect(parsed.pubkey).toBe(alice.pubKey);
  });
});
