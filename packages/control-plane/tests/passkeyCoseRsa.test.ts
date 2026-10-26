import { describe, expect, it } from "vitest";
import { parseCoseKey } from "../src/passkeyAssertion.js";

// COSE RSA key as CBOR: {1: 3, 3: -257, -1: n (256 bytes), -2: e}
const rsa = (e: number[]) =>
  Uint8Array.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x59, 0x01, 0x00, ...new Array(256).fill(0xab), 0x21, 0x40 + e.length, ...e]);

describe("parseCoseKey RSA", () => {
  it("takes the usual public exponent 65537", () => {
    expect(parseCoseKey(rsa([1, 0, 1])).alg).toBe(-257);
  });
  it("refuses any other exponent", () => {
    for (const e of [[3], [1, 0, 3], [0, 0, 1], [1, 0, 1, 0]]) expect(() => parseCoseKey(rsa(e)), String(e)).toThrow(/65537/);
  });
});
