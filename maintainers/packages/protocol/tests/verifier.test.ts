/**
 * Verifier integration tests: build sequences of mandates and assert
 * the verifier accepts/rejects them per spec §4.
 */
import { describe, expect, it } from "vitest";
import { generateKeypair } from "../src/crypto.js";
import { signMandate } from "../src/signing.js";
import { currentAuthority, lastExpiredMandate, verifyTrack } from "../src/verifier.js";
import type { Mandate, TrackPolicy } from "../src/types.js";

function keypair(seedByte: number): { privKey: string; pubKey: string } {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

function mkPolicy(threshold = 1): TrackPolicy {
  return {
    track: "release",
    defaultMandateDuration: "60d",
    approvalRule: { kind: "threshold", threshold, of: "anyAuthorizedSigner" },
  };
}

function mkMandate(opts: {
  id: string;
  holder: string;
  successors: string[];
  signers: string[];
  issuedAt: string;
  expiresAt: string;
  signedBy?: string;
  track?: string;
  privKeys: string[];
}): Mandate {
  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: opts.id,
      track: opts.track ?? "release",
      holder: opts.holder,
      issuedAt: opts.issuedAt,
      expiresAt: opts.expiresAt,
      successors: opts.successors,
      signedBy: opts.signedBy ?? opts.holder,
    },
    opts.privKeys.map((privKey) => ({ privKey })),
  );
}

describe("verifyTrack — genesis", () => {
  it("accepts a self-signed genesis mandate", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-05-15T12:00:00Z",
      expiresAt: "2026-07-14T12:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections).toHaveLength(0);
  });

  it("rejects a genesis not self-signed by holder", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [],
      signers: [bob.pubKey],
      issuedAt: "2026-05-15T12:00:00Z",
      expiresAt: "2026-07-14T12:00:00Z",
      signedBy: bob.pubKey,
      privKeys: [bob.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis]);
    expect(verified.validMandates).toHaveLength(0);
    expect(verified.rejections[0]?.reason).toBe("genesis-not-self-signed");
  });

  it("rejects a tampered signature", () => {
    const alice = keypair(1);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-05-15T12:00:00Z",
      expiresAt: "2026-07-14T12:00:00Z",
      privKeys: [alice.privKey],
    });
    // Flip a single bit in the first signature
    const sig = genesis.signatures[0]!.sig;
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === "00" ? "01" : "00");
    const evil: Mandate = {
      ...genesis,
      signatures: [{ pubkey: genesis.signatures[0]!.pubkey, sig: tampered }],
    };
    const verified = verifyTrack("release", mkPolicy(), [evil]);
    expect(verified.rejections[0]?.reason).toBe("signature-invalid");
  });
});

describe("verifyTrack — renewal (active-window)", () => {
  it("accepts a renewal signed by the current holder", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const renewal = mkMandate({
      id: "g2",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-02-15T00:00:00Z",
      expiresAt: "2026-04-15T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis, renewal]);
    expect(verified.validMandates).toHaveLength(2);
  });

  it("rejects an in-window mandate signed by a successor (not yet authorized)", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const premature = mkMandate({
      id: "g2",
      holder: bob.pubKey,
      successors: [],
      signers: [bob.pubKey],
      signedBy: bob.pubKey,
      issuedAt: "2026-02-15T00:00:00Z", // before genesis expires
      expiresAt: "2026-04-15T00:00:00Z",
      privKeys: [bob.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis, premature]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections[0]?.reason).toBe("signer-not-authorized");
  });
});

describe("verifyTrack — takeover (after expiry)", () => {
  it("accepts a takeover by a named successor after expiry", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const takeover = mkMandate({
      id: "g2",
      holder: bob.pubKey,
      successors: [],
      signers: [bob.pubKey],
      signedBy: bob.pubKey,
      issuedAt: "2026-03-02T00:00:00Z",
      expiresAt: "2026-05-02T00:00:00Z",
      privKeys: [bob.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis, takeover]);
    expect(verified.validMandates).toHaveLength(2);
  });

  it("rejects a takeover by a NON-successor", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const eve = keypair(99);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const hostileTakeover = mkMandate({
      id: "g2",
      holder: eve.pubKey,
      successors: [],
      signers: [eve.pubKey],
      signedBy: eve.pubKey,
      issuedAt: "2026-03-02T00:00:00Z",
      expiresAt: "2026-05-02T00:00:00Z",
      privKeys: [eve.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis, hostileTakeover]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections[0]?.reason).toBe("signer-not-authorized");
  });
});

describe("currentAuthority + lastExpiredMandate", () => {
  it("returns the active holder when within the active window", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis]);
    const authority = currentAuthority(verified, new Date("2026-02-01T00:00:00Z"));
    expect(authority?.holder).toBe(alice.pubKey);
  });

  it("returns null when no mandate is active (post-expiry, pre-takeover)", () => {
    const alice = keypair(1);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis]);
    const authority = currentAuthority(verified, new Date("2026-04-01T00:00:00Z"));
    expect(authority).toBeNull();
    expect(lastExpiredMandate(verified, new Date("2026-04-01T00:00:00Z"))?.mandateId).toBe("g1");
  });

  it("returns the most recent active mandate when multiple overlap (chain of renewals)", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const g1 = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const g2 = mkMandate({
      id: "g2",
      holder: alice.pubKey,
      successors: [bob.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-02-15T00:00:00Z",
      expiresAt: "2026-04-15T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [g1, g2]);
    // Between 2026-02-15 and 2026-03-01, both g1 and g2 are active.
    // currentAuthority returns the most recent: g2.
    const a = currentAuthority(verified, new Date("2026-02-20T00:00:00Z"));
    expect(a?.mandate.mandateId).toBe("g2");
  });
});

describe("verifyTrack — edge cases", () => {
  it("rejects duplicate mandateId", () => {
    const alice = keypair(1);
    const m1 = mkMandate({
      id: "dup",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const m2 = mkMandate({
      id: "dup",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-02-01T00:00:00Z",
      expiresAt: "2026-04-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [m1, m2]);
    expect(verified.validMandates).toHaveLength(1);
    expect(verified.rejections[0]?.reason).toBe("duplicate-mandate-id");
  });

  it("rejects mandate where expiresAt <= issuedAt", () => {
    const alice = keypair(1);
    const m = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-03-01T00:00:00Z",
      expiresAt: "2026-01-01T00:00:00Z", // before issuedAt
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [m]);
    expect(verified.rejections[0]?.reason).toBe("expires-before-issuance");
  });

  it("rejects mandate with wrong track field", () => {
    const alice = keypair(1);
    const m = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      track: "ca",
      privKeys: [alice.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [m]);
    expect(verified.rejections[0]?.reason).toBe("wrong-track");
  });
});

describe("verifyTrack — race semantics (first-after-expiry wins)", () => {
  it("only the FIRST takeover lands; a second by another successor is rejected", () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const carol = keypair(3);
    const genesis = mkMandate({
      id: "g1",
      holder: alice.pubKey,
      successors: [bob.pubKey, carol.pubKey],
      signers: [alice.pubKey],
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
      privKeys: [alice.privKey],
    });
    // Bob takes over first (in canonical-log order)
    const bobTakeover = mkMandate({
      id: "g2",
      holder: bob.pubKey,
      successors: [bob.pubKey],
      signers: [bob.pubKey],
      signedBy: bob.pubKey,
      issuedAt: "2026-03-02T00:00:00Z",
      expiresAt: "2026-05-02T00:00:00Z",
      privKeys: [bob.privKey],
    });
    // Carol tries later — bob is now holder; carol is not in bob's successors
    const carolTakeover = mkMandate({
      id: "g3",
      holder: carol.pubKey,
      successors: [],
      signers: [carol.pubKey],
      signedBy: carol.pubKey,
      issuedAt: "2026-03-05T00:00:00Z",
      expiresAt: "2026-05-05T00:00:00Z",
      privKeys: [carol.privKey],
    });
    const verified = verifyTrack("release", mkPolicy(), [genesis, bobTakeover, carolTakeover]);
    expect(verified.validMandates.map((m) => m.mandateId)).toEqual(["g1", "g2"]);
    expect(verified.rejections[0]?.reason).toBe("signer-not-authorized");
  });
});
