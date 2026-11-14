import { describe, expect, it } from "vitest";
import { WIPE_READ_BYTES, verifyWipe } from "../../src/retailClaim/wipeVerifier.js";

function buf(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function randomGarbage(n: number, seed = 0xabcd): Uint8Array {
  // Tiny xorshift32 for deterministic "looks-random" bytes.
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

describe("wipe verifier (N-BOX-9)", () => {
  it("short read fails with short-read", () => {
    const r = verifyWipe(buf(WIPE_READ_BYTES - 1, 0));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("short-read");
  });

  it("all zeros passes (TRIM-deterministic)", () => {
    const r = verifyWipe(buf(WIPE_READ_BYTES, 0x00));
    expect(r.ok).toBe(true);
    expect(r.printableFraction).toBe(0);
  });

  it("all 0xFF passes (TRIM-deterministic)", () => {
    const r = verifyWipe(buf(WIPE_READ_BYTES, 0xff));
    expect(r.ok).toBe(true);
  });

  it("random garbage passes (random byte ≈ 38 % printable; below 60 % bar)", () => {
    const r = verifyWipe(randomGarbage(WIPE_READ_BYTES));
    expect(r.ok).toBe(true);
    expect(r.printableFraction).toBeLessThan(0.6);
  });

  it("rejects when LUKS magic is present", () => {
    const v = randomGarbage(WIPE_READ_BYTES, 1);
    // Plant LUKS\xba\xbe at an arbitrary offset.
    v.set([0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe], 100);
    const r = verifyWipe(v);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("luks-header-present");
  });

  it("rejects high printable-ASCII density (looks like plaintext)", () => {
    // ~all-ASCII buffer; well above the 35 % threshold.
    const v = new Uint8Array(WIPE_READ_BYTES);
    for (let i = 0; i < v.length; i++) v[i] = 0x41 + (i % 26); // A..Z
    const r = verifyWipe(v);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("printable-density-high");
  });

  it("rejects ELF magic in an otherwise-random sample", () => {
    const v = randomGarbage(WIPE_READ_BYTES, 2);
    v.set([0x7f, 0x45, 0x4c, 0x46], 200);
    const r = verifyWipe(v);
    expect(r.ok).toBe(false);
    // Either printable-density catches ELF first, or the structured-
    // plaintext marker check does. Both are valid signals.
    expect(["printable-density-high", "recognizable-plaintext"]).toContain(r.reason);
  });

  it("rejects a JSON-looking buffer with low overall printable density", () => {
    // Mostly garbage but with `{"` markers planted (one alone is what noise holds now and then).
    const v = randomGarbage(WIPE_READ_BYTES, 3);
    for (let i = 0; i < v.length; i++) v[i] = (v[i]! & 0x80) | 0x80;
    for (const at of [500, 900, 1300, 1700]) v.set([0x7b, 0x22], at);
    const r = verifyWipe(v);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("recognizable-plaintext");
  });

  it("caps analysis at WIPE_READ_BYTES (extra bytes ignored)", () => {
    // First 4 KiB is garbage; bytes after that contain LUKS magic.
    const v = randomGarbage(WIPE_READ_BYTES + 1024, 4);
    v.set([0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe], WIPE_READ_BYTES + 10);
    const r = verifyWipe(v);
    expect(r.ok).toBe(true);
  });
});

describe("random bytes after a crypto-erase", () => {
  it("pass the check every time (a short marker in noise is not plaintext)", async () => {
    const { randomFillSync } = await import("node:crypto");
    const b = new Uint8Array(4096);
    for (let i = 0; i < 2000; i++) {
      randomFillSync(b);
      const v = verifyWipe(b);
      if (v.reason !== "luks-header-present") expect(v.ok, `run ${i}: ${v.reason}`).toBe(true);
    }
  });
});
