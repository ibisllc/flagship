// V5 — AliasReconciler + AppPlatform.setAlias unit tests.
//
// The Reconciler is wired against a fake fetch that returns a
// scripted alias-list payload; the AppPlatform is a real instance
// holding a single installed app so we can verify the reverse-proxy
// index actually flips on setAlias.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppPlatform, type InstalledApp } from "../src/appPlatform.js";
import { AliasReconciler } from "../src/aliasReconciler.js";

function fakeApp(appId: string, slug: string, urlLabel: string): InstalledApp {
  return {
    creator: "alice",
    slug,
    appId,
    manifest: { name: slug } as never,
    urlLabel,
    membership: { append: async () => undefined, list: async () => [] } as never,
    containerPort: 8080,
    data: null,
    installedAt: 1,
  };
}

/** Construct an AppPlatform with one pre-installed app whose internal
 *  state we can mutate via setAlias. We bypass the install pipeline by
 *  reaching into the private maps; the test's interest is the
 *  setAlias rebinding logic, not the install flow. */
function makePlatformWithApp(appId: string, slug: string, urlLabel: string): AppPlatform {
  const platform = new AppPlatform({
    host: { username: "alice", irkPub: new Uint8Array() } as never,
  } as never);
  const app = fakeApp(appId, slug, urlLabel);
  // The class doesn't expose a public seed-an-app helper; use the
  // private maps directly. Casting through `as` keeps the test
  // self-contained.
  (platform as unknown as {
    apps: Map<string, InstalledApp>;
    byUrlLabel: Map<string, InstalledApp>;
  }).apps.set(appId, app);
  (platform as unknown as {
    byUrlLabel: Map<string, InstalledApp>;
  }).byUrlLabel.set(urlLabel.toLowerCase(), app);
  return platform;
}

describe("AppPlatform.setAlias", () => {
  it("rebinds byLabel index on a real rename", () => {
    const p = makePlatformWithApp("meta--scratchpad", "scratchpad", "scratchpad-meta");
    expect(p.byLabel("scratchpad-meta")?.appId).toBe("meta--scratchpad");
    const r = p.setAlias("meta--scratchpad", "mynotes");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unchanged).toBeUndefined();
      expect(r.oldLabel).toBe("scratchpad-meta");
      expect(r.newLabel).toBe("mynotes");
    }
    expect(p.byLabel("mynotes")?.appId).toBe("meta--scratchpad");
    expect(p.byLabel("scratchpad-meta")).toBeUndefined();
    expect(p.byAppId("meta--scratchpad")?.urlLabel).toBe("mynotes");
  });

  it("is idempotent — applying the same label twice is a no-op", () => {
    const p = makePlatformWithApp("a--app", "app", "current");
    const r1 = p.setAlias("a--app", "current");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.unchanged).toBe(true);
    const r2 = p.setAlias("a--app", "current");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.unchanged).toBe(true);
  });

  it("rejects malformed labels (DNS-safe regex enforced)", () => {
    const p = makePlatformWithApp("a--app", "app", "current");
    const r = p.setAlias("a--app", "Has Spaces!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid label/);
  });

  it("rejects unknown appId", () => {
    const p = makePlatformWithApp("a--app", "app", "current");
    const r = p.setAlias("does-not-exist", "fine");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown appId");
  });

  it("409s on collision with another installed app", () => {
    const p = makePlatformWithApp("a--app", "app", "appA");
    // Seed a second app at label "appB".
    (p as unknown as { apps: Map<string, InstalledApp>; byUrlLabel: Map<string, InstalledApp> })
      .apps.set("b--other", fakeApp("b--other", "other", "appB"));
    (p as unknown as { byUrlLabel: Map<string, InstalledApp> })
      .byUrlLabel.set("appb", fakeApp("b--other", "other", "appB"));
    const r = p.setAlias("a--app", "appB");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already used/);
  });
});

describe("AliasReconciler", () => {
  let fetchCalls: string[] = [];
  afterEach(() => { fetchCalls = []; });

  function makeFetch(rows: Array<{ appId: string; displayLabel: string; updatedAt: number }>): typeof fetch {
    return (async (url: string) => {
      fetchCalls.push(url);
      return new Response(JSON.stringify({ aliases: rows }), { status: 200 });
    }) as typeof fetch;
  }

  it("applies a fresh alias on the first reconcile pass", async () => {
    const platform = makePlatformWithApp("meta--scratchpad", "scratchpad", "scratchpad-meta");
    const applied: Array<{ appId: string; oldLabel?: string; newLabel: string }> = [];
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      platform,
      fetchImpl: makeFetch([{ appId: "meta--scratchpad", displayLabel: "mynotes", updatedAt: 100 }]),
      onApplied: (c) => applied.push(...c),
    });
    await reconciler.reconcileNow();
    expect(platform.byLabel("mynotes")?.appId).toBe("meta--scratchpad");
    expect(applied).toEqual([
      { appId: "meta--scratchpad", oldLabel: "scratchpad-meta", newLabel: "mynotes" },
    ]);
  });

  it("hits the right URL (encoded username + /apps/aliases)", async () => {
    const platform = makePlatformWithApp("a--b", "b", "b-a");
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "ali-ce",
      platform,
      fetchImpl: makeFetch([]),
    });
    await reconciler.reconcileNow();
    expect(fetchCalls).toEqual([
      "https://flagshipserver.com/api/users/ali-ce/apps/aliases",
    ]);
  });

  it("short-circuits when the high watermark hasn't moved", async () => {
    const platform = makePlatformWithApp("meta--scratchpad", "scratchpad", "scratchpad-meta");
    let callCount = 0;
    const applied: Array<{ appId: string; oldLabel?: string; newLabel: string }> = [];
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      platform,
      fetchImpl: (async () => {
        callCount += 1;
        return new Response(JSON.stringify({
          aliases: [{ appId: "meta--scratchpad", displayLabel: "mynotes", updatedAt: 100 }],
        }), { status: 200 });
      }) as typeof fetch,
      onApplied: (c) => applied.push(...c),
    });
    // First pass — applies.
    await reconciler.reconcileNow();
    expect(applied.length).toBe(1);
    // Second pass — same updatedAt; the apply loop short-circuits.
    await reconciler.reconcileNow();
    expect(applied.length).toBe(1); // unchanged
    expect(callCount).toBe(2);      // we still fetch though
  });

  it("tolerates unknown appIds without erroring (daemon may not have installed it yet)", async () => {
    const platform = makePlatformWithApp("a--app", "app", "appA");
    const errors: unknown[] = [];
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      platform,
      fetchImpl: makeFetch([
        // .com knows about an app the daemon hasn't installed yet —
        // not an error. The next reconcile after install picks it up.
        { appId: "c--newly-installed", displayLabel: "shiny", updatedAt: 100 },
        // ...and an app the daemon HAS installed; this one should apply.
        { appId: "a--app", displayLabel: "renamed", updatedAt: 100 },
      ]),
      onError: (e) => errors.push(e),
    });
    await reconciler.reconcileNow();
    expect(errors).toEqual([]);
    expect(platform.byLabel("renamed")?.appId).toBe("a--app");
  });

  it("forwards fetch failures to onError", async () => {
    const platform = makePlatformWithApp("a--app", "app", "appA");
    const errors: unknown[] = [];
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      platform,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
      onError: (e) => errors.push(e),
    });
    await reconciler.reconcileNow();
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toMatch(/alias fetch failed/);
  });

  it("start() / stop() schedule + tear down the timer cleanly", async () => {
    vi.useFakeTimers();
    const platform = makePlatformWithApp("a--app", "app", "appA");
    let fetches = 0;
    const reconciler = new AliasReconciler({
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      platform,
      intervalMs: 100,
      fetchImpl: (async () => {
        fetches += 1;
        return new Response(JSON.stringify({ aliases: [] }), { status: 200 });
      }) as typeof fetch,
    });
    reconciler.start();
    // Initial reconcile is kicked off immediately via void.
    await vi.runOnlyPendingTimersAsync();
    expect(fetches).toBeGreaterThanOrEqual(1);
    const before = fetches;
    await vi.advanceTimersByTimeAsync(350);
    expect(fetches).toBeGreaterThan(before);
    reconciler.stop();
    const afterStop = fetches;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches).toBe(afterStop); // no more polls after stop
    vi.useRealTimers();
  });
});
