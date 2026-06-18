/**
 * Link-1 fail-closed gate (#30 generalised to the LOCKED Phase-2 v2
 * model). The shipped pinned-Mandate hash is the EMPTY string, so every
 * CA-signed artifact MUST be rejected `pin-unconfigured` regardless of
 * any chain — that is the pre-release invariant. The configured path is
 * exercised via the injectable pin param (the placeholder for #8/#9/#10)
 * to prove the seam lights up once the real Gate-B ceremony bakes the
 * pinned-mandate canonical hash in.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAINTAINER_PINNED_MANDATE_HASH,
  maintainerPinConfigured,
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

describe("MAINTAINER_PINNED_MANDATE_HASH (#30 link-1, generalised)", () => {
  it("is POPULATED post-Gate-B; empty pin is still fail-closed", () => {
    // ⚠️ GYM TEST BRANCH ONLY — the gym self-contained chain pin. On `main`
    // this is the prod pin "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae".
    expect(MAINTAINER_PINNED_MANDATE_HASH).toBe(
      "87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7",
    );
    expect(maintainerPinConfigured()).toBe(true);
    // The empty-⇒-fail-closed invariant still holds with an explicit "".
    expect(maintainerPinConfigured("")).toBe(false);
  });

  it("does not consult the chain port when the pin is unconfigured", () => {
    const chain = chainReturning([caHex]);
    const r = authorizedCaKeysOrFailClosed(chain, NOW, "");
    expect(r).toEqual({ ok: false, reason: "pin-unconfigured" });
    expect(chain.authorizedCaKeys).not.toHaveBeenCalled();
  });

  it("rejects a perfectly-signed DemoDirective with an empty pin", () => {
    const sig = signDemoDirective(directive, ca);
    const r = verifyCaSignedDemoDirective(
      directive,
      sig,
      chainReturning([caHex]),
      NOW,
      "",
    );
    expect(r).toEqual({ ok: false, reason: "pin-unconfigured" });
  });

  it("rejects a perfectly-signed UserPubKeyBinding with an empty pin", () => {
    const sig = signUserPubKeyBinding(binding, ca);
    const r = verifyCaSignedUserPubKeyBinding(
      binding,
      sig,
      chainReturning([caHex]),
      NOW,
      "",
    );
    expect(r).toEqual({ ok: false, reason: "pin-unconfigured" });
  });
});

describe("configured-pin seam (placeholder pin for #8/#9/#10)", () => {
  const PIN = "deadbeef".repeat(8); // any non-empty pin ⇒ link-1 ok

  it("accepts a CA-signed, in-TTL DemoDirective when the chain authorizes the key", () => {
    const sig = signDemoDirective(directive, ca);
    const r = verifyCaSignedDemoDirective(
      directive,
      sig,
      chainReturning([caHex]),
      NOW,
      PIN,
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
      PIN,
    );
    expect(r).toEqual({ ok: true });
  });

  it("fails closed when the chain authorizes no key (lapsed lease)", () => {
    const sig = signDemoDirective(directive, ca);
    expect(
      verifyCaSignedDemoDirective(directive, sig, chainReturning([]), NOW, PIN),
    ).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(
      authorizedCaKeysOrFailClosed(null, NOW, PIN),
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
        PIN,
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
        PIN,
      ),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });
});
