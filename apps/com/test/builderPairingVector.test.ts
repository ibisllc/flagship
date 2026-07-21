import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Canonical cross-platform vector for the phone↔builder pairing crypto.
 *
 * The builder (Swift, apps/builder-mac) and the phone (Swift/Kotlin) each
 * implement the SAME X25519 → HKDF-SHA256 derivation (salt `flagship/qr/v1`,
 * info `…/sas/v1` + `…/enc/v1`) plus the short-code → session-id mapping
 * (`flagship/builder-sid/v1`). This test recomputes the vector from fixed
 * raw keys with Node's `crypto` and pins the outputs; the Swift builder test
 * (BuilderPairingTests.test_crossPlatformVector) asserts the IDENTICAL
 * constants. If either side moves a salt/info/tag, one of the two breaks.
 *
 * The relay DO itself (builderRelay.ts) is crypto-blind — it never sees keys
 * — so this is the authoritative home for the shared constants.
 */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
function privFromRaw(raw: Buffer) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}
function rawPub(priv: crypto.KeyObject): Buffer {
  const spki = crypto.createPublicKey(priv).export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32);
}
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("builder pairing — cross-platform crypto vector", () => {
  const builderRaw = Buffer.from("01".repeat(32), "hex");
  const phoneRaw = Buffer.from("02".repeat(32), "hex");
  const builderPriv = privFromRaw(builderRaw);
  const phonePriv = privFromRaw(phoneRaw);

  it("derives the pinned public keys, SAS and AEAD key", () => {
    expect(b64url(rawPub(builderPriv))).toBe("pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk");
    expect(b64url(rawPub(phonePriv))).toBe("zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk");

    const shared = crypto.diffieHellman({ privateKey: builderPriv, publicKey: crypto.createPublicKey(phonePriv) });
    expect(shared.toString("hex")).toBe("2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953");

    const salt = Buffer.from("flagship/qr/v1");
    const enc = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("flagship/qr/enc/v1"), 32));
    expect(enc.toString("hex")).toBe("638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136");

    const sas4 = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("flagship/qr/sas/v1"), 4));
    const u32 = ((sas4[0]! << 24) | (sas4[1]! << 16) | (sas4[2]! << 8) | sas4[3]!) >>> 0;
    expect(String(u32 % 1_000_000).padStart(6, "0")).toBe("658275");
  });

  it("derives the pinned session id + short code from the code bytes", () => {
    const codeBytes = Buffer.from("0102030405", "hex");
    const sidFull = crypto.createHash("sha256")
      .update(Buffer.concat([Buffer.from("flagship/builder-sid/v1"), codeBytes]))
      .digest();
    expect(b64url(sidFull).slice(0, 32)).toBe("F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb");

    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let out = "", buf = 0, bits = 0;
    for (const byte of codeBytes) { buf = (buf << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += A[(buf >> bits) & 31]; } }
    if (bits > 0) out += A[(buf << (5 - bits)) & 31];
    expect(out).toBe("AEBAGBAF");
  });
});
