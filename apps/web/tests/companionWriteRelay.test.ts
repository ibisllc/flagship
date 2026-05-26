/**
 * P14 Phase 2 — companionWriteRelay.js: submit + poll wire shapes.
 *
 * Coverage:
 *   - submitWriteRequest sends { kind, intent } to /api/companion/request-write
 *     with the x-flagship-session header.
 *   - Both relayable kinds (release-server + revoke-server) round-trip.
 *   - pollUntilResolved resolves on approved / denied / expired and
 *     keeps polling on pending; respects TTL.
 *   - fetch-error mapping (HTTP 500, network-throw, malformed response).
 */

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class MemStorage implements Storage {
  private kv = new Map<string, string>();
  get length() { return this.kv.size; }
  clear(): void { this.kv.clear(); }
  getItem(k: string): string | null { return this.kv.get(k) ?? null; }
  setItem(k: string, v: string): void { this.kv.set(k, String(v)); }
  removeItem(k: string): void { this.kv.delete(k); }
  key(i: number): string | null { return [...this.kv.keys()][i] ?? null; }
}

async function loadFresh() {
  const ls = new MemStorage();
  (globalThis as { localStorage?: Storage }).localStorage = ls;
  // Seed pod base + session token so the relay's default deps work.
  ls.setItem("flagship.podBaseUrl", "https://home.alice.flagship.services");
  ls.setItem("flagship.sessionToken", "tok-abc");
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const relayPath = resolve(
    __dirname, "..", "public", "webapp", "lib", "companionWriteRelay.js",
  );
  const mod = await import(pathToFileURL(relayPath).href + bust);
  return { mod, ls };
}

describe("companionWriteRelay — submitWriteRequest", () => {
  it("POSTs { kind, intent } to /api/companion/request-write for release-server", async () => {
    const { mod } = await loadFresh();
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        requestId: "req-1", queuedAt: 1700000000000, expiresAt: 1700000600000,
      }), { status: 200 });
    });
    const out = await mod.submitWriteRequest(
      {
        kind: "release-server",
        intent: {
          username: "alice",
          serverDomain: "home.alice.flagship.services",
          issuedAt: 1700000000000,
        },
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(out).toEqual({
      requestId: "req-1",
      queuedAt: 1700000000000,
      expiresAt: 1700000600000,
    });
    expect(captured!.url).toBe(
      "https://home.alice.flagship.services/api/companion/request-write",
    );
    expect((captured!.init.headers as Record<string, string>)["x-flagship-session"]).toBe("tok-abc");
    expect((captured!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({
      kind: "release-server",
      intent: {
        username: "alice",
        serverDomain: "home.alice.flagship.services",
        issuedAt: 1700000000000,
      },
    });
  });

  it("POSTs the revoke-server intent shape verbatim", async () => {
    const { mod } = await loadFresh();
    let captured: unknown = null;
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        requestId: "req-2", queuedAt: 1, expiresAt: 2,
      }), { status: 200 });
    });
    await mod.submitWriteRequest(
      {
        kind: "revoke-server",
        intent: {
          userId: "alice",
          revokedServerId: "home.alice.flagship.services",
          reason: "decommissioned",
          issuedAt: 42,
        },
      },
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    expect(captured).toEqual({
      kind: "revoke-server",
      intent: {
        userId: "alice",
        revokedServerId: "home.alice.flagship.services",
        reason: "decommissioned",
        issuedAt: 42,
      },
    });
  });

  it("rejects non-relayable kinds before issuing a network call", async () => {
    const { mod } = await loadFresh();
    const fakeFetch = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      mod.submitWriteRequest(
        { kind: "wipe-and-restart", intent: { foo: 1 } },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "not-relayable" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("maps HTTP 500 to code=500 with the server error message", async () => {
    const { mod } = await loadFresh();
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(
      mod.submitWriteRequest(
        { kind: "release-server", intent: { username: "a", serverDomain: "b", issuedAt: 1 } },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "500" });
  });

  it("maps network throws to code=network", async () => {
    const { mod } = await loadFresh();
    const fakeFetch = vi.fn(async () => { throw new Error("offline"); });
    await expect(
      mod.submitWriteRequest(
        { kind: "release-server", intent: { username: "a", serverDomain: "b", issuedAt: 1 } },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("maps a malformed response to code=bad-response", async () => {
    const { mod } = await loadFresh();
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ noRequestId: true }), { status: 200 }));
    await expect(
      mod.submitWriteRequest(
        { kind: "release-server", intent: { username: "a", serverDomain: "b", issuedAt: 1 } },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it("refuses to submit without a paired pod base URL", async () => {
    const { mod, ls } = await loadFresh();
    ls.removeItem("flagship.podBaseUrl");
    const fakeFetch = vi.fn(async () => new Response("", { status: 200 }));
    await expect(
      mod.submitWriteRequest(
        { kind: "release-server", intent: { username: "a", serverDomain: "b", issuedAt: 1 } },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "no-pod" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("companionWriteRelay — pollUntilResolved", () => {
  it("resolves with 'approved' once the row transitions", async () => {
    const { mod } = await loadFresh();
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      const status = calls < 3 ? "pending" : "approved";
      return new Response(JSON.stringify({
        pending: [{ requestId: "req-1", kind: "release-server", status, queuedAt: 1, resolvedAt: status === "approved" ? 99 : undefined }],
      }), { status: 200 });
    });
    const out = await mod.pollUntilResolved("req-1", {
      fetch: fakeFetch as unknown as typeof fetch,
      intervalMs: 1,
      ttlMs: 60_000,
    });
    expect(out.status).toBe("approved");
    expect(out.resolvedAt).toBe(99);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("resolves with 'denied' on a denied row", async () => {
    const { mod } = await loadFresh();
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        pending: [{ requestId: "req-2", kind: "revoke-server", status: "denied", queuedAt: 1, resolvedAt: 100 }],
      }), { status: 200 }));
    const out = await mod.pollUntilResolved("req-2", {
      fetch: fakeFetch as unknown as typeof fetch,
      intervalMs: 1,
      ttlMs: 60_000,
    });
    expect(out.status).toBe("denied");
  });

  it("resolves with 'expired' when the TTL window elapses while still pending", async () => {
    const { mod } = await loadFresh();
    let nowRef = 1_000_000;
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        pending: [{ requestId: "req-3", kind: "release-server", status: "pending", queuedAt: 1 }],
      }), { status: 200 }));
    const out = await mod.pollUntilResolved("req-3", {
      fetch: fakeFetch as unknown as typeof fetch,
      intervalMs: 1,
      now: () => {
        const v = nowRef;
        nowRef += 500_000;
        return v;
      },
      ttlMs: 100_000,
    });
    expect(out.status).toBe("expired");
  });

  it("resolves with 'expired' if the row vanishes from the list (server GC)", async () => {
    const { mod } = await loadFresh();
    let nowRef = 1_000_000;
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ pending: [] }), { status: 200 }));
    const out = await mod.pollUntilResolved("req-missing", {
      fetch: fakeFetch as unknown as typeof fetch,
      intervalMs: 1,
      now: () => {
        const v = nowRef;
        nowRef += 500_000;
        return v;
      },
      ttlMs: 100_000,
    });
    expect(out.status).toBe("expired");
  });

  it("invokes onTick for each poll iteration", async () => {
    const { mod } = await loadFresh();
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      const status = calls < 2 ? "pending" : "approved";
      return new Response(JSON.stringify({
        pending: [{ requestId: "req-tick", kind: "release-server", status, queuedAt: 1 }],
      }), { status: 200 });
    });
    const ticks: string[] = [];
    const out = await mod.pollUntilResolved("req-tick", {
      fetch: fakeFetch as unknown as typeof fetch,
      intervalMs: 1,
      ttlMs: 60_000,
      onTick: (s: string) => ticks.push(s),
    });
    expect(out.status).toBe("approved");
    expect(ticks).toContain("pending");
    expect(ticks).toContain("approved");
  });
});
