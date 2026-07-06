import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  base32Encode,
  base32Decode,
  base64UrlEncode,
  base64UrlDecode,
  sessionId,
  humanCode,
  codeBytesFromHuman,
  formatHumanCode,
  qrPayload,
  deriveSessionMaterial,
  sealDelivered,
  openDelivered,
} from "../src/index.js";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Pinned cross-platform vector — must match apps/burner-mac BurnerPairingTests,
// the iOS/Android DebugAccess+BurnerPairing tests, and apps/com burnerPairingVector.
const BURNER_PRIV = hex("01".repeat(32));
const PHONE_PRIV = hex("02".repeat(32));
const BURNER_PUB_B64 = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk";
const PHONE_PUB_B64 = "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk";
const ENC_KEY_HEX = "638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136";
const SAS = "658275";
const CODE = hex("0102030405");

describe("burner pairing (TS)", () => {
  it("base32 + base64url round-trip", () => {
    expect(base32Encode(CODE)).toBe("AEBAGBAF");
    expect(toHex(base32Decode("AEBAGBAF")!)).toBe("0102030405");
    expect(base64UrlEncode(hex("0102030405"))).toBe("AQIDBAU");
    expect(toHex(base64UrlDecode("AQIDBAU")!)).toBe("0102030405");
  });

  it("session id + short code vector", () => {
    expect(humanCode(CODE)).toBe("AEBAGBAF");
    expect(sessionId(CODE)).toBe("KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib");
    expect(formatHumanCode("AEBAGBAF")).toBe("AEBA-GBAF");
    expect(toHex(codeBytesFromHuman("aeba-gbaf")!)).toBe("0102030405");
    expect(codeBytesFromHuman("nope!!!")).toBeNull();
  });

  it("derives the pinned public keys", () => {
    expect(base64UrlEncode(x25519.getPublicKey(BURNER_PRIV))).toBe(BURNER_PUB_B64);
    expect(base64UrlEncode(x25519.getPublicKey(PHONE_PRIV))).toBe(PHONE_PUB_B64);
  });

  it("derives the pinned SAS + AEAD key (matches Node/Swift/Kotlin)", () => {
    const mat = deriveSessionMaterial(BURNER_PRIV, base64UrlDecode(PHONE_PUB_B64)!);
    expect(mat.sasCode).toBe(SAS);
    expect(toHex(mat.aeadKey)).toBe(ENC_KEY_HEX);
  });

  it("seal (phone side) → open (burner side) round-trips", () => {
    const burnerPub = x25519.getPublicKey(BURNER_PRIV);
    const phone = deriveSessionMaterial(PHONE_PRIV, burnerPub);
    const burner = deriveSessionMaterial(BURNER_PRIV, x25519.getPublicKey(PHONE_PRIV));
    expect(toHex(phone.aeadKey)).toBe(toHex(burner.aeadKey));
    const plaintext = new TextEncoder().encode('{"hello":"recipe"}');
    const sealed = sealDelivered(plaintext, phone.aeadKey);
    const opened = openDelivered(sealed.ciphertextB64u, sealed.nonceB64u, burner.aeadKey);
    expect(new TextDecoder().decode(opened)).toBe('{"hello":"recipe"}');
  });

  it("qr payload format", () => {
    const p = qrPayload("AEBAGBAF", x25519.getPublicKey(BURNER_PRIV));
    expect(p).toBe(`flagship://burner?c=AEBAGBAF&k=${BURNER_PUB_B64}`);
  });
});
