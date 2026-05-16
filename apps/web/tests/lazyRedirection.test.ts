// Lazy SNI-miss → ask-.com resolver (#12). Push + cold-start are the
// correctness core; these pin the optimization's guards: first-party
// skip, fail-closed, hit installs, negative-cache, in-flight dedupe,
// the rate-limit DoS guard, and never-throws.

import { describe, expect, it } from "vitest";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { LazyRedirectionResolver } from "../src/tunnel/lazyRedirection.js";

function fetchStub(
  handler: (url: string) => { ok: boolean; status?: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 404),
      json: async () => r.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("LazyRedirectionResolver (#12)", () => {
  it("disabled (null, no fetch) when no secret is configured", async () => {
    const { fetchImpl, calls } = fetchStub(() => ({ ok: true }));
    const r = new LazyRedirectionResolver({
      registry: new TunnelRegistry(), comBaseUrl: "https://com", fetchImpl,
    });
    expect(await r.resolve("shop.example.com")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never asks .com about first-party *.flagship.services", async () => {
    const { fetchImpl, calls } = fetchStub(() => ({ ok: true }));
    const r = new LazyRedirectionResolver({
      registry: new TunnelRegistry(), comBaseUrl: "https://com", secret: "S", fetchImpl,
    });
    expect(await r.resolve("home.alice.flagship.services")).toBeNull();
    expect(await r.resolve("flagship.services")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a hit installs the redirection and returns the pod", async () => {
    const registry = new TunnelRegistry();
    const { fetchImpl, calls } = fetchStub((url) => {
      expect(url).toContain("/api/internal/redirection-lookup?fqdn=shop.example.com");
      return { ok: true, body: { found: true, fqdn: "shop.example.com", podCanonical: "Home.Alice.Flagship.Services" } };
    });
    const r = new LazyRedirectionResolver({ registry, comBaseUrl: "https://com/", secret: "S", fetchImpl });
    expect(await r.resolve("shop.example.com")).toBe("home.alice.flagship.services");
    expect(registry.redirectionCount()).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("negative-caches a miss (one .com call until the TTL elapses)", async () => {
    let t = 1_000_000;
    const { fetchImpl, calls } = fetchStub(() => ({ ok: false, status: 404 }));
    const r = new LazyRedirectionResolver({
      registry: new TunnelRegistry(), comBaseUrl: "https://com", secret: "S",
      fetchImpl, negativeTtlMs: 60_000, now: () => t,
    });
    expect(await r.resolve("nope.example.com")).toBeNull();
    expect(await r.resolve("nope.example.com")).toBeNull();
    expect(calls).toHaveLength(1); // second served from the negative cache
    t += 60_001;
    expect(await r.resolve("nope.example.com")).toBeNull();
    expect(calls).toHaveLength(2); // TTL elapsed → re-asked
  });

  it("dedupes concurrent lookups for the same fqdn", async () => {
    const registry = new TunnelRegistry();
    let resolveFetch: (v: { ok: boolean; body?: unknown }) => void = () => {};
    const fetchImpl = (async () => {
      const r = await new Promise<{ ok: boolean; body?: unknown }>((res) => { resolveFetch = res; });
      return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body ?? {} } as Response;
    }) as unknown as typeof fetch;
    let fetchCount = 0;
    const counting = (async (...a: Parameters<typeof fetch>) => { fetchCount++; return fetchImpl(...a); }) as unknown as typeof fetch;
    const r = new LazyRedirectionResolver({ registry, comBaseUrl: "https://com", secret: "S", fetchImpl: counting });
    const p1 = r.resolve("dup.example.com");
    const p2 = r.resolve("dup.example.com");
    resolveFetch({ ok: true, body: { found: true, fqdn: "dup.example.com", podCanonical: "p.flagship.services" } });
    expect(await p1).toBe("p.flagship.services");
    expect(await p2).toBe("p.flagship.services");
    expect(fetchCount).toBe(1);
  });

  it("rate-limits lookups per rolling window (DoS guard), then resets", async () => {
    let t = 0;
    const { fetchImpl, calls } = fetchStub(() => ({ ok: false, status: 404 }));
    const r = new LazyRedirectionResolver({
      registry: new TunnelRegistry(), comBaseUrl: "https://com", secret: "S",
      fetchImpl, maxPerWindow: 2, windowMs: 10_000, negativeTtlMs: 0, now: () => t,
    });
    await r.resolve("a.example.com");
    await r.resolve("b.example.com");
    await r.resolve("c.example.com"); // over the ceiling → no fetch
    expect(calls).toHaveLength(2);
    t += 10_001; // window rolls
    await r.resolve("d.example.com");
    expect(calls).toHaveLength(3);
  });

  it("never throws on a fetch error; negative-caches it", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const calls: string[] = [];
    const counting = (async (...a: Parameters<typeof fetch>) => { calls.push(String(a[0])); return throwing(...a); }) as unknown as typeof fetch;
    const r = new LazyRedirectionResolver({
      registry: new TunnelRegistry(), comBaseUrl: "https://com", secret: "S", fetchImpl: counting,
    });
    expect(await r.resolve("err.example.com")).toBeNull();
    expect(await r.resolve("err.example.com")).toBeNull(); // negative-cached
    expect(calls).toHaveLength(1);
  });
});
