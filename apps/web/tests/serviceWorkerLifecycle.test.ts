import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// Behaviour tests for the webapp service worker's install / activate /
// message / waiting-state flow. The corresponding static-asset
// assertions (file is reachable, contains the right strings) live in
// webappStatic.test.ts; this file actually evaluates the SW source in
// a sandbox and drives its event handlers to verify rollback-safety.
//
// We can't load the SW into a real browser from Node, so we mount a
// tiny WorkerGlobalScope-shaped sandbox: `self`, `caches`, `fetch`,
// `Response`, `URL`, and a `clients` stub. The interesting properties
// we care about (per-URL precache failure semantics, no auto-claim,
// SKIP_WAITING message handler) all live above that shim.

const SW_PATH = join(__dirname, "../public/webapp/service-worker.js");

interface CacheStub {
  put: ReturnType<typeof makePut>;
  putCalls: { url: string; status: number }[];
}

function makePut(record: { url: string; status: number }[]) {
  return async (key: any, res: any) => {
    const url = typeof key === "string" ? key : key?.url ?? String(key);
    record.push({ url, status: res?.status ?? 0 });
  };
}

interface SwHarness {
  ctx: vm.Context;
  self: any;
  cache: CacheStub;
  fetchLog: string[];
  caches: any;
}

function buildSandbox(opts: {
  // Return a 200 response for the path, a 404 to simulate a missing
  // asset, or "throw" to simulate a network failure.
  fetchPolicy: (path: string) => "ok" | "404" | "throw";
}): SwHarness {
  const putRecord: { url: string; status: number }[] = [];
  const cache: CacheStub = {
    put: makePut(putRecord),
    putCalls: putRecord,
  };
  // caches.open returns the shared cache stub; caches.keys and delete
  // exercise the activate handler.
  const cacheRegistry = new Map<string, CacheStub>();
  const caches = {
    open: async (name: string) => {
      let c = cacheRegistry.get(name);
      if (!c) {
        c = cache;
        cacheRegistry.set(name, c);
      }
      return c;
    },
    keys: async () => Array.from(cacheRegistry.keys()),
    delete: async (name: string) => cacheRegistry.delete(name),
    match: async () => undefined,
  };

  const listeners = new Map<string, Function[]>();
  const fetchLog: string[] = [];

  const self: any = {
    location: { origin: "https://web.flagshipserver.com" },
    addEventListener: (type: string, cb: Function) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(cb);
    },
    skipWaiting: () => {
      self._skipWaitingCalled = true;
    },
    clients: {
      claim: () => {
        self._claimCalled = true;
      },
      matchAll: async () => [],
      openWindow: async () => null,
    },
    registration: {
      showNotification: async () => undefined,
    },
    _skipWaitingCalled: false,
    _claimCalled: false,
    _listeners: listeners,
  };

  const sandbox: any = {
    self,
    caches,
    fetch: async (req: any) => {
      const path = typeof req === "string" ? req : req?.url ?? String(req);
      fetchLog.push(path);
      const policy = opts.fetchPolicy(path);
      if (policy === "throw") throw new Error(`network down for ${path}`);
      if (policy === "404") {
        return { ok: false, status: 404, url: path };
      }
      return { ok: true, status: 200, url: path, clone: () => ({ ok: true, status: 200, url: path }) };
    },
    URL,
    Response: class FakeResponse {
      body: any;
      status: number;
      headers: any;
      constructor(body: any, init?: any) {
        this.body = body;
        this.status = init?.status ?? 200;
        this.headers = init?.headers ?? {};
      }
    },
    Headers: class FakeHeaders {},
    console: { warn: () => {}, log: () => {}, error: () => {} },
    Date,
    Promise,
    Error,
    Array,
    Object,
    JSON,
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  const src = readFileSync(SW_PATH, "utf8");
  vm.runInContext(src, sandbox, { filename: "service-worker.js" });

  return { ctx: sandbox, self, cache, fetchLog, caches };
}

function fireEvent(self: any, type: string, event: any): Promise<void> {
  const cbs = self._listeners.get(type) ?? [];
  let waitPromise: Promise<unknown> = Promise.resolve();
  const wrapped = {
    ...event,
    waitUntil: (p: Promise<unknown>) => {
      waitPromise = p;
    },
  };
  for (const cb of cbs) cb(wrapped);
  return waitPromise.then(() => undefined);
}

describe("service-worker.js — install / activate / waiting-state safety", () => {
  it("install REJECTS when an ESSENTIAL_PATHS URL 404s", async () => {
    const h = buildSandbox({
      fetchPolicy: (p) => (p === "/app.js" ? "404" : "ok"),
    });
    // The install handler returns a waitUntil promise that should
    // reject. The browser observing a rejected install keeps the
    // previous SW active — that's exactly the rollback behaviour we
    // want.
    await expect(fireEvent(h.self, "install", {})).rejects.toThrow(/essential precache failed.*\/app\.js/);
  });

  it("install SUCCEEDS when only an OPTIONAL_SHELL URL 404s", async () => {
    const h = buildSandbox({
      fetchPolicy: (p) => (p === "/views/browser-viewer.js" ? "404" : "ok"),
    });
    await expect(fireEvent(h.self, "install", {})).resolves.toBeUndefined();
    // Every essential path must have been put into the cache; the
    // missing optional path must NOT be in the cache.
    const cachedUrls = h.cache.putCalls.map((c) => c.url);
    expect(cachedUrls).toContain("/app.js");
    expect(cachedUrls).toContain("/index.html");
    expect(cachedUrls).toContain("/style.css");
    expect(cachedUrls).toContain("/manifest.json");
    expect(cachedUrls).toContain("/icon.svg");
    expect(cachedUrls).not.toContain("/views/browser-viewer.js");
  });

  it("install SUCCEEDS when ALL paths are 200 — full precache populated", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await expect(fireEvent(h.self, "install", {})).resolves.toBeUndefined();
    const cachedUrls = new Set(h.cache.putCalls.map((c) => c.url));
    // Sanity: a handful of both essential and optional entries cached.
    expect(cachedUrls.has("/keystore.js")).toBe(true);
    expect(cachedUrls.has("/views/home.js")).toBe(true);
    expect(cachedUrls.has("/lib/leases.js")).toBe(true);
  });

  it("install does NOT call skipWaiting() — the new SW stays in 'waiting'", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await fireEvent(h.self, "install", {});
    expect(h.self._skipWaitingCalled).toBe(false);
  });

  it("activate does NOT call clients.claim() — existing tabs keep the old SW", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await fireEvent(h.self, "install", {});
    await fireEvent(h.self, "activate", {});
    expect(h.self._claimCalled).toBe(false);
  });

  it("activate deletes stale shell caches but keeps the current one", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    // Seed: pretend old caches from previous SW versions exist.
    await h.caches.open("flagship-webapp-shell-v15");
    await h.caches.open("flagship-webapp-shell-v16");
    await fireEvent(h.self, "install", {}); // creates the current (-v19)
    await fireEvent(h.self, "activate", {});
    const remaining = await h.caches.keys();
    expect(remaining).toContain("flagship-webapp-shell-v19");
    expect(remaining).not.toContain("flagship-webapp-shell-v15");
    expect(remaining).not.toContain("flagship-webapp-shell-v16");
  });

  it("postMessage SKIP_WAITING triggers self.skipWaiting()", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await fireEvent(h.self, "install", {});
    expect(h.self._skipWaitingCalled).toBe(false);
    // Page-side opt-in: { type: "SKIP_WAITING" }
    await fireEvent(h.self, "message", { data: { type: "SKIP_WAITING" } });
    expect(h.self._skipWaitingCalled).toBe(true);
  });

  it("postMessage SKIP_WAITING accepts the bare-string form too", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await fireEvent(h.self, "message", { data: "SKIP_WAITING" });
    expect(h.self._skipWaitingCalled).toBe(true);
  });

  it("postMessage with no data is a no-op (doesn't crash, doesn't skip)", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    await fireEvent(h.self, "message", { data: null });
    expect(h.self._skipWaitingCalled).toBe(false);
  });

  it("postMessage for the e2e simulate-push shim still works (not regressed)", async () => {
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    let shown = false;
    h.self.registration.showNotification = async () => {
      shown = true;
    };
    await fireEvent(h.self, "message", {
      data: {
        type: "flagship-e2e:simulate-push",
        payload: { serverFqdn: "test.x.flagship.services" },
      },
    });
    expect(shown).toBe(true);
    // And it must NOT have called skipWaiting as a side-effect.
    expect(h.self._skipWaitingCalled).toBe(false);
  });

  it("a controlling SW remains controlling after a new SW installs (waiting state)", async () => {
    // Conceptual test: install a v12 SW into a sandbox that already
    // has a v11 active. Because v12 doesn't call skipWaiting on
    // install, the v11 SW would in a real browser remain the
    // controller until either (a) all tabs close or (b) the page
    // posts SKIP_WAITING. We can't simulate the browser's state
    // machine, but we CAN verify the contract: install completed,
    // skipWaiting was NOT called. The browser does the rest.
    const h = buildSandbox({ fetchPolicy: () => "ok" });
    h.self._activeSwVersion = "v11"; // narrative only
    await fireEvent(h.self, "install", {});
    expect(h.self._skipWaitingCalled).toBe(false);
    expect(h.self._claimCalled).toBe(false);
    // After the user opts in via the page toast, the SW activates.
    await fireEvent(h.self, "message", { data: { type: "SKIP_WAITING" } });
    expect(h.self._skipWaitingCalled).toBe(true);
  });

  it("essential-paths set is a strict subset of SHELL (no drift between the two)", async () => {
    // Lift the constants out of the sandbox so we can compare.
    const src = readFileSync(SW_PATH, "utf8");
    const sandbox: any = {
      self: { addEventListener: () => {}, location: { origin: "x" }, clients: {}, registration: {} },
      caches: { open: async () => ({ put: async () => {} }), keys: async () => [], delete: async () => {} },
      fetch: async () => ({ ok: true }),
      URL,
      Response: function (this: any) {},
      Headers: function (this: any) {},
      console: { warn: () => {}, log: () => {} },
      Date,
      Promise,
      Error,
      Array,
      Object,
      JSON,
      setTimeout,
      clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "service-worker.js" });
    const essential = vm.runInContext("ESSENTIAL_PATHS", sandbox) as string[];
    const optional = vm.runInContext("OPTIONAL_SHELL", sandbox) as string[];
    const shell = vm.runInContext("SHELL", sandbox) as string[];
    // No overlap between essential and optional (defends against
    // accidentally duplicating an entry and breaking install logic).
    const eSet = new Set(essential);
    for (const p of optional) expect(eSet.has(p)).toBe(false);
    // SHELL is exactly essential + optional.
    expect(shell).toEqual([...essential, ...optional]);
    // Spot-check: each essential entry is something the unlock view
    // genuinely needs.
    expect(essential).toContain("/index.html");
    expect(essential).toContain("/app.js");
    expect(essential).toContain("/style.css");
    expect(essential).toContain("/manifest.json");
    expect(essential).toContain("/icon.svg");
  });
});
