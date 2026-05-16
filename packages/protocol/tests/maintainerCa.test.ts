/**
 * Link-1 fail-closed gate (#30). The shipped genesis is EMPTY, so
 * every CA-signed artifact MUST be rejected `genesis-unconfigured`
 * regardless of any chain — that is the pre-release invariant. The
 * configured path is exercised via the injectable genesis param
 * (the placeholder for #8/#9/#10) to prove the seam lights up once
 * the real genesis ceremony bakes the constant in.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAINTAINER_GENESIS_PUBKEYS,
  maintainerGenesisConfigured,
  authorizedCaKeysOrFailClosed,
  verifyCaSignedDemoDirective,
  verifyCaSignedUserPubKeyBinding,
  type CaTrustChain,
} from "../src/maintainerCa.js";
import { signDemoDirective, signUserPubKeyBinding } from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";
import type { DemoDirective, UserPubKeyBinding } from "../src/auth.js";

const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const ca = deriveIRK({ seed: new Uint8Array(32).fill(0xca) });
const otherCa = deriveIRK({ seed: new Uint8Array(32).fill(0xee) });
const caHex = toHex(ca.publicKey);

const NOW = 1_700_000_500_000;
const directive: DemoDirective = {
  version: 1,
  username: "demo",
  useMockRecovery: true,
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_900_000,
  issuer: "flagship-ca-v1",
};
const binding: UserPubKeyBinding = {
  version: 1,
  username: "alice",
  pubKey: new Uint8Array(32).fill(7),
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_900_000,
  issuer: "flagship-ca-v1",
};

/** A chain that would authorize `keys` — used to prove it is NOT
 * consulted while genesis is unconfigured. */
function chainReturning(keys: string[]): CaTrustChain {
  return { authorizedCaKeys: vi.fn(() => keys) };
}

describe("MAINTAINER_GENESIS_PUBKEYS (#30 link-1)", () => {
  it("ships EMPTY — the pre-release fail-closed invariant", () => {
    expect(MAINTAINER_GENESIS_PUBKEYS).toEqual([]);
    expect(maintainerGenesisConfigured()).toBe(false);
  });

  it("does not consult the chain port when genesis is unconfigured", () => {
    const chain = chainReturning([caHex]);
    const r = authorizedCaKeysOrFailClosed(chain, NOW);
    expect(r).toEqual({ ok: false, reason: "genesis-unconfigured" });
    expect(chain.authorizedCaKeys).not.toHaveBeenCalled();
  });

  it("rejects a perfectly-signed DemoDirective with the shipped genesis", () => {
    const sig = signDemoDirective(directive, ca);
    const r = verifyCaSignedDemoDirective(
      directive,
      sig,
      chainReturning([caHex]),
      NOW,
    );
    expect(r).toEqual({ ok: false, reason: "genesis-unconfigured" });
  });

  it("rejects a perfectly-signed UserPubKeyBinding with the shipped genesis", () => {
    const sig = signUserPubKeyBinding(binding, ca);
    const r = verifyCaSignedUserPubKeyBinding(
      binding,
      sig,
      chainReturning([caHex]),
      NOW,
    );
    expect(r).toEqual({ ok: false, reason: "genesis-unconfigured" });
  });
});

describe("configured-genesis seam (placeholder genesis for #8/#9/#10)", () => {
  const GENESIS = ["deadbeef".repeat(8)]; // any non-empty set ⇒ link-1 ok

  it("accepts a CA-signed, in-TTL DemoDirective when the chain authorizes the key", () => {
    const sig = signDemoDirective(directive, ca);
    const r = verifyCaSignedDemoDirective(
      directive,
      sig,
      chainReturning([caHex]),
      NOW,
      GENESIS,
    );
    expect(r).toEqual({ ok: true });
  });

  it("accepts a CA-signed, in-TTL UserPubKeyBinding likewise", () => {
    const sig = signUserPubKeyBinding(binding, ca);
    const r = verifyCaSignedUserPubKeyBinding(
      binding,
      sig,
      chainReturning([caHex]),
      NOW,
      GENESIS,
    );
    expect(r).toEqual({ ok: true });
  });

  it("fails closed when the chain authorizes no key (lapsed lease)", () => {
    const sig = signDemoDirective(directive, ca);
    expect(
      verifyCaSignedDemoDirective(directive, sig, chainReturning([]), NOW, GENESIS),
    ).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(
      authorizedCaKeysOrFailClosed(null, NOW, GENESIS),
    ).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
  });

  it("rejects an out-of-TTL artifact even under an authorized key", () => {
    const sig = signDemoDirective(directive, ca);
    expect(
      verifyCaSignedDemoDirective(
        directive,
        sig,
        chainReturning([caHex]),
        directive.expiresAt + 1,
        GENESIS,
      ),
    ).toEqual({ ok: false, reason: "artifact-expired" });
  });

  it("rejects when the artifact was signed by a non-authorized key", () => {
    const sig = signDemoDirective(directive, otherCa);
    expect(
      verifyCaSignedDemoDirective(
        directive,
        sig,
        chainReturning([caHex]),
        NOW,
        GENESIS,
      ),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });
});
