import { describe, expect, it } from "vitest";
import { ed, signAuthTime, parseAuthTime, verifyAuthTime, canonicalAuthTime, type CaTrustChain } from "../src/index.js";

const PIN = "ab".repeat(32);
const caPriv = new Uint8Array(32).fill(7);
const ca = { privateKey: caPriv, publicKey: ed.getPublicKey(caPriv) };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const chain = (keys: string[]): CaTrustChain => ({ authorizedCaKeys: () => keys }) as unknown as CaTrustChain;
const NONCE = "0123456789abcdef0123456789abcdef";

describe("authenticated time", () => {
  it("a stamp for this nonce, signed by an authorized CA key, verifies", () => {
    const s = signAuthTime(NONCE, 1_760_000_000_000, ca);
    expect(verifyAuthTime(s, NONCE, chain([hex(ca.publicKey)]), PIN)).toEqual({ ok: true });
    expect(new TextDecoder().decode(canonicalAuthTime(NONCE, 5))).toBe(`flagship/auth-time/v1|${NONCE}|5`);
  });

  it("a replayed stamp (another nonce), an unauthorized key and no chain are refused", () => {
    const s = signAuthTime(NONCE, 1, ca);
    expect(verifyAuthTime(s, "f".repeat(32), chain([hex(ca.publicKey)]), PIN)).toEqual({ ok: false, reason: "wrong-nonce" });
    const other = ed.getPublicKey(new Uint8Array(32).fill(9));
    expect(verifyAuthTime(s, NONCE, chain([hex(other)]), PIN).ok).toBe(false);
    expect(verifyAuthTime(s, NONCE, null, PIN).ok).toBe(false);
  });

  it("a stamp with a changed time does not verify, and junk does not parse", () => {
    const s = signAuthTime(NONCE, 100, ca);
    expect(verifyAuthTime({ ...s, nowMs: 101 }, NONCE, chain([hex(ca.publicKey)]), PIN).ok).toBe(false);
    expect(parseAuthTime({ ...s, nonceHex: "xyz" })).toBeNull();
    expect(parseAuthTime(null)).toBeNull();
    expect(parseAuthTime(s)).toEqual(s);
  });
});
