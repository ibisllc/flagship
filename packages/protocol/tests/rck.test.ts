import { describe, expect, it } from "vitest";
import {
  signRegisterRck,
  signSetRoutingTarget,
  verifyRegisterRck,
  verifySetRoutingTarget,
  type RegisterRck,
  type SetRoutingTarget,
} from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";
import { ed } from "../src/edSync.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function freshKeypair(seed = 0) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

describe("Routing-Control-Key registration", () => {
  it("IRK-signed RCK registration verifies against IRK pubkey", () => {
    const rck = freshKeypair(1);
    const r: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRegisterRck(r, harryIrk);
    expect(verifyRegisterRck(r, sig, harryIrk.publicKey)).toBe(true);
  });

  it("rejects a registration signed by a different user's IRK", () => {
    const rck = freshKeypair(2);
    const r: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRegisterRck(r, malloryIrk);
    expect(verifyRegisterRck(r, sig, harryIrk.publicKey)).toBe(false);
  });

  it("rejects a tampered subdomain (signature commits to it)", () => {
    const rck = freshKeypair(3);
    const r: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRegisterRck(r, harryIrk);
    const tampered: RegisterRck = { ...r, subdomain: "evil.harry.flagship.services" };
    expect(verifyRegisterRck(tampered, sig, harryIrk.publicKey)).toBe(false);
  });

  it("rejects a tampered rckPubKey (key-substitution defense)", () => {
    const rck = freshKeypair(4);
    const r: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRegisterRck(r, harryIrk);
    const attackerKey = freshKeypair(5).publicKey;
    const tampered: RegisterRck = { ...r, rckPubKey: attackerKey };
    expect(verifyRegisterRck(tampered, sig, harryIrk.publicKey)).toBe(false);
  });
});

describe("RCK target update", () => {
  it("RCK-signed target update verifies against the RCK pubkey", () => {
    const rck = freshKeypair(11);
    const target = freshKeypair(12);
    const r: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(r, rck);
    expect(verifySetRoutingTarget(r, sig, rck.publicKey)).toBe(true);
  });

  it("rejects a target update signed with a different key (not the registered RCK)", () => {
    const rck = freshKeypair(13);
    const wrong = freshKeypair(14);
    const target = freshKeypair(15);
    const r: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(r, wrong);
    expect(verifySetRoutingTarget(r, sig, rck.publicKey)).toBe(false);
  });

  it("rejects a tampered newTargetIdentityPubKey (re-aim attack)", () => {
    const rck = freshKeypair(16);
    const target = freshKeypair(17);
    const r: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(r, rck);
    const attacker = freshKeypair(18).publicKey;
    const tampered: SetRoutingTarget = { ...r, newTargetIdentityPubKey: attacker };
    expect(verifySetRoutingTarget(tampered, sig, rck.publicKey)).toBe(false);
  });

  it("rejects a tampered nonce (replay defense)", () => {
    const rck = freshKeypair(19);
    const target = freshKeypair(20);
    const r: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: 1_700_000_000_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(r, rck);
    const tampered: SetRoutingTarget = { ...r, nonce: new Uint8Array(16).fill(8) };
    expect(verifySetRoutingTarget(tampered, sig, rck.publicKey)).toBe(false);
  });
});
