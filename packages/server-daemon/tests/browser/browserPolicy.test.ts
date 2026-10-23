import { describe, expect, it } from "vitest";
import { BrowserGrants, BrowserJudge, ContextRegistry, GrantRequestError, PolicyError, describeGrant, guardedAction, normalizeOriginPattern, patternCovers, type BrowserGrantRequest } from "../../src/browser/policy/index.js";

const DNS: Record<string, string[]> = {
  "shop.example.com": ["93.184.216.34"],
  "example.com": ["93.184.216.34"],
  "cdn.other.net": ["151.101.1.1"],
  "tracker.evil.test": ["93.184.216.36"],
  "rebind.evil.test": ["93.184.216.35", "10.0.0.5"],
  "meta.evil.test": ["169.254.169.254"],
  "loop.evil.test": ["127.0.0.1"],
  "printer.local": ["192.168.1.20"],
  "nas.home": ["192.168.1.30"],
  "this-box.flagship.services": ["198.51.100.7"],
};

function world(grant: Partial<BrowserGrantRequest> | null = {}, opts: { sessionId?: string } = {}) {
  let t = 1_000;
  const grants = new BrowserGrants(() => t);
  if (grant !== null) grants.approve({ serviceId: "app-a", capabilities: ["navigate", "read-dom", "screenshot", "input"], origins: ["shop.example.com"], duration: "service", ...grant }, opts);
  const judge = new BrowserJudge({
    grants,
    resolve: async (h) => { const a = DNS[h]; if (!a) throw new Error("nxdomain"); return a; },
    protectedHosts: () => ({ names: ["this-box.flagship.services"], addresses: ["198.51.100.7"] }),
  });
  return { grants, judge, advance: (ms: number) => void (t += ms) };
}

const nav = (url: string, over: Record<string, unknown> = {}) => ({ serviceId: "app-a", url, kind: "document" as const, ...over });

describe("grant normalization and matching", () => {
  it("wildcards cover subdomains only, on label boundaries", () => {
    expect(patternCovers("*.example.com", "shop.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "a.b.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "example.com")).toBe(false);
    expect(patternCovers("*.example.com", "example.com.attacker.test")).toBe(false);
    expect(patternCovers("*.example.com", "badexample.com")).toBe(false);
    expect(patternCovers("example.com", "shop.example.com")).toBe(false);
  });

  it("refuses addresses, paths, ports, bare TLD wildcards and junk as sites", () => {
    for (const bad of ["*", "*.com", "1.2.3.4", "localhost", "https://x.com", "x.com/path", "x.com:8080", "a b.com", "user@x.com", "-x.com"]) {
      expect(() => normalizeOriginPattern(bad), bad).toThrow(GrantRequestError);
    }
    expect(normalizeOriginPattern(" Shop.EXAMPLE.com ")).toBe("shop.example.com");
  });

  it("tells the admin what a wildcard really covers", () => {
    const lines = describeGrant({ capabilities: ["navigate"], origins: ["*.example.com"], localNetwork: null, duration: "session" });
    expect(lines.join(" ")).toMatch(/any subdomain of example\.com .* but not example\.com itself/);
    expect(lines.join(" ")).toMatch(/never reach this server/);
  });
});

describe("what a service's browser may request", () => {
  it("no grant, no browser", async () => {
    const { judge } = world(null);
    expect(await judge.judge(nav("https://shop.example.com/"))).toMatchObject({ allow: false, code: "no-grant" });
  });

  it("a covered page is allowed and an uncovered direct navigation asks for more scope", async () => {
    const { judge } = world();
    expect(await judge.judge(nav("https://shop.example.com/cart"))).toMatchObject({ allow: true });
    expect(await judge.judge(nav("https://example.com/"))).toMatchObject({ allow: false, code: "needs-grant" });
  });

  it("refuses every non-web scheme", async () => {
    const { judge } = world();
    for (const u of ["data:text/html,<script>1</script>", "blob:https://shop.example.com/x", "file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "ftp://shop.example.com/", "view-source:https://shop.example.com/", "about:blank", "not a url"]) {
      expect(await judge.judge(nav(u)), u).toMatchObject({ allow: false, code: "scheme" });
    }
  });

  it("http needs the grant to say so, and other ports need to be listed", async () => {
    const { judge } = world();
    expect(await judge.judge(nav("http://shop.example.com/"))).toMatchObject({ allow: false });
    expect(await judge.judge(nav("https://shop.example.com:8443/"))).toMatchObject({ allow: false });
    const b = world({ schemes: ["http", "https"], ports: [8443, 443, 80] });
    expect(await b.judge.judge(nav("http://shop.example.com/"))).toMatchObject({ allow: true });
    expect(await b.judge.judge(nav("https://shop.example.com:8443/"))).toMatchObject({ allow: true });
  });

  it("a redirect the browser saw from an approved site may land on any public site, once", async () => {
    const { judge } = world();
    const via = await judge.judge(nav("https://cdn.other.net/landing", { redirectChain: ["https://shop.example.com/out"] }));
    expect(via).toMatchObject({ allow: true, viaRedirect: true });
    // The same destination reached directly, or from a chain that began outside the grant, is not.
    expect(await judge.judge(nav("https://cdn.other.net/landing"))).toMatchObject({ allow: false, code: "needs-grant" });
    expect(await judge.judge(nav("https://cdn.other.net/landing", { redirectChain: ["https://example.com/"] }))).toMatchObject({ allow: false, code: "out-of-scope" });
  });

  it("a redirect cannot reach protected space, however it got there", async () => {
    const { judge } = world();
    for (const [host, code] of [["meta.evil.test", "protected-destination"], ["loop.evil.test", "protected-destination"], ["this-box.flagship.services", "protected-destination"], ["printer.local", "local-network"]] as const) {
      expect(await judge.judge(nav(`https://${host}/`, { redirectChain: ["https://shop.example.com/out"] })), host).toMatchObject({ allow: false, code });
    }
    for (const raw of ["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://127.0.0.1:8080/", "http://0x7f.1/", "http://[::ffff:169.254.169.254]/"]) {
      expect(await judge.judge(nav(raw, { redirectChain: ["https://shop.example.com/out"] })), raw).toMatchObject({ allow: false });
    }
  });

  it("DNS rebinding: a name with one public and one internal answer is refused, and the checked addresses are returned", async () => {
    const { judge } = world({ origins: ["rebind.evil.test", "shop.example.com"] });
    expect(await judge.judge(nav("https://rebind.evil.test/"))).toMatchObject({ allow: false, code: "local-network" });
    const ok = await judge.judge(nav("https://shop.example.com/"));
    expect(ok).toMatchObject({ allow: true, addresses: ["93.184.216.34"] });
    expect(await judge.judge(nav("https://nope.example.com/"))).toMatchObject({ allow: false, code: "dns-failed" });
    const dead = world({ origins: ["gone.example.com"] });
    expect(await dead.judge.judge(nav("https://gone.example.com/"))).toMatchObject({ allow: false, code: "dns-failed" });
  });

  it("the control host and cloud metadata stay blocked even with a whole-network grant", async () => {
    const { judge } = world({ origins: ["this-box.flagship.services", "meta.evil.test"], localNetwork: { kind: "whole-lan" } });
    expect(await judge.judge(nav("https://this-box.flagship.services/"))).toMatchObject({ allow: false, code: "protected-destination" });
    expect(await judge.judge(nav("https://meta.evil.test/"))).toMatchObject({ allow: false, code: "protected-destination" });
    expect(await judge.judge(nav("https://127.0.0.1/"))).toMatchObject({ allow: false, code: "protected-destination" });
  });

  it("local-network access is its own grant: exact targets, or the whole network", async () => {
    const none = world();
    expect(await none.judge.judge(nav("https://printer.local/"))).toMatchObject({ allow: false, code: "local-network" });
    const exact = world({ localNetwork: { kind: "exact", hosts: ["printer.local"] } });
    expect(await exact.judge.judge(nav("https://printer.local/"))).toMatchObject({ allow: true });
    expect(await exact.judge.judge(nav("https://nas.home/"))).toMatchObject({ allow: false, code: "local-network" });
    const lan = world({ localNetwork: { kind: "whole-lan" } });
    expect(await lan.judge.judge(nav("https://nas.home/"))).toMatchObject({ allow: true });
  });

  it("subresources, workers and sockets need an in-scope page and a public destination", async () => {
    const { judge } = world();
    const from = "https://shop.example.com/cart";
    for (const kind of ["subresource", "worker", "websocket"] as const) {
      expect(await judge.judge({ serviceId: "app-a", url: "https://cdn.other.net/x.js", kind, initiatorUrl: from }), kind).toMatchObject({ allow: true });
      expect(await judge.judge({ serviceId: "app-a", url: "https://cdn.other.net/x.js", kind, initiatorUrl: "https://example.com/" }), kind).toMatchObject({ allow: false, code: "out-of-scope" });
      expect(await judge.judge({ serviceId: "app-a", url: "https://printer.local/x", kind, initiatorUrl: from }), kind).toMatchObject({ allow: false });
      expect(await judge.judge({ serviceId: "app-a", url: "https://meta.evil.test/", kind, initiatorUrl: from }), kind).toMatchObject({ allow: false, code: "protected-destination" });
    }
  });

  it("downloads need the download capability", async () => {
    const without = world();
    expect(await without.judge.judge({ serviceId: "app-a", url: "https://shop.example.com/f.zip", kind: "download" })).toMatchObject({ allow: false });
    const withIt = world({ capabilities: ["navigate", "download"] });
    expect(await withIt.judge.judge({ serviceId: "app-a", url: "https://shop.example.com/f.zip", kind: "download" })).toMatchObject({ allow: true });
  });

  it("grants are per service: another app has none", async () => {
    const { judge } = world();
    expect(await judge.judge({ serviceId: "app-b", url: "https://shop.example.com/", kind: "document" })).toMatchObject({ allow: false, code: "no-grant" });
  });

  it("once, session and revocation", async () => {
    const once = world({ duration: "once" });
    expect(await once.judge.judge(nav("https://shop.example.com/"))).toMatchObject({ allow: true });
    expect(await once.judge.judge(nav("https://shop.example.com/again"))).toMatchObject({ allow: false, code: "no-grant" });
    const sess = world({ duration: "session" }, { sessionId: "s1" });
    expect(await sess.judge.judge(nav("https://shop.example.com/", { sessionId: "s1" }))).toMatchObject({ allow: true });
    expect(await sess.judge.judge(nav("https://shop.example.com/", { sessionId: "s2" }))).toMatchObject({ allow: false });
    sess.grants.endSession("s1");
    expect(await sess.judge.judge(nav("https://shop.example.com/", { sessionId: "s1" }))).toMatchObject({ allow: false });
    const svc = world();
    expect(svc.grants.revokeService("app-a")).toHaveLength(1);
    expect(await svc.judge.judge(nav("https://shop.example.com/"))).toMatchObject({ allow: false });
  });

  it("an expired grant stops working", async () => {
    const w = world();
    w.grants.revokeService("app-a");
    const t = world();
    t.grants.approve({ serviceId: "app-c", capabilities: ["navigate"], origins: ["shop.example.com"], duration: "service" }, { ttlMs: 500 });
    t.advance(600);
    expect(await t.judge.judge({ serviceId: "app-c", url: "https://shop.example.com/", kind: "document" })).toMatchObject({ allow: false });
  });
});

describe("one context per service", () => {
  it("each service gets its own context, once, and targets are owned before they are used", async () => {
    const reg = new ContextRegistry();
    let n = 0;
    const a1 = await reg.contextFor("app-a", async () => `ctx-${++n}`);
    const a2 = await reg.contextFor("app-a", async () => `ctx-${++n}`);
    const b = await reg.contextFor("app-b", async () => `ctx-${++n}`);
    expect([a1, a2, b]).toEqual(["ctx-1", "ctx-1", "ctx-2"]);
    expect(reg.attach({ targetId: "t1", browserContextId: a1 })).toEqual({ allow: true, serviceId: "app-a" });
    expect(reg.attach({ targetId: "t2", browserContextId: b })).toEqual({ allow: true, serviceId: "app-b" });
    expect(() => reg.assertOwned("app-b", "t1")).toThrow(PolicyError);
    expect(() => reg.assertOwned("app-a", "ghost")).toThrow(/not one of this app's/);
  });

  it("a popup or worker joins its opener's context; anything else is rejected, not raced", () => {
    const reg = new ContextRegistry();
    void reg.contextFor("app-a", async () => "ctxA");
    return reg.contextFor("app-a", async () => "ctxA").then(() => {
      reg.attach({ targetId: "t1", browserContextId: "ctxA" });
      expect(reg.attach({ targetId: "pop", browserContextId: "ctxA", openerId: "t1" })).toMatchObject({ allow: true, serviceId: "app-a" });
      expect(reg.attach({ targetId: "orphan" })).toMatchObject({ allow: false });
      expect(reg.attach({ targetId: "default-ctx", browserContextId: "the-owners-browser" })).toMatchObject({ allow: false });
      expect(reg.attach({ targetId: "escaped", browserContextId: "the-owners-browser", openerId: "t1" })).toMatchObject({ allow: false });
    });
  });

  it("uninstall or revocation hands back everything to close and the context to dispose", async () => {
    const reg = new ContextRegistry();
    const c = await reg.contextFor("app-a", async () => "ctxA");
    reg.attach({ targetId: "t1", browserContextId: c });
    reg.attach({ targetId: "t2", browserContextId: c });
    expect(reg.destroyService("app-a")).toEqual({ targets: ["t1", "t2"], contextId: "ctxA" });
    expect(reg.ownerOf("t1")).toBeNull();
  });
});

describe("the live page is checked before and after every action", () => {
  async function rig(urls: string[]) {
    const w = world();
    const reg = new ContextRegistry();
    const c = await reg.contextFor("app-a", async () => "ctxA");
    reg.attach({ targetId: "tab1", browserContextId: c });
    const closed: string[] = [];
    let i = 0;
    const deps = { contexts: reg, judge: w.judge, currentUrl: async () => urls[Math.min(i++, urls.length - 1)]!, closeTab: async (t: string) => void closed.push(t) };
    return { deps, closed, reg };
  }
  const run = (deps: Parameters<typeof guardedAction>[0], action: () => Promise<unknown>) => guardedAction(deps, { serviceId: "app-a", tabId: "tab1", capability: "read-dom" }, action);

  it("runs when the page is in scope before and after", async () => {
    const r = await rig(["https://shop.example.com/a", "https://shop.example.com/b"]);
    expect(await run(r.deps, async () => "<html>")).toBe("<html>");
    expect(r.closed).toEqual([]);
  });

  it("a page already outside the grant gets no action and is closed", async () => {
    const r = await rig(["https://evil.example.org/"]);
    let ran = false;
    await expect(run(r.deps, async () => void (ran = true))).rejects.toMatchObject({ code: "origin-changed" });
    expect(ran).toBe(false);
    expect(r.closed).toEqual(["tab1"]);
  });

  it("a page that navigates away DURING the action withholds the result and is closed (TOCTOU)", async () => {
    const r = await rig(["https://shop.example.com/a", "https://evil.example.org/stolen"]);
    await expect(run(r.deps, async () => "secret form contents")).rejects.toMatchObject({ code: "origin-changed" });
    expect(r.closed).toEqual(["tab1"]);
    expect(() => r.reg.assertOwned("app-a", "tab1")).toThrow(/closed for leaving/);
  });

  it("another service's tab, and an action the grant does not include, are refused", async () => {
    const r = await rig(["https://shop.example.com/a"]);
    await expect(guardedAction(r.deps, { serviceId: "app-b", tabId: "tab1", capability: "read-dom" }, async () => 1)).rejects.toMatchObject({ code: "not-owner" });
    const w = world({ capabilities: ["navigate"] });
    const reg = new ContextRegistry();
    reg.attach({ targetId: "tab1", browserContextId: await reg.contextFor("app-a", async () => "c") });
    await expect(guardedAction({ contexts: reg, judge: w.judge, currentUrl: async () => "https://shop.example.com/", closeTab: async () => {} }, { serviceId: "app-a", tabId: "tab1", capability: "screenshot" }, async () => 1)).rejects.toMatchObject({ code: "origin-changed" });
  });

  it("oversized output is not handed to the app", async () => {
    const r = await rig(["https://shop.example.com/a"]);
    await expect(guardedAction(r.deps, { serviceId: "app-a", tabId: "tab1", capability: "read-dom", maxBytes: 10 }, async () => "x".repeat(100))).rejects.toBeInstanceOf(PolicyError);
  });
});
