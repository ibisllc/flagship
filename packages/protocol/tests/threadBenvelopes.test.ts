/**
 * Tests for the Thread-B + invitation envelopes added in this cycle:
 *   - PodIdentityBinding (#89)
 *   - AppAccessInvite + AppAccessAcceptance (#79)
 *   - RotateRck + RecoverRck + RevokeRecoverRck (#75)
 *   - MergeBack (#76)
 *
 * Each envelope: sign + verify roundtrip, tamper-detection, separator
 * rejection where applicable.
 */
import { describe, expect, it } from "vitest";
import {
  type AppAccessAcceptance,
  type AppAccessInvite,
  type MergeBack,
  type PodIdentityBinding,
  type RecoverRck,
  type RevokeRecoverRck,
  type RotateRck,
  signAppAccessAcceptance,
  signAppAccessInvite,
  signMergeBack,
  signPodIdentityBinding,
  signRecoverRck,
  signRevokeRecoverRck,
  signRotateRck,
  verifyAppAccessAcceptance,
  verifyAppAccessInvite,
  verifyMergeBack,
  verifyPodIdentityBinding,
  verifyRecoverRck,
  verifyRevokeRecoverRck,
  verifyRotateRck,
} from "../src/auth.js";
import { deriveIRK, deriveSTK, deriveSWK } from "../src/keys.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const harryIrk = deriveIRK(harryUmk);
const malloryIrk = deriveIRK(malloryUmk);

function freshKeypair(seed: number) {
  const s = new Uint8Array(32);
  s[0] = seed;
  return deriveSTK(deriveSWK({ seed: s }, "test"));
}

describe("PodIdentityBinding", () => {
  const stk = deriveSTK(deriveSWK(harryUmk, "home"));
  const binding: PodIdentityBinding = {
    username: "harry",
    podIdentityPubKey: stk.publicKey,
    serverDomain: "home.harry.flagship.services",
    registeredAt: 1_780_000_000_000,
  };

  it("signs + verifies under issuing IRK", () => {
    const sig = signPodIdentityBinding(binding, harryIrk);
    expect(verifyPodIdentityBinding(binding, sig, harryIrk.publicKey)).toBe(true);
  });

  it("fails verification under a different IRK", () => {
    const sig = signPodIdentityBinding(binding, harryIrk);
    expect(verifyPodIdentityBinding(binding, sig, malloryIrk.publicKey)).toBe(false);
  });

  it("fails on field tamper", () => {
    const sig = signPodIdentityBinding(binding, harryIrk);
    expect(verifyPodIdentityBinding({ ...binding, username: "hacker" }, sig, harryIrk.publicKey)).toBe(false);
  });

  it("rejects '|' in username at sign time", () => {
    expect(() =>
      signPodIdentityBinding({ ...binding, username: "ha|rry" }, harryIrk),
    ).toThrow(/separator/);
  });
});

describe("AppAccessInvite + Acceptance", () => {
  const invite: AppAccessInvite = {
    inviteId: "550e8400-e29b-41d4-a716-446655440000",
    appCanonical: "notes@abc123def456",
    secretHash: "f".repeat(64),
    role: "admin",
    opaqueTag: new Uint8Array(16).fill(0xa),
    expectedIrkPubKey: null,
    contextNote: "From Harry at the bar",
    issuedAt: 1_780_000_000_000,
    expiresAt: 1_780_086_400_000,
  };

  it("sign + verify invite under owner IRK", () => {
    const sig = signAppAccessInvite(invite, harryIrk);
    expect(verifyAppAccessInvite(invite, sig, harryIrk.publicKey)).toBe(true);
  });

  it("expectedIrkPubKey changes the bytes (pre-bound vs bearer)", () => {
    const sigBearer = signAppAccessInvite(invite, harryIrk);
    const preBound: AppAccessInvite = { ...invite, expectedIrkPubKey: harryIrk.publicKey };
    const sigPreBound = signAppAccessInvite(preBound, harryIrk);
    expect(verifyAppAccessInvite(invite, sigPreBound, harryIrk.publicKey)).toBe(false);
    expect(verifyAppAccessInvite(preBound, sigBearer, harryIrk.publicKey)).toBe(false);
  });

  it("rejects '|' in contextNote", () => {
    expect(() =>
      signAppAccessInvite({ ...invite, contextNote: "evil|context" }, harryIrk),
    ).toThrow(/separator/);
  });

  it("sign + verify acceptance under consumer IRK", () => {
    const consumer = freshKeypair(7);
    const acceptance: AppAccessAcceptance = {
      inviteId: invite.inviteId,
      secretHash: invite.secretHash,
      consumerIrkPubKey: consumer.publicKey,
      acceptedAt: 1_780_000_000_500,
      nonce: new Uint8Array(16).fill(0xc),
    };
    const sig = signAppAccessAcceptance(acceptance, consumer);
    expect(verifyAppAccessAcceptance(acceptance, sig, consumer.publicKey)).toBe(true);
  });
});

describe("RotateRck (routine rotation, double-signed)", () => {
  const oldRck = freshKeypair(1);
  const newRck = freshKeypair(2);
  const rotate: RotateRck = {
    subdomain: "home.harry.flagship.services",
    newRckPubKey: newRck.publicKey,
    oldRckPubKey: oldRck.publicKey,
    issuedAt: 1_780_000_000_000,
    nonce: new Uint8Array(16).fill(0xd),
  };

  it("both signatures verify against their respective pubkeys", () => {
    const { sigOldRck, sigIrk } = signRotateRck(rotate, oldRck, harryIrk);
    expect(
      verifyRotateRck(rotate, sigOldRck, sigIrk, oldRck.publicKey, harryIrk.publicKey),
    ).toBe(true);
  });

  it("verification fails if oldRck signature is wrong", () => {
    const { sigIrk } = signRotateRck(rotate, oldRck, harryIrk);
    const evilSig = new Uint8Array(64).fill(0x99);
    expect(
      verifyRotateRck(rotate, evilSig, sigIrk, oldRck.publicKey, harryIrk.publicKey),
    ).toBe(false);
  });

  it("verification fails if IRK signature is wrong", () => {
    const { sigOldRck } = signRotateRck(rotate, oldRck, harryIrk);
    const evilSig = new Uint8Array(64).fill(0x99);
    expect(
      verifyRotateRck(rotate, sigOldRck, evilSig, oldRck.publicKey, harryIrk.publicKey),
    ).toBe(false);
  });
});

describe("RecoverRck + RevokeRecoverRck (grace-window flow)", () => {
  const newRck = freshKeypair(3);
  const newIrk = malloryIrk; // pretend new IRK from cloud recovery
  const recover: RecoverRck = {
    subdomain: "home.harry.flagship.services",
    newRckPubKey: newRck.publicKey,
    newIrkPubKey: newIrk.publicKey,
    declaredAt: 1_780_000_000_000,
    effectiveAt: 1_780_086_400_000,
    nonce: new Uint8Array(16).fill(0xe),
  };

  it("sign + verify under the new IRK", () => {
    const sig = signRecoverRck(recover, newIrk);
    expect(verifyRecoverRck(recover, sig, newIrk.publicKey)).toBe(true);
  });

  it("RevokeRecoverRck signed by old IRK cancels", () => {
    const revoke: RevokeRecoverRck = {
      subdomain: recover.subdomain,
      pendingDeclaredAt: recover.declaredAt,
      revokedAt: recover.declaredAt + 1000,
      nonce: new Uint8Array(16).fill(0xf),
    };
    const sig = signRevokeRecoverRck(revoke, harryIrk);
    expect(verifyRevokeRecoverRck(revoke, sig, harryIrk.publicKey)).toBe(true);
    expect(verifyRevokeRecoverRck(revoke, sig, malloryIrk.publicKey)).toBe(false);
  });
});

describe("MergeBack", () => {
  const dev1 = freshKeypair(11).publicKey;
  const dev2 = freshKeypair(12).publicKey;
  const merge: MergeBack = {
    username: "harry",
    newIrkPubKey: malloryIrk.publicKey, // post-recovery IRK
    surrenderingDevices: [dev1, dev2],
    issuedAt: 1_780_000_000_000,
  };

  it("signs + verifies under old IRK", () => {
    const sig = signMergeBack(merge, harryIrk);
    expect(verifyMergeBack(merge, sig, harryIrk.publicKey)).toBe(true);
  });

  it("canonical bytes are order-independent on surrenderingDevices", () => {
    const sigA = signMergeBack(merge, harryIrk);
    const reordered: MergeBack = { ...merge, surrenderingDevices: [dev2, dev1] };
    const sigB = signMergeBack(reordered, harryIrk);
    expect(sigA).toEqual(sigB);
  });

  it("fails verification when newIrkPubKey changed", () => {
    const sig = signMergeBack(merge, harryIrk);
    const tampered: MergeBack = { ...merge, newIrkPubKey: dev1 };
    expect(verifyMergeBack(tampered, sig, harryIrk.publicKey)).toBe(false);
  });

  it("rejects '|' in username", () => {
    expect(() => signMergeBack({ ...merge, username: "ha|rry" }, harryIrk)).toThrow(/separator/);
  });
});
