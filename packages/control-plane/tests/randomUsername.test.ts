import { describe, expect, it } from "vitest";
import {
  ADJECTIVES,
  NOUNS,
  randomCandidate,
  generateAvailable,
  handleRandomUsername,
} from "../src/randomUsername.js";
import { validateUserLabel, _labelInternal } from "../src/labels.js";

/** Deterministic LCG in [0,1) so tests don't flake. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("randomCandidate", () => {
  it("is always a valid, ≤30-char dashed username (grammar holds for every word pair)", () => {
    // Exhaustively check the building blocks: the longest possible handle must
    // pass validateUserLabel — interior single dashes, no `--`, no leading/
    // trailing dash, ≤30 chars.
    for (const adj of ADJECTIVES) {
      for (const noun of NOUNS) {
        const handle = `${adj}-${noun}-9999`;
        const v = validateUserLabel(handle);
        expect(v.ok, `${handle} should be valid`).toBe(true);
        expect(handle).not.toContain("--");
        expect(handle.length).toBeLessThanOrEqual(30);
      }
    }
  });

  it("produces <adjective>-<noun>-<4-digit> shapes", () => {
    const rng = seededRng(42);
    for (let i = 0; i < 50; i++) {
      const c = randomCandidate(rng);
      expect(c).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
      expect(validateUserLabel(c).ok).toBe(true);
    }
  });
});

describe("generateAvailable", () => {
  it("returns N distinct, available, grammar-valid candidates", async () => {
    const out = await generateAvailable({
      isTaken: () => false,
      count: 5,
      rng: seededRng(7),
    });
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    for (const n of out) expect(validateUserLabel(n).ok).toBe(true);
  });

  it("skips taken names", async () => {
    const taken = new Set<string>();
    // Take the first thing a fixed seed would produce, prove it's not returned.
    const first = randomCandidate(seededRng(7));
    taken.add(first);
    const out = await generateAvailable({
      isTaken: (n) => taken.has(n),
      count: 3,
      rng: seededRng(7),
    });
    expect(out).not.toContain(first);
    expect(out).toHaveLength(3);
  });

  it("never leaks a reserved name (validateUserLabel guard)", async () => {
    const reserved = [..._labelInternal.RESERVED_USER_LABELS];
    const out = await generateAvailable({ isTaken: () => false, count: 8, rng: seededRng(99) });
    for (const n of out) expect(reserved).not.toContain(n);
  });

  it("terminates (returns ≤count) even when everything is taken", async () => {
    const out = await generateAvailable({
      isTaken: () => true,
      count: 5,
      rng: seededRng(1),
      maxAttempts: 50,
    });
    expect(out).toHaveLength(0);
  });
});

describe("handleRandomUsername", () => {
  it("returns available candidates from the username storage", async () => {
    const store = new Map<string, object>();
    const fakeStorage = {
      get: async (u: string) => store.get(u),
    } as unknown as Parameters<typeof handleRandomUsername>[0];

    const r = await handleRandomUsername(fakeStorage, 4);
    expect(r.status).toBe(200);
    const body = r.body as { candidates: string[] };
    expect(body.candidates).toHaveLength(4);
    for (const c of body.candidates) {
      expect(validateUserLabel(c).ok).toBe(true);
      expect(store.has(c)).toBe(false);
    }
  });
});
