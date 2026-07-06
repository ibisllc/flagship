import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  ADJECTIVES,
  NOUNS,
  randomCandidate,
  comFormsFor,
  comDomainExists,
  tryGenerateCandidate,
  replenishSuggestionQueue,
  popSuggestion,
  checkSuggestThrottle,
  handleSuggestUsername,
  type SuggestFetch,
} from "../src/randomUsername.js";
import { validateUserLabel } from "../src/labels.js";

/** Deterministic LCG in [0,1) so tests don't flake. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A DoH stub: registered iff the queried `name=` is in `registered`. */
function dohStub(registered: Set<string>, opts: { fail?: boolean } = {}): SuggestFetch {
  return async (url: string) => {
    if (opts.fail) return { ok: false, json: async () => ({}) };
    const name = new URL(url).searchParams.get("name") ?? "";
    const isReg = registered.has(name);
    return {
      ok: true,
      json: async () => (isReg ? { Status: 0, Answer: [{}] } : { Status: 3 }),
    };
  };
}

describe("randomCandidate (adjective-noun, no number)", () => {
  it("is always a valid dashed handle for EVERY word pair", () => {
    for (const adj of ADJECTIVES) {
      for (const noun of NOUNS) {
        const handle = `${adj}-${noun}`;
        const v = validateUserLabel(handle);
        expect(v.ok, `${handle} should be valid`).toBe(true);
        expect(handle).not.toContain("--");
        expect(handle.length).toBeLessThanOrEqual(30);
      }
    }
  });

  it("produces <adjective>-<noun> with no numeric suffix", () => {
    const rng = seededRng(42);
    for (let i = 0; i < 50; i++) {
      const c = randomCandidate(rng);
      expect(c).toMatch(/^[a-z]+-[a-z]+$/);
      expect(c).not.toMatch(/\d/);
      expect(validateUserLabel(c).ok).toBe(true);
    }
  });

  it("adjective + noun word lists are distinct within themselves", () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
  });
});

describe("comFormsFor + comDomainExists", () => {
  it("checks the dashed and de-dashed .com forms", () => {
    expect(comFormsFor("happy-otter")).toEqual(["happy-otter.com", "happyotter.com"]);
    expect(comFormsFor("solo")).toEqual(["solo.com"]); // no dash → one form
  });

  it("excludes a name whose dashed OR de-dashed .com is registered", async () => {
    expect(await comDomainExists("happy-otter", dohStub(new Set(["happyotter.com"])))).toBe(true);
    expect(await comDomainExists("happy-otter", dohStub(new Set(["happy-otter.com"])))).toBe(true);
    expect(await comDomainExists("happy-otter", dohStub(new Set()))).toBe(false);
  });

  it("THROWS on a DoH failure (caller treats unknown as exclude)", async () => {
    await expect(comDomainExists("brave-fox", dohStub(new Set(), { fail: true }))).rejects.toThrow();
  });
});

describe("tryGenerateCandidate", () => {
  it("returns an available, non-.com name", async () => {
    const taken = new Set(["happy-otter"]);
    const name = await tryGenerateCandidate({
      rng: seededRng(7),
      isTaken: (n) => taken.has(n),
      comExists: async (n) => n.startsWith("brave"),
    });
    expect(name).not.toBeNull();
    expect(taken.has(name!)).toBe(false);
    expect(name!.startsWith("brave")).toBe(false);
  });

  it("returns null when every attempt is taken", async () => {
    const name = await tryGenerateCandidate({
      isTaken: () => true,
      maxAttempts: 30,
      rng: seededRng(1),
    });
    expect(name).toBeNull();
  });

  it("treats a comExists THROW as exclude (skips), never surfacing the error", async () => {
    let calls = 0;
    const name = await tryGenerateCandidate({
      rng: seededRng(3),
      isTaken: () => false,
      comExists: async () => {
        calls += 1;
        if (calls < 3) throw new Error("DoH down");
        return false; // 3rd candidate passes
      },
      maxAttempts: 10,
    });
    expect(name).not.toBeNull();
    expect(calls).toBe(3);
  });
});

describe("replenishSuggestionQueue", () => {
  it("fills the queue to target with distinct, available names", async () => {
    const s = new InMemoryStorage();
    const added = await replenishSuggestionQueue({
      queue: s.suggestionQueue,
      usernames: s.usernames,
      rng: seededRng(11),
      now: 1000,
      target: 10,
    });
    expect(added).toBe(10);
    const all = await s.suggestionQueue.list();
    expect(all.length).toBe(10);
    expect(new Set(all).size).toBe(10);
    for (const n of all) expect(validateUserLabel(n).ok).toBe(true);
  });

  it("never enqueues a claimed name or a .com name", async () => {
    const s = new InMemoryStorage();
    await s.usernames.put({ username: "happy-otter", irkPubHex: "aa", claimedAt: 1 });
    await replenishSuggestionQueue({
      queue: s.suggestionQueue,
      usernames: s.usernames,
      comExists: async (n) => n === "brave-fox",
      rng: seededRng(5),
      now: 1000,
      target: 20,
    });
    const all = await s.suggestionQueue.list();
    expect(all).not.toContain("happy-otter");
    expect(all).not.toContain("brave-fox");
  });

  it("is a no-op when the queue is already at target", async () => {
    const s = new InMemoryStorage();
    await s.suggestionQueue.enqueue(["one-fox", "two-owl"], 1);
    const added = await replenishSuggestionQueue({
      queue: s.suggestionQueue,
      usernames: s.usernames,
      now: 1000,
      target: 2,
    });
    expect(added).toBe(0);
  });
});

describe("popSuggestion", () => {
  it("pops FIFO and skips names claimed since enqueue", async () => {
    const s = new InMemoryStorage();
    await s.suggestionQueue.enqueue(["aaa-fox"], 1);
    await s.suggestionQueue.enqueue(["bbb-owl"], 2);
    await s.usernames.put({ username: "aaa-fox", irkPubHex: "aa", claimedAt: 5 }); // claimed in the gap
    const got = await popSuggestion({ queue: s.suggestionQueue, usernames: s.usernames });
    expect(got).toBe("bbb-owl"); // aaa-fox dropped (claimed)
  });

  it("returns null on an empty queue", async () => {
    const s = new InMemoryStorage();
    expect(await popSuggestion({ queue: s.suggestionQueue, usernames: s.usernames })).toBeNull();
  });
});

describe("checkSuggestThrottle (escalating cooldown)", () => {
  it("first suggest is allowed and arms a 2s cooldown; a too-fast second is 429", async () => {
    const s = new InMemoryStorage();
    const first = await checkSuggestThrottle(s.suggestThrottle, "dev1", 1000);
    expect(first.allowed).toBe(true);
    expect(first.retryAfterMs).toBe(2000);
    const tooFast = await checkSuggestThrottle(s.suggestThrottle, "dev1", 1500);
    expect(tooFast.allowed).toBe(false);
    expect(tooFast.retryAfterMs).toBe(1500); // 3000 nextAllowed - 1500 now
  });

  it("escalates 2s → 5s → 10s across successive allowed regenerates", async () => {
    const s = new InMemoryStorage();
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await checkSuggestThrottle(s.suggestThrottle, "dev2", t);
      expect(d.allowed).toBe(true);
      waits.push(d.retryAfterMs);
      t += d.retryAfterMs; // wait exactly the cooldown, then regenerate
    }
    expect(waits).toEqual([2000, 5000, 10000]);
  });

  it("resets to a fresh window after a long idle gap", async () => {
    const s = new InMemoryStorage();
    await checkSuggestThrottle(s.suggestThrottle, "dev3", 0); // count 1
    await checkSuggestThrottle(s.suggestThrottle, "dev3", 2000); // count 2 → 5s
    const afterIdle = await checkSuggestThrottle(s.suggestThrottle, "dev3", 2000 + 11 * 60_000);
    expect(afterIdle.allowed).toBe(true);
    expect(afterIdle.retryAfterMs).toBe(2000); // back to the first-suggest cooldown
  });
});

describe("handleSuggestUsername", () => {
  it("400s a missing or oversized deviceKey", async () => {
    const s = new InMemoryStorage();
    const deps = { queue: s.suggestionQueue, usernames: s.usernames, throttle: s.suggestThrottle };
    expect((await handleSuggestUsername(deps, {})).status).toBe(400);
    expect((await handleSuggestUsername(deps, { deviceKey: "x".repeat(200) })).status).toBe(400);
  });

  it("200s with a queued name + retryAfterMs, then 429s a too-fast regenerate", async () => {
    const s = new InMemoryStorage();
    await s.suggestionQueue.enqueue(["alpha-fox", "beta-owl"], 1);
    const deps = { queue: s.suggestionQueue, usernames: s.usernames, throttle: s.suggestThrottle, now: 1000 };
    const r1 = await handleSuggestUsername(deps, { deviceKey: "devA" });
    expect(r1.status).toBe(200);
    expect((r1.body as { name: string }).name).toBe("alpha-fox");
    expect((r1.body as { retryAfterMs: number }).retryAfterMs).toBe(2000);
    // The popped name is GONE from the queue (refused-is-lost).
    expect(await s.suggestionQueue.list()).toEqual(["beta-owl"]);
    // Same device, immediately → throttled.
    const r2 = await handleSuggestUsername({ ...deps, now: 1100 }, { deviceKey: "devA" });
    expect(r2.status).toBe(429);
  });

  it("records the returned name on the offer roster (so it becomes claimable)", async () => {
    const s = new InMemoryStorage();
    const deps = {
      queue: s.suggestionQueue,
      usernames: s.usernames,
      throttle: s.suggestThrottle,
      offers: s.usernameOffers,
      now: 5000,
    };
    const r = await handleSuggestUsername(deps, { deviceKey: "devO" });
    const name = (r.body as { name: string }).name;
    expect(await s.usernameOffers.isOffered(name, 0)).toBe(true);
  });

  it("falls back to inline generation (no DNS) when the queue is empty", async () => {
    const s = new InMemoryStorage();
    const deps = { queue: s.suggestionQueue, usernames: s.usernames, throttle: s.suggestThrottle, now: 1, rng: seededRng(9) };
    const r = await handleSuggestUsername(deps, { deviceKey: "devB" });
    expect(r.status).toBe(200);
    expect(validateUserLabel((r.body as { name: string }).name).ok).toBe(true);
  });
});
