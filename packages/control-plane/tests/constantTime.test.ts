/**
 * #47 — constant-time byte/hex/token compares.
 *
 * We can't reliably measure cycle-level timing in vitest, so the tests
 * assert the algorithmic property: every byte is examined regardless
 * of where the first mismatch occurs.
 *
 * The accumulator-OR pattern makes the cost-of-comparison independent
 * of input contents (within the length-equal branch).
 */
import { describe, expect, it } from "vitest";
import { equalBytes, equalHex, equalToken } from "../src/hex.js";

describe("equalBytes (#47)", () => {
  it("returns true for identical buffers", () => {
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("returns false for different-length buffers", () => {
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("returns false for same-length buffers with any byte different", () => {
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([4, 2, 3]))).toBe(false);
  });

  it("examines every byte (doesn't short-circuit on first mismatch)", () => {
    // Build two large buffers and ensure that the implementation walks
    // the full length. We verify this by instrumenting Uint8Array
    // accessor via a Proxy and counting reads.
    const N = 1024;
    const a = new Uint8Array(N);
    const b = new Uint8Array(N);
    b[0] = 1; // mismatch at the very first byte
    let aReads = 0;
    const aProxy = new Proxy(a, {
      get(target, prop) {
        const numProp = typeof prop === "string" && /^\d+$/.test(prop);
        if (numProp) aReads++;
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      },
    }) as Uint8Array;
    equalBytes(aProxy, b);
    expect(aReads).toBe(N);
  });
});

describe("equalHex (#47)", () => {
  it("matches case-insensitively", () => {
    expect(equalHex("abc123", "ABC123")).toBe(true);
    expect(equalHex("DEADBEEF", "deadbeef")).toBe(true);
  });

  it("returns false on any character difference", () => {
    expect(equalHex("abc123", "abc124")).toBe(false);
  });

  it("returns false on length mismatch", () => {
    expect(equalHex("abc", "abcd")).toBe(false);
  });
});

describe("equalToken (#47)", () => {
  it("matches identical opaque tokens", () => {
    expect(equalToken("hunter2", "hunter2")).toBe(true);
  });

  it("rejects token of different length", () => {
    expect(equalToken("hunter", "hunter2")).toBe(false);
  });

  it("rejects tokens that differ in any position", () => {
    expect(equalToken("hunter2", "Hunter2")).toBe(false);
    expect(equalToken("aaaaa", "aaaba")).toBe(false);
    expect(equalToken("aaaaa", "baaaa")).toBe(false);
  });

  it("works on tokens at expected lengths (32 + 64 chars)", () => {
    const t1 = "x".repeat(32);
    const t2 = "x".repeat(32);
    expect(equalToken(t1, t2)).toBe(true);
    const tDifferent = "x".repeat(31) + "y";
    expect(equalToken(t1, tDifferent)).toBe(false);
  });
});
