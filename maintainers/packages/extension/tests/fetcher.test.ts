import { describe, expect, it } from "vitest";
import { fetchMaintainers, type FetcherDeps } from "../src/fetcher.js";
import type { RepoLocation } from "../src/repo-detect.js";
import { buildFixture, makeFakeFetch, makeMemKv } from "./fixtures/build-fixture.js";

function makeRepoLocation(rawBase: string): RepoLocation {
  return {
    provider: "github",
    host: "github.test",
    owner: "owner",
    repo: "repo",
    branches: ["main", "master"],
    repoUrl: "https://github.test/owner/repo",
    rawUrl(path: string, _branch: string) {
      return rawBase + path.replace(/^\/+/, "");
    },
  };
}

describe("fetchMaintainers", () => {
  it("returns parsed policy, track policies, mandates, keys, and endorsements", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const fx = buildFixture({ takeover: false, recentEmailRotation: false, now });
    const kv = makeMemKv();
    let calls = 0;
    const fetchImpl = makeFakeFetch(fx.files);
    const deps: FetcherDeps = {
      fetch: ((...a: any[]) => {
        calls++;
        return (fetchImpl as any)(...a);
      }) as typeof fetch,
      storage: kv,
      now: () => now.getTime(),
    };

    const repo = makeRepoLocation("https://raw.example.test/owner/repo/main/");
    const data = await fetchMaintainers(repo, deps);
    expect(data.policy?.project.name).toBe("fixture-project");
    expect(data.branch).toBe("main");
    expect(data.trackPolicies.release).toBeDefined();
    expect(data.mandates.release).toHaveLength(2);
    expect(data.keys.map((k) => k.displayName).sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect(data.endorsements).toHaveLength(1);
    expect(calls).toBeGreaterThan(0);
  });

  it("caches results for 30 seconds", async () => {
    const start = new Date("2026-05-15T12:00:00Z").getTime();
    const fx = buildFixture({ takeover: false, recentEmailRotation: false, now: new Date(start) });
    const kv = makeMemKv();
    let calls = 0;
    const fetchImpl = makeFakeFetch(fx.files);
    let nowMs = start;
    const deps: FetcherDeps = {
      fetch: ((...a: any[]) => {
        calls++;
        return (fetchImpl as any)(...a);
      }) as typeof fetch,
      storage: kv,
      now: () => nowMs,
    };
    const repo = makeRepoLocation("https://raw.example.test/owner/repo/main/");
    await fetchMaintainers(repo, deps);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Within 30s: cache hit, no extra fetches
    nowMs = start + 20_000;
    await fetchMaintainers(repo, deps);
    expect(calls).toBe(callsAfterFirst);

    // After 30s: cache miss, fresh fetches
    nowMs = start + 31_000;
    await fetchMaintainers(repo, deps);
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });

  it("returns a degraded result when policy.json is missing on every branch", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const kv = makeMemKv();
    const deps: FetcherDeps = {
      fetch: makeFakeFetch(new Map()), // all 404
      storage: kv,
      now: () => now.getTime(),
    };
    const repo = makeRepoLocation("https://raw.example.test/owner/repo/main/");
    const data = await fetchMaintainers(repo, deps);
    expect(data.policy).toBeNull();
    expect(data.branch).toBeNull();
    expect(data.errors[0]?.path).toBe(".maintainers/policy.json");
  });

  it("rejects unsafe paths in index.json", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const files = new Map<string, string>();
    const BASE = "https://raw.example.test/owner/repo/main/";
    const policy = { schemaVersion: 1, project: { name: "p" }, tracks: [] };
    files.set(BASE + ".maintainers/policy.json", JSON.stringify(policy));
    files.set(
      BASE + ".maintainers/index.json",
      JSON.stringify({
        version: 1,
        tracks: { release: ["../etc/passwd"] },
        keys: ["/absolute/secret"],
        endorsements: [".maintainers/foo/../../bar"],
      }),
    );
    const kv = makeMemKv();
    const deps: FetcherDeps = {
      fetch: makeFakeFetch(files),
      storage: kv,
      now: () => now.getTime(),
    };
    const repo = makeRepoLocation(BASE);
    const data = await fetchMaintainers(repo, deps);
    expect(data.policy?.project.name).toBe("p");
    // Three unsafe paths were rejected
    expect(data.errors.filter((e) => e.error.startsWith("rejected"))).toHaveLength(3);
  });

  it("falls back through branches in order", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const fx = buildFixture({ takeover: false, recentEmailRotation: false, now });
    const kv = makeMemKv();
    const files = new Map(fx.files);
    // Place the policy under "master" instead of "main"
    const BASE = "https://raw.example.test/owner/repo/";
    for (const [k, v] of fx.files) {
      const remapped = k.replace(BASE + "main/", BASE + "master/");
      files.set(remapped, v);
      files.delete(k);
    }
    const deps: FetcherDeps = {
      fetch: makeFakeFetch(files),
      storage: kv,
      now: () => now.getTime(),
    };
    const repo: RepoLocation = {
      provider: "github",
      host: "github.test",
      owner: "owner",
      repo: "repo",
      branches: ["main", "master"],
      repoUrl: "https://github.test/owner/repo",
      rawUrl(path: string, branch: string) {
        return BASE + branch + "/" + path.replace(/^\/+/, "");
      },
    };
    const data = await fetchMaintainers(repo, deps);
    expect(data.branch).toBe("master");
    expect(data.policy?.project.name).toBe("fixture-project");
  });
});
