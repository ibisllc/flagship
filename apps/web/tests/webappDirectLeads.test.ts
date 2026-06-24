/**
 * Direct lead-read (Phase 6 follow-on) — webapp unit tests.
 *
 * Tests three seams:
 *   1. fetchLeads — parses the box's /api/leads response, returns null on
 *      failure / gossipActive:false / non-OK HTTP.
 *   2. invertLeadsMap — correct global→per-pod inversion.
 *   3. applyDirectLeads + leadsOf display prefer-then-fallback: the pod
 *      card prefers the direct map when present, and falls back to the
 *      relay's leadsServices when the direct read fails (empty invertedMap).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLeads, invertLeadsMap } from "../public/webapp/lib/directLeads.js";
import { leadsOf, applyDirectLeads } from "../public/webapp/views/home.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. fetchLeads ──────────────────────────────────────────────────────

describe("fetchLeads — parses valid /api/leads response", () => {
  it("returns the leads map when gossipActive is true", async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, {
        asOf: 1000,
        self: "home.alice.flagship.services",
        gossipActive: true,
        leads: {
          blog: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
          notes: { leaderFqdn: "work.alice.flagship.services", leaderStkHex: "bb", live: false },
        },
      }),
    );

    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });

    expect(fakeFetch).toHaveBeenCalledWith("https://home.alice.flagship.services/api/leads");
    expect(result).not.toBeNull();
    expect(result!["blog"]!.leaderFqdn).toBe("home.alice.flagship.services");
    expect(result!["notes"]!.leaderFqdn).toBe("work.alice.flagship.services");
  });

  it("returns null when the server returns 404", async () => {
    const fakeFetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("NetworkError"); });
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null when gossipActive is false", async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, {
        asOf: 1000,
        self: "home.alice.flagship.services",
        gossipActive: false,
        leads: { blog: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true } },
      }),
    );
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null when gossipActive is missing", async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, {
        asOf: 1000,
        self: "home.alice.flagship.services",
        leads: {},
      }),
    );
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null when podFqdn is empty/null", async () => {
    const fakeFetch = vi.fn();
    expect(await fetchLeads("", { fetch: fakeFetch })).toBeNull();
    expect(await fetchLeads(null as unknown as string, { fetch: fakeFetch })).toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("returns null when leads field is missing from the response", async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, { asOf: 1000, self: "home.alice.flagship.services", gossipActive: true }),
    );
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null on a 500 error", async () => {
    const fakeFetch = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
    const result = await fetchLeads("home.alice.flagship.services", { fetch: fakeFetch });
    expect(result).toBeNull();
  });
});

// ── 2. invertLeadsMap ─────────────────────────────────────────────────

describe("invertLeadsMap — global→per-pod inversion", () => {
  it("inverts a single-slug single-pod map", () => {
    const inverted = invertLeadsMap({
      blog: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
    });
    expect(inverted.get("home.alice.flagship.services")).toEqual(["blog"]);
    expect(inverted.size).toBe(1);
  });

  it("inverts a multi-slug multi-pod map correctly", () => {
    const inverted = invertLeadsMap({
      blog: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
      notes: { leaderFqdn: "work.alice.flagship.services", leaderStkHex: "bb", live: false },
      wiki: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
    });
    // "home" leads blog + wiki (sorted alphabetically)
    expect(inverted.get("home.alice.flagship.services")).toEqual(["blog", "wiki"]);
    // "work" leads notes
    expect(inverted.get("work.alice.flagship.services")).toEqual(["notes"]);
    expect(inverted.size).toBe(2);
  });

  it("sorts slug lists deterministically", () => {
    const inverted = invertLeadsMap({
      zzz: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
      aaa: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
      mmm: { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
    });
    expect(inverted.get("home.alice.flagship.services")).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("lowercases FQDNs", () => {
    const inverted = invertLeadsMap({
      blog: { leaderFqdn: "Home.Alice.Flagship.Services", leaderStkHex: "aa", live: true },
    });
    expect(inverted.has("home.alice.flagship.services")).toBe(true);
    expect(inverted.has("Home.Alice.Flagship.Services")).toBe(false);
  });

  it("skips entries with missing or empty leaderFqdn", () => {
    const inverted = invertLeadsMap({
      blog: { leaderFqdn: "", leaderStkHex: "aa", live: true },
      notes: { leaderFqdn: null as unknown as string, leaderStkHex: "bb", live: false },
    });
    expect(inverted.size).toBe(0);
  });

  it("skips empty slug keys", () => {
    const inverted = invertLeadsMap({
      "": { leaderFqdn: "home.alice.flagship.services", leaderStkHex: "aa", live: true },
    });
    expect(inverted.size).toBe(0);
  });

  it("returns an empty map for null or non-object input", () => {
    expect(invertLeadsMap(null as unknown as Record<string, never>).size).toBe(0);
    expect(invertLeadsMap(undefined as unknown as Record<string, never>).size).toBe(0);
  });
});

// ── 3. applyDirectLeads + leadsOf — prefer-then-fallback ──────────────

describe("applyDirectLeads — prefer direct over relay, fall back on empty map", () => {
  const HOME = "home.alice.flagship.services";
  const WORK = "work.alice.flagship.services";

  function makeStatusByDomain(
    entries: Array<{ fqdn: string; leadsServices?: string[] }>,
  ): Map<string, object> {
    const m = new Map<string, object>();
    for (const e of entries) {
      m.set(e.fqdn, { serverDomain: e.fqdn, leadsServices: e.leadsServices ?? [] });
    }
    return m;
  }

  it("overlays leadsServices from the direct map when present", () => {
    const podStatusByDomain = makeStatusByDomain([
      { fqdn: HOME, leadsServices: ["old-blog"] },
      { fqdn: WORK, leadsServices: [] },
    ]);
    const invertedMap = new Map<string, string[]>([
      [HOME, ["blog", "wiki"]],
    ]);

    const result = applyDirectLeads(podStatusByDomain, invertedMap);

    // HOME pod — direct read preferred
    expect(leadsOf(result.get(HOME))).toEqual(["blog", "wiki"]);
    // WORK pod — not in inverted map, relay data (empty array) kept
    expect(leadsOf(result.get(WORK))).toEqual([]);
  });

  it("falls back to relay leadsServices when invertedMap is empty", () => {
    const podStatusByDomain = makeStatusByDomain([
      { fqdn: HOME, leadsServices: ["relay-blog"] },
    ]);
    const emptyInvertedMap = new Map<string, string[]>();

    const result = applyDirectLeads(podStatusByDomain, emptyInvertedMap);

    // Empty inverted map → returns the original map unchanged
    expect(result).toBe(podStatusByDomain);
    expect(leadsOf(result.get(HOME))).toEqual(["relay-blog"]);
  });

  it("does not mutate the original podStatusByDomain", () => {
    const podStatusByDomain = makeStatusByDomain([
      { fqdn: HOME, leadsServices: ["old-blog"] },
    ]);
    const original = podStatusByDomain.get(HOME);
    const invertedMap = new Map<string, string[]>([[HOME, ["new-blog"]]]);

    applyDirectLeads(podStatusByDomain, invertedMap);

    // Original pod entry is unchanged
    expect((original as { leadsServices: string[] }).leadsServices).toEqual(["old-blog"]);
  });

  it("handles a pod in invertedMap with no leads (empty slug list)", () => {
    const podStatusByDomain = makeStatusByDomain([
      { fqdn: HOME, leadsServices: ["relay-blog"] },
    ]);
    const invertedMap = new Map<string, string[]>([[HOME, []]]);

    const result = applyDirectLeads(podStatusByDomain, invertedMap);

    // Direct read says no leads for this pod
    expect(leadsOf(result.get(HOME))).toEqual([]);
  });

  it("passes through pods not in the inverted map with their relay data", () => {
    const podStatusByDomain = makeStatusByDomain([
      { fqdn: HOME, leadsServices: ["relay-blog"] },
      { fqdn: WORK, leadsServices: ["relay-notes"] },
    ]);
    // Only HOME has direct data
    const invertedMap = new Map<string, string[]>([[HOME, ["direct-blog"]]]);

    const result = applyDirectLeads(podStatusByDomain, invertedMap);

    expect(leadsOf(result.get(HOME))).toEqual(["direct-blog"]);
    expect(leadsOf(result.get(WORK))).toEqual(["relay-notes"]);
  });
});
