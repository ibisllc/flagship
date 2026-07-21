/**
 * P14 Phase 2 — companionRequestsClient.js: owner-side BFF wrappers.
 *
 * Coverage:
 *   - listPendingWrites hits /api/screens/companion/pending-writes and
 *     returns a defensive { pending: [] } shape on any response.
 *   - resolvePending posts the documented body keys + outcome vocabulary.
 *   - resolvePending is idempotent-friendly (it returns the daemon's
 *     ok-on-retry body unchanged).
 *   - pollPending invokes onUpdate with snapshots; the returned stop()
 *     handle short-circuits future ticks.
 */

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadClient() {
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(
    __dirname, "..", "public", "webapp", "lib", "companionRequestsClient.js",
  );
  return await import(pathToFileURL(path).href + bust);
}

describe("companionRequestsClient — listPendingWrites", () => {
  it("calls /api/screens/companion/pending-writes and returns body.pending", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async (path: string) => {
      expect(path).toBe("/api/screens/companion/pending-writes");
      return {
        pending: [
          {
            requestId: "req-1",
            companionTokenPrefix: "abc",
            kind: "release-server",
            intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
            queuedAt: 1,
            expiresAt: 2,
          },
        ],
      };
    });
    const out = await mod.listPendingWrites({ screensFetch });
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0].requestId).toBe("req-1");
  });

  it("falls back to {pending: []} when the daemon returns a malformed body", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async () => ({ /* no pending key */ }));
    const out = await mod.listPendingWrites({ screensFetch });
    expect(out.pending).toEqual([]);
  });
});

describe("companionRequestsClient — resolvePending", () => {
  it("POSTs { requestId, outcome } with outcome='approved'", async () => {
    const mod = await loadClient();
    let captured: { path: string; init: { method: string; body: string } } | null = null;
    const screensFetch = vi.fn(async (path: string, init: { method: string; body: string }) => {
      captured = { path, init };
      return { ok: true };
    });
    const out = await mod.resolvePending(
      { requestId: "req-1", outcome: "approved" },
      { screensFetch },
    );
    expect(out).toEqual({ ok: true });
    expect(captured!.path).toBe("/api/screens/companion/resolve-pending");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body)).toEqual({ requestId: "req-1", outcome: "approved" });
  });

  it("accepts outcome='denied' too", async () => {
    const mod = await loadClient();
    let body: unknown = null;
    const screensFetch = vi.fn(async (_path: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true };
    });
    await mod.resolvePending(
      { requestId: "req-2", outcome: "denied" },
      { screensFetch },
    );
    expect(body).toEqual({ requestId: "req-2", outcome: "denied" });
  });

  it("rejects an unknown outcome before issuing the call", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async () => ({ ok: true }));
    await expect(
      mod.resolvePending({ requestId: "x", outcome: "maybe" }, { screensFetch }),
    ).rejects.toThrow(/outcome must be one of/);
    expect(screensFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty requestId before issuing the call", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async () => ({ ok: true }));
    await expect(
      mod.resolvePending({ requestId: "", outcome: "approved" }, { screensFetch }),
    ).rejects.toThrow(/requestId required/);
    expect(screensFetch).not.toHaveBeenCalled();
  });

  it("returns the daemon's idempotent body verbatim on retry", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async () => ({ ok: true, alreadyResolved: true }));
    const out = await mod.resolvePending(
      { requestId: "req-3", outcome: "approved" },
      { screensFetch },
    );
    expect(out).toEqual({ ok: true, alreadyResolved: true });
  });
});

describe("companionRequestsClient — pollPending", () => {
  it("invokes onUpdate at least once with the current snapshot", async () => {
    const mod = await loadClient();
    const screensFetch = vi.fn(async () => ({
      pending: [{ requestId: "req-a", kind: "release-server" }],
    }));
    const updates: unknown[] = [];
    await new Promise<void>((resolveP) => {
      const stop = mod.pollPending(
        (snap: unknown) => {
          updates.push(snap);
          stop();
          resolveP();
        },
        { screensFetch, intervalMs: 1 },
      );
    });
    expect(updates).toHaveLength(1);
    expect((updates[0] as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("stop() short-circuits subsequent ticks", async () => {
    const mod = await loadClient();
    let count = 0;
    const screensFetch = vi.fn(async () => {
      count += 1;
      return { pending: [] };
    });
    const stop = mod.pollPending(
      () => { /* swallow */ },
      { screensFetch, intervalMs: 5 },
    );
    // First tick is synchronous via microtask; let it land.
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const snapshot = count;
    await new Promise((r) => setTimeout(r, 40));
    // No more ticks after stop().
    expect(count).toBe(snapshot);
  });
});

describe("companionRequestsClient — static surface", () => {
  it("exports RESOLVE_OUTCOMES vocabulary as a frozen list", async () => {
    const mod = await loadClient();
    expect(mod.RESOLVE_OUTCOMES).toEqual(["approved", "denied"]);
    expect(Object.isFrozen(mod.RESOLVE_OUTCOMES)).toBe(true);
  });
});
