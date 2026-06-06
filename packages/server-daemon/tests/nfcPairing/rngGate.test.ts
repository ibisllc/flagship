import { describe, expect, it } from "vitest";
import {
  ENTROPY_THRESHOLD_BITS,
  checkEntropy,
  type EntropyReader,
} from "../../src/nfcPairing/rngGate.js";

function reader(value: number | null): EntropyReader {
  return { read: () => value };
}

describe("RNG entropy gate (N-BOX-2)", () => {
  it("passes when entropy_avail ≥ 256", () => {
    const r = checkEntropy(reader(256));
    expect(r.ok).toBe(true);
    expect(r.available).toBe(256);
    expect(r.threshold).toBe(ENTROPY_THRESHOLD_BITS);
  });

  it("blocks below threshold", () => {
    const r = checkEntropy(reader(255));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/below threshold/);
  });

  it("blocks (soft fail) when reader returns null", () => {
    const r = checkEntropy(reader(null));
    expect(r.ok).toBe(false);
    expect(r.available).toBeNull();
    expect(r.reason).toMatch(/unreadable/);
  });

  it("respects a custom threshold", () => {
    const r = checkEntropy(reader(200), 192);
    expect(r.ok).toBe(true);
    expect(r.threshold).toBe(192);
  });

  it("treats threshold exactly = available as passing", () => {
    const r = checkEntropy(reader(300), 300);
    expect(r.ok).toBe(true);
  });
});
