import { describe, expect, it } from "vitest";
import { decodeShards, encodeShards } from "../src/erasure.js";
import { gfDiv, gfInv, gfMul, gfPow } from "../src/gf256.js";

describe("GF(2^8) primitives", () => {
  it("multiplicative identity holds: a * 1 = a", () => {
    for (let a = 0; a < 256; a++) expect(gfMul(a, 1)).toBe(a);
  });
  it("multiplication is commutative", () => {
    for (let i = 0; i < 256; i += 17) {
      for (let j = 0; j < 256; j += 23) {
        expect(gfMul(i, j)).toBe(gfMul(j, i));
      }
    }
  });
  it("multiplying by zero gives zero", () => {
    expect(gfMul(0, 0xab)).toBe(0);
    expect(gfMul(0xcd, 0)).toBe(0);
  });
  it("a * inv(a) = 1 for non-zero a", () => {
    for (let a = 1; a < 256; a++) {
      expect(gfMul(a, gfInv(a))).toBe(1);
    }
  });
  it("a / a = 1 for non-zero a", () => {
    for (let a = 1; a < 256; a++) {
      expect(gfDiv(a, a)).toBe(1);
    }
  });
  it("pow: a^0 = 1, a^1 = a, a^2 = a*a", () => {
    expect(gfPow(0xab, 0)).toBe(1);
    expect(gfPow(0xab, 1)).toBe(0xab);
    expect(gfPow(0xab, 2)).toBe(gfMul(0xab, 0xab));
  });
});

describe("Reed-Solomon encode/decode (real K-of-N over GF(2^8))", () => {
  it("K=1 N=3 trivial replication still works", () => {
    const data = new TextEncoder().encode("hello");
    const out = encodeShards(data, 1, 3);
    const recovered = decodeShards([null, out.shards[1] ?? null, null], 1, 3, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=10 N=16 — roundtrip with no losses", () => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
    const out = encodeShards(data, 10, 16);
    expect(out.shards.length).toBe(16);
    expect(out.dataLength).toBe(data.length);
    const recovered = decodeShards(out.shards, 10, 16, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=10 N=16 — recovers from losing any 6 (n-k) shards", () => {
    const data = new Uint8Array(2048);
    for (let i = 0; i < data.length; i++) data[i] = (i * 71 + 13) & 0xff;
    const out = encodeShards(data, 10, 16);
    // Lose 6 shards: indices 1, 3, 5, 7, 9, 11
    const survivors: (Uint8Array | null)[] = out.shards.map((s, i) =>
      [1, 3, 5, 7, 9, 11].includes(i) ? null : s,
    );
    const recovered = decodeShards(survivors, 10, 16, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=10 N=16 — recovers from losing all 6 parity shards (data-only survival)", () => {
    const data = new Uint8Array(512);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const out = encodeShards(data, 10, 16);
    // Lose all parity shards (indices 10..15)
    const survivors: (Uint8Array | null)[] = out.shards.map((s, i) =>
      i >= 10 ? null : s,
    );
    const recovered = decodeShards(survivors, 10, 16, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=10 N=16 — recovers from losing all 10 data shards (parity-only survival)", () => {
    const data = new Uint8Array(512);
    for (let i = 0; i < data.length; i++) data[i] = (i * 91) & 0xff;
    const out = encodeShards(data, 10, 16);
    // Keep only parity shards: indices 10..15 (6 shards), plus 4 more
    // data shards to reach K=10 survivors. Wait — losing 10, keeping 6, can't recover.
    // Keep parity (10..15) + first 4 data (0..3) = 10 survivors
    const survivors: (Uint8Array | null)[] = out.shards.map((s, i) =>
      i < 4 || i >= 10 ? s : null,
    );
    const recovered = decodeShards(survivors, 10, 16, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=10 N=16 — fails when fewer than K shards survive", () => {
    const data = new Uint8Array(64);
    const out = encodeShards(data, 10, 16);
    // Keep only 9 shards
    const survivors: (Uint8Array | null)[] = out.shards.map((s, i) => (i < 9 ? s : null));
    expect(() => decodeShards(survivors, 10, 16, data.length)).toThrow();
  });

  it("data shards (first K) are byte-identical slices of the input (systematic property)", () => {
    const data = new TextEncoder().encode("aaaaabbbbbcccccddddd"); // 20 bytes
    const out = encodeShards(data, 4, 6); // shardLen = 5
    expect(Array.from(out.shards[0]!)).toEqual(Array.from(data.subarray(0, 5)));
    expect(Array.from(out.shards[1]!)).toEqual(Array.from(data.subarray(5, 10)));
    expect(Array.from(out.shards[2]!)).toEqual(Array.from(data.subarray(10, 15)));
    expect(Array.from(out.shards[3]!)).toEqual(Array.from(data.subarray(15, 20)));
  });

  it("handles non-multiple data lengths (padding round-trip)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]); // 7 bytes, k=3 → shardLen=3, padded to 9
    const out = encodeShards(data, 3, 5);
    const recovered = decodeShards(out.shards, 3, 5, data.length);
    expect(recovered).toEqual(data);
  });

  it("K=20 N=32 — heavier redundancy still works", () => {
    const data = new Uint8Array(4000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 251) & 0xff;
    const out = encodeShards(data, 20, 32);
    // Lose 12 shards (n-k = 12)
    const lost = new Set([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    const survivors: (Uint8Array | null)[] = out.shards.map((s, i) => (lost.has(i) ? null : s));
    const recovered = decodeShards(survivors, 20, 32, data.length);
    expect(recovered).toEqual(data);
  });

  it("rejects nonsensical k, n combinations", () => {
    expect(() => encodeShards(new Uint8Array(8), 0, 3)).toThrow();
    expect(() => encodeShards(new Uint8Array(8), 5, 3)).toThrow();
    expect(() => encodeShards(new Uint8Array(8), 1, 256)).toThrow();
  });
});
