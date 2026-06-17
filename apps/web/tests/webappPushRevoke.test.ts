/**
 * Webapp push-token-revoke canonical bytes — byte-identical to
 * @flagship/protocol's `canonicalPushTokenRevoke` so the IRK-signed revoke
 * the webapp sends is verifiable by `.com`. Pins the same vector the
 * protocol + Swift + Kotlin mirrors pin.
 */
import { describe, expect, it } from "vitest";
import { canonicalPushRevoke } from "../public/webapp/lib/push.js";
import {
  canonicalPushTokenRevoke,
  signPushTokenRevoke,
  verifyPushTokenRevoke,
  ed,
  type PushTokenRevoke,
} from "@flagship/protocol";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const REQUEST: PushTokenRevoke = {
  tokenId: "0123456789abcdef0123456789abcdef",
  issuedAt: 1_700_000_000_000,
};

describe("webapp push-token-revoke — canonical-bytes parity with @flagship/protocol", () => {
  it("composes the exact pinned byte string", () => {
    const got = new TextDecoder().decode(canonicalPushRevoke(REQUEST));
    expect(got).toBe(
      "flagship/push-token-revoke/v1|0123456789abcdef0123456789abcdef|1700000000000",
    );
  });

  it("is byte-identical to the protocol generator", () => {
    expect(bytesToHex(canonicalPushRevoke(REQUEST))).toBe(
      bytesToHex(canonicalPushTokenRevoke(REQUEST)),
    );
  });

  it("a webapp-built canonical signs + verifies under the protocol verifier", () => {
    const priv = new Uint8Array(32);
    for (let i = 0; i < 32; i++) priv[i] = 0x11;
    const pub = ed.getPublicKey(priv);
    const sig = ed.sign(canonicalPushRevoke(REQUEST), priv);
    expect(verifyPushTokenRevoke(REQUEST, sig, pub)).toBe(true);
    // and the protocol sign helper produces the same bytes the webapp would
    expect(bytesToHex(signPushTokenRevoke(REQUEST, { privateKey: priv, publicKey: pub }))).toBe(
      bytesToHex(sig),
    );
  });

  it("field-guards a tokenId carrying the separator", () => {
    expect(() => canonicalPushRevoke({ tokenId: "ab|cd", issuedAt: 1 })).toThrow();
  });
});
