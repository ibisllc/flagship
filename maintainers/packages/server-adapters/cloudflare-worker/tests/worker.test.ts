/**
 * Tests for Worker helper functions: repo-URL parsing, allowlist,
 * in-memory rate-limit fallback, base64 round-trip.
 */

import { describe, expect, it } from "vitest";
import { __test } from "../src/worker.js";

const { parseRepoUrl, isRepoAllowed, checkRateLimit, base64Encode, base64Decode } = __test;

describe("parseRepoUrl()", () => {
  it("accepts plain owner/repo on github.com", () => {
    const r = parseRepoUrl("github.com/foo/bar");
    expect(r?.canonical).toBe("github.com/foo/bar");
    expect(r?.owner).toBe("foo");
    expect(r?.repo).toBe("bar");
  });

  it("accepts https:// prefix and strips .git", () => {
    const r = parseRepoUrl("https://github.com/foo/bar.git");
    expect(r?.canonical).toBe("github.com/foo/bar");
  });

  it("rejects non-github hosts", () => {
    expect(parseRepoUrl("gitlab.com/foo/bar")).toBeNull();
  });

  it("rejects malformed paths", () => {
    expect(parseRepoUrl("github.com/foo")).toBeNull();
    expect(parseRepoUrl("github.com/foo/bar/baz")).toBeNull();
  });

  it("rejects owner/repo with disallowed characters", () => {
    expect(parseRepoUrl("github.com/foo bar/baz")).toBeNull();
    expect(parseRepoUrl("github.com/foo/bar..baz")).not.toBeNull(); // dots are allowed
    expect(parseRepoUrl("github.com/foo/$bar")).toBeNull();
  });
});

describe("isRepoAllowed()", () => {
  it("deny-all on empty config", () => {
    expect(isRepoAllowed("github.com/foo/bar", "")).toBe(false);
    expect(isRepoAllowed("github.com/foo/bar", undefined)).toBe(false);
  });

  it("matches a single repo", () => {
    expect(isRepoAllowed("github.com/foo/bar", "github.com/foo/bar")).toBe(true);
    expect(isRepoAllowed("github.com/foo/baz", "github.com/foo/bar")).toBe(false);
  });

  it("matches comma-separated list with whitespace", () => {
    expect(isRepoAllowed("github.com/a/b", "github.com/x/y, github.com/a/b")).toBe(true);
    expect(isRepoAllowed("github.com/z/z", "github.com/x/y, github.com/a/b")).toBe(false);
  });
});

describe("checkRateLimit() — in-memory fallback", () => {
  it("permits up to the configured limit and then refuses", async () => {
    const env = { RATE_LIMITER: undefined } as Parameters<typeof checkRateLimit>[0];
    const limit = 3;
    const key = `t1-${Math.random()}`;
    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit(env, key, limit);
      expect(r.ok).toBe(true);
    }
    const fourth = await checkRateLimit(env, key, limit);
    expect(fourth.ok).toBe(false);
  });

  it("isolates buckets by key", async () => {
    const env = { RATE_LIMITER: undefined } as Parameters<typeof checkRateLimit>[0];
    const r1 = await checkRateLimit(env, `kA-${Math.random()}`, 1);
    const r2 = await checkRateLimit(env, `kB-${Math.random()}`, 1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("delegates to a bound RATE_LIMITER if present", async () => {
    let captured: string | undefined;
    const env = {
      RATE_LIMITER: {
        limit: async (k: { key: string }) => {
          captured = k.key;
          return { success: false };
        },
      },
    } as Parameters<typeof checkRateLimit>[0];
    const r = await checkRateLimit(env, "ip:1.2.3.4", 60);
    expect(r.ok).toBe(false);
    expect(captured).toBe("ip:1.2.3.4");
  });
});

describe("base64 round-trip", () => {
  it("round-trips arbitrary bytes", () => {
    const input = new Uint8Array([0, 1, 2, 254, 255, 127, 128]);
    const e = base64Encode(input);
    const d = base64Decode(e);
    expect(d).toEqual(input);
  });
});
