import { describe, expect, it } from "vitest";
import {
  canonicalTrustException,
  signTrustException,
  verifyTrustException,
  controlCertHash,
  relayCertHash,
  trustExceptionCertHash,
  type TrustException,
} from "../src/index.js";
import { deriveIRK } from "../src/keys.js";
import { sha256 } from "@noble/hashes/sha256";

const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const device = deriveIRK({ seed: new Uint8Array(32).fill(0x11) });
const otherDevice = deriveIRK({ seed: new Uint8Array(32).fill(0x22) });
const devicePub = toHex(device.publicKey);
const otherPub = toHex(otherDevice.publicKey);

const caPubkey = "ab".repeat(32);
const hubKeyPub = "cd".repeat(32);

describe("cert-hash slugs", () => {
  it("control = sha256hex(utf8(caPubkey))", () => {
    expect(controlCertHash(caPubkey)).toBe(
      toHex(sha256(new TextEncoder().encode(caPubkey))),
    );
  });
  it("relay = sha256hex(utf8(hubKeyPub))", () => {
    expect(relayCertHash(hubKeyPub)).toBe(
      toHex(sha256(new TextEncoder().encode(hubKeyPub))),
    );
  });
  it("trustExceptionCertHash is the shared primitive", () => {
    expect(trustExceptionCertHash(caPubkey)).toBe(controlCertHash(caPubkey));
  });
});

describe("TrustException canonical bytes", () => {
  it("uses the flagship/trust-exception/v1 tag + locked field order", () => {
    const certHash = controlCertHash(caPubkey);
    const fields = {
      certClass: "control" as const,
      certHash,
      grantedAt: 1_700_000_000_000,
      grantedByDevicePub: devicePub,
    };
    const bytes = new TextDecoder().decode(canonicalTrustException(fields));
    expect(bytes).toBe(
      [
        "flagship/trust-exception/v1",
        "control",
        certHash,
        fields.grantedAt,
        devicePub,
      ].join("|"),
    );
  });
});

describe("verifyTrustException", () => {
  const certHash = relayCertHash(hubKeyPub);
  const exc = signTrustException(
    { certClass: "relay", certHash, grantedAt: 1_700_000_000_000 },
    device,
  );

  it("signs with the device key and sets grantedByDevicePub", () => {
    expect(exc.grantedByDevicePub).toBe(devicePub);
    expect(exc.certClass).toBe("relay");
  });

  it("accepts when the granting device is in the roster", () => {
    expect(verifyTrustException(exc, [devicePub])).toEqual({ ok: true });
  });

  it("accepts case-insensitively + among multiple roster entries", () => {
    expect(
      verifyTrustException(exc, [otherPub, devicePub.toUpperCase()]),
    ).toEqual({ ok: true });
  });

  it("rejects when the device is NOT in the roster", () => {
    expect(verifyTrustException(exc, [otherPub])).toEqual({
      ok: false,
      reason: "device-not-in-roster",
    });
  });

  it("rejects when the roster is empty", () => {
    expect(verifyTrustException(exc, [])).toEqual({
      ok: false,
      reason: "device-not-in-roster",
    });
  });

  it("rejects a tampered field even with the device in roster", () => {
    const tampered: TrustException = { ...exc, certHash: "00".repeat(32) };
    expect(verifyTrustException(tampered, [devicePub])).toEqual({
      ok: false,
      reason: "signature-unverified",
    });
  });

  it("rejects a forged signedBy: roster device claimed but signature is another device's", () => {
    const forged: TrustException = {
      ...exc,
      grantedByDevicePub: devicePub,
      signatures: [
        {
          pubkey: devicePub,
          // a signature actually made by otherDevice over its own fields
          sig: signTrustException(
            { certClass: "relay", certHash, grantedAt: exc.grantedAt },
            otherDevice,
          ).signatures[0]!.sig,
        },
      ],
    };
    expect(verifyTrustException(forged, [devicePub])).toEqual({
      ok: false,
      reason: "signature-unverified",
    });
  });

  it("rejects malformed input", () => {
    expect(
      verifyTrustException({} as unknown as TrustException, [devicePub]),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
