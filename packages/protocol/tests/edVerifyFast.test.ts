/**
 * `ed.verify` remembers triples it has checked, and `edVerifyFast` checks with
 * the platform's native Ed25519 first. Neither may change a verdict: the fast
 * path must agree with the plain noble check on valid, forged, malleable and
 * malformed input, and a remembered answer must not outlive the inputs it
 * was for.
 */
import { describe, expect, it } from "vitest";
import { ed, edVerifyFast } from "../src/index.js";

const sk = (n: number) => new Uint8Array(32).fill(n);
const msg = new TextEncoder().encode("flagship/test/v1|alice|1700000000000");
const hex = (b: Uint8Array) => ed.etc.bytesToHex(b);

// The group order, little-endian, to build a malleable S+L signature.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
function addL(sig: Uint8Array): Uint8Array {
  const out = sig.slice();
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
  s += L;
  for (let i = 0; i < 32; i++) {
    out[32 + i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

describe("edVerifyFast agrees with ed.verify", () => {
  const pub = ed.getPublicKey(sk(7));
  const sig = ed.sign(msg, sk(7));
  const wrongPub = ed.getPublicKey(sk(8));
  const flipped = sig.slice();
  flipped[10] ^= 1;
  const otherMsg = new TextEncoder().encode("flagship/test/v1|alice|1700000000001");
  const zeroPub = new Uint8Array(32);
  const cases: [string, Uint8Array, Uint8Array, Uint8Array][] = [
    ["valid", sig, msg, pub],
    ["wrong key", sig, msg, wrongPub],
    ["bit-flipped signature", flipped, msg, pub],
    ["different message", sig, otherMsg, pub],
    ["malleable S+L", addL(sig), msg, pub],
    ["all-zero (low-order) key with a zero signature", new Uint8Array(64), msg, zeroPub],
    ["short signature", sig.slice(0, 63), msg, pub],
    ["short key", sig, msg, pub.slice(0, 31)],
    ["empty message", ed.sign(new Uint8Array(0), sk(7)), new Uint8Array(0), pub],
  ];
  for (const [name, s, m, p] of cases) {
    it(name, async () => {
      expect(await edVerifyFast(s, m, p)).toBe(ed.verify(s, m, p));
    });
  }

  it("a valid signature is accepted, a forged one is not", async () => {
    expect(await edVerifyFast(sig, msg, pub)).toBe(true);
    expect(await edVerifyFast(flipped, msg, pub)).toBe(false);
  });

  it("takes hex strings as ed.verify does", async () => {
    expect(await edVerifyFast(hex(sig), hex(msg), hex(pub))).toBe(true);
  });
});

describe("ed.verify memory of verified triples", () => {
  it("gives the same answer the second time, for both outcomes", () => {
    const pub = ed.getPublicKey(sk(21));
    const good = ed.sign(msg, sk(21));
    const bad = good.slice();
    bad[3] ^= 0x40;
    for (let i = 0; i < 3; i++) {
      expect(ed.verify(good, msg, pub)).toBe(true);
      expect(ed.verify(bad, msg, pub)).toBe(false);
    }
  });

  it("a remembered success is only for exactly that signature, message and key", () => {
    const pub = ed.getPublicKey(sk(22));
    const good = ed.sign(msg, sk(22));
    expect(ed.verify(good, msg, pub)).toBe(true);
    const other = new TextEncoder().encode("different");
    expect(ed.verify(good, other, pub)).toBe(false);
    expect(ed.verify(good, msg, ed.getPublicKey(sk(23)))).toBe(false);
    const flipped = good.slice();
    flipped[0] ^= 1;
    expect(ed.verify(flipped, msg, pub)).toBe(false);
  });

  it("a flood of bad signatures cannot make a remembered good one fail", () => {
    const pub = ed.getPublicKey(sk(24));
    const good = ed.sign(msg, sk(24));
    expect(ed.verify(good, msg, pub)).toBe(true);
    for (let i = 0; i < 600; i++) {
      const bad = good.slice();
      bad[0] = i & 0xff;
      bad[1] = (i >> 8) & 0xff;
      bad[63] ^= 0x01;
      expect(ed.verify(bad, msg, pub)).toBe(false);
    }
    expect(ed.verify(good, msg, pub)).toBe(true);
  });

  it("the low-order key blocklist still applies after a remembered success elsewhere", () => {
    const pub = ed.getPublicKey(sk(25));
    expect(ed.verify(ed.sign(msg, sk(25)), msg, pub)).toBe(true);
    expect(ed.verify(new Uint8Array(64), msg, new Uint8Array(32))).toBe(false);
  });
});
