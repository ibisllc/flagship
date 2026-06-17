import { describe, expect, it } from "vitest";
import {
  canonicalServiceBlessing,
  signServiceBlessing,
  verifyCaSignedServiceBlessing,
  SERVICE_BLESSING_DEFAULT_TTL_MS,
  type CaTrustChain,
  type ServiceBlessing,
} from "../src/index.js";
import { deriveIRK } from "../src/keys.js";

const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const ca = deriveIRK({ seed: new Uint8Array(32).fill(0xca) });
const otherCa = deriveIRK({ seed: new Uint8Array(32).fill(0xee) });
const caHex = toHex(ca.publicKey);

const PIN = "deadbeef".repeat(8);
const NOW = 1_700_000_500_000;

function chainReturning(keys: string[]): CaTrustChain {
  return { authorizedCaKeys: () => keys };
}

const unsigned = {
  hubKeyPub: "11".repeat(32),
  hubHost: "flagship.services",
  nonce: "nonce-abc",
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + SERVICE_BLESSING_DEFAULT_TTL_MS,
};

describe("ServiceBlessing canonical bytes", () => {
  it("uses the flagship/service-blessing/v1 tag + locked field order", () => {
    const bytes = new TextDecoder().decode(canonicalServiceBlessing(unsigned));
    expect(bytes).toBe(
      [
        "flagship/service-blessing/v1",
        unsigned.hubKeyPub,
        unsigned.hubHost,
        unsigned.nonce,
        unsigned.issuedAt,
        unsigned.expiresAt,
      ].join("|"),
    );
  });

  it("rejects a separator in a field", () => {
    expect(() =>
      canonicalServiceBlessing({ ...unsigned, hubHost: "a|b" }),
    ).toThrow();
  });
});

describe("verifyCaSignedServiceBlessing", () => {
  it("accepts a valid, in-TTL blessing signed by an authorized CA key", () => {
    const b = signServiceBlessing(unsigned, ca);
    expect(b.signedBy).toBe(caHex);
    expect(
      verifyCaSignedServiceBlessing(b, chainReturning([caHex]), NOW, PIN),
    ).toEqual({ ok: true });
  });

  it("rejects an expired blessing under an authorized key", () => {
    const b = signServiceBlessing(unsigned, ca);
    expect(
      verifyCaSignedServiceBlessing(
        b,
        chainReturning([caHex]),
        b.expiresAt + 1,
        PIN,
      ),
    ).toEqual({ ok: false, reason: "artifact-expired" });
  });

  it("rejects when signed by a non-authorized key", () => {
    const b = signServiceBlessing(unsigned, otherCa);
    expect(
      verifyCaSignedServiceBlessing(b, chainReturning([caHex]), NOW, PIN),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });

  it("rejects a tampered field (signature no longer matches)", () => {
    const b = signServiceBlessing(unsigned, ca);
    const tampered: ServiceBlessing = { ...b, hubKeyPub: "22".repeat(32) };
    expect(
      verifyCaSignedServiceBlessing(tampered, chainReturning([caHex]), NOW, PIN),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });

  it("rejects when signedBy claims an authorized key but the signature entry is for a different (unauthorized) one", () => {
    const b = signServiceBlessing(unsigned, otherCa);
    // forge: claim the authorized CA as signedBy but keep otherCa's sig entry
    const forged: ServiceBlessing = {
      ...b,
      signedBy: caHex,
      signatures: [{ pubkey: caHex, sig: b.signatures[0]!.sig }],
    };
    expect(
      verifyCaSignedServiceBlessing(forged, chainReturning([caHex]), NOW, PIN),
    ).toEqual({ ok: false, reason: "signature-unverified" });
  });

  it("fails closed when the pin is unconfigured", () => {
    const b = signServiceBlessing(unsigned, ca);
    expect(
      verifyCaSignedServiceBlessing(b, chainReturning([caHex]), NOW, ""),
    ).toEqual({ ok: false, reason: "pin-unconfigured" });
  });

  it("fails closed when no CA key is authorized (lapsed lease)", () => {
    const b = signServiceBlessing(unsigned, ca);
    expect(
      verifyCaSignedServiceBlessing(b, chainReturning([]), NOW, PIN),
    ).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
  });
});
