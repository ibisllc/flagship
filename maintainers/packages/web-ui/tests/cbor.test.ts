/**
 * Tests for the minimal CBOR decoder. We don't test the WebAuthn
 * integration end-to-end (that requires a real authenticator) — we
 * verify the decoder handles the shapes a WebAuthn attestationObject
 * actually carries (small integers, byte strings, text strings, maps,
 * nested maps, signed integers).
 */
import { describe, expect, it } from "vitest";
import { decodeCbor } from "../src/cbor.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("cbor", () => {
  it("decodes a small unsigned int", () => {
    expect(decodeCbor(hexToBytes("00"))).toBe(0);
    expect(decodeCbor(hexToBytes("17"))).toBe(23);
    expect(decodeCbor(hexToBytes("1818"))).toBe(24);
    expect(decodeCbor(hexToBytes("18ff"))).toBe(255);
    expect(decodeCbor(hexToBytes("190100"))).toBe(256);
  });

  it("decodes a signed int", () => {
    expect(decodeCbor(hexToBytes("20"))).toBe(-1);
    expect(decodeCbor(hexToBytes("27"))).toBe(-8);
  });

  it("decodes a byte string", () => {
    const out = decodeCbor(hexToBytes("43010203"));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("decodes a text string", () => {
    expect(decodeCbor(hexToBytes("63666f6f"))).toBe("foo");
  });

  it("decodes a fixed-length array", () => {
    // [1, 2, 3]
    const out = decodeCbor(hexToBytes("83010203"));
    expect(out).toEqual([1, 2, 3]);
  });

  it("decodes a map keyed by ints (COSE_Key shape)", () => {
    // {1: 1, 3: -8, -1: 6, -2: h'01020304'}  — kty=1, alg=-8, crv=6, x=...
    const bytes = hexToBytes("a4" + "0101" + "0327" + "2006" + "21" + "44" + "01020304");
    const m = decodeCbor(bytes) as Map<number, unknown>;
    expect(m.get(1)).toBe(1);
    expect(m.get(3)).toBe(-8);
    expect(m.get(-1)).toBe(6);
    expect(m.get(-2)).toBeInstanceOf(Uint8Array);
    expect(Array.from(m.get(-2) as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("decodes a valid nested map (attestationObject-style shape)", () => {
    // { "fmt": "none", "authData": h'00010203' }
    // a2                      map with 2 entries
    // 63 666d74               "fmt" (3 byte string)
    // 64 6e6f6e65             "none" (4 byte string)
    // 68 61757468 44617461    "authData" (8 byte string)
    // 44 00010203             h'00010203' (4 byte string)
    const bytes = hexToBytes(
      "a2" + "63" + "666d74" + "64" + "6e6f6e65" +
      "68" + "6175746844617461" + "44" + "00010203",
    );
    const m = decodeCbor(bytes) as Map<unknown, unknown>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get("fmt")).toBe("none");
    expect(m.get("authData")).toBeInstanceOf(Uint8Array);
  });

  it("rejects trailing bytes", () => {
    expect(() => decodeCbor(hexToBytes("0000"))).toThrow(/trailing bytes/);
  });

  it("rejects truncated byte string", () => {
    expect(() => decodeCbor(hexToBytes("4300"))).toThrow();
  });
});
