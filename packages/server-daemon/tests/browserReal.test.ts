/**
 * The app browser under policy, against a REAL Chromium driven over CDP (SECURITY-HARDENING-PLAN.md 10.4,
 * SEC-BROWSER-002). Chromium resolves the test names to this machine's loopback with
 * --host-resolver-rules, while the judge is told they are public (or private, or metadata) addresses, so
 * what is under test is the interception, the contexts and the guard, not DNS. Skipped where Playwright's
 * Chromium is not installed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { BrowserManager } from "../src/browser/browserManager.js";
import { PolicedBrowser } from "../src/browser/policedBrowser.js";
import { BrowserGrants, BrowserJudge, ContextRegistry, PolicyError } from "../src/browser/policy/index.js";

const exe = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const HAVE = exe !== "" && existsSync(exe);
const SHOP = "alice--shop";
const OTHER = "alice--other";

const ADDR: Record<string, string[]> = {
  "shop.test": ["93.184.216.34"],
  "evil.test": ["93.184.216.35"],
  "lan.test": ["192.168.1.5"],
  "meta.test": ["169.254.169.254"],
};

describe.skipIf(!HAVE)("app browser under policy (real Chromium)", () => {
  let chrome: ChildProcess;
  let server: Server;
  let port = 0;
  let dir = "";
  let cdp: BrowserManager;
  let pb: PolicedBrowser;
  let grants: BrowserGrants;
  const hits: string[] = [];
  const denied: Array<{ url: string; code: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const host = (req.headers.host ?? "").split(":")[0];
      hits.push(`${host}${req.url}`);
      const html = (body: string, extra: Record<string, string> = {}) => {
        res.writeHead(200, { "content-type": "text/html", ...extra });
        res.end(`<!doctype html><title>t</title>${body}`);
      };
      const url = req.url ?? "/";
      if (url.startsWith("/home")) {
        html(`<div id=c></div><img src="http://evil.test:${port}/pixel"><img src="http://lan.test:${port}/lanpixel"><a id=go href="http://shop.test:${port}/redir">go</a><a id=out href="http://evil.test:${port}/direct">out</a><script>document.getElementById('c').textContent=document.cookie</script>`);
      } else if (url.startsWith("/redir")) {
        res.writeHead(302, { location: `http://evil.test:${port}/landed` });
        res.end();
      } else if (url.startsWith("/popup")) {
        html(`<a id=pop href="http://evil.test:${port}/popped" target="_blank" style="position:fixed;left:0;top:0;width:300px;height:300px;display:block">pop</a>`);
      } else if (url.startsWith("/setcookie")) {
        html("<p id=c>set</p>", { "set-cookie": "sid=secret; Path=/" });
      } else if (url.startsWith("/readcookie")) {
        html(`<div id=c></div><script>document.getElementById('c').textContent=document.cookie</script>`);
      } else html("<p id=c>plain</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;

    dir = mkdtempSync(join(tmpdir(), "chrome-"));
    const rules = Object.keys(ADDR).map((h) => `MAP ${h} 127.0.0.1`).join(",");
    chrome = spawn(exe, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${dir}`, "--remote-debugging-port=0", `--host-resolver-rules=${rules}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("chromium did not start")), 150_000);
      let buf = "";
      chrome.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    cdp = new BrowserManager({ endpoint: "http://unused", fetchVersion: async () => ({ webSocketDebuggerUrl: wsUrl }) });
    await cdp.start();
    grants = new BrowserGrants();
    for (const id of [SHOP, OTHER]) {
      grants.approve({ serviceId: id, capabilities: ["navigate", "read-dom", "screenshot", "input"], origins: ["shop.test"], schemes: ["http"], ports: [port], duration: "service" });
    }
    grants.approve({ serviceId: "alice--meta", capabilities: ["navigate"], origins: ["meta.test"], schemes: ["http"], ports: [port], duration: "service" });
    const judge = new BrowserJudge({ grants, resolve: async (h) => ADDR[h] ?? [] });
    pb = new PolicedBrowser({ cdp, contexts: new ContextRegistry(), judge, onDenied: (e) => denied.push({ url: e.url, code: e.code }) });
    await pb.start();
  }, 200_000);

  afterAll(async () => {
    await pb?.stop();
    await cdp?.stop();
    if (chrome) {
      const exited = new Promise<void>((r) => chrome.once("exit", () => r()));
      chrome.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const clear = () => {
    hits.length = 0;
    denied.length = 0;
  };
  const text = async (svc: string, tab: string) => (await pb.readDOM(svc, tab, "#c")) ?? "";

  it("opens a page inside the grant, and lets it load public subresources but never your network", async () => {
    clear();
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/home`);
    for (let i = 0; i < 60 && !(hits.includes("evil.test/pixel") && denied.some((d) => d.url.includes("lanpixel"))); i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits).toContain("shop.test/home");
    expect(hits).toContain("evil.test/pixel"); // a public image the page asked for
    expect(hits.some((h) => h.startsWith("lan.test/"))).toBe(false); // a private address was never contacted
    expect(denied.some((d) => d.url.includes("lanpixel"))).toBe(true);
    await pb.closeTab(SHOP, tabId);
  }, 30_000);

  it("refuses a direct navigation outside the grant before the request leaves", async () => {
    clear();
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/plain`);
    await expect(pb.navigate(SHOP, tabId, `http://evil.test:${port}/direct`)).rejects.toBeInstanceOf(PolicyError);
    expect(hits.some((h) => h.startsWith("evil.test/direct"))).toBe(false);
    await pb.closeTab(SHOP, tabId);
  }, 30_000);

  it("refuses an opening page that is outside the grant, and cloud metadata even with a grant for its name", async () => {
    clear();
    await expect(pb.openTab(SHOP, `http://evil.test:${port}/direct`)).rejects.toBeInstanceOf(PolicyError);
    await expect(pb.openTab("alice--meta", `http://meta.test:${port}/x`)).rejects.toBeInstanceOf(PolicyError);
    expect(hits.some((h) => h.startsWith("meta.test/"))).toBe(false);
    expect(denied.map((d) => d.code)).toEqual(expect.arrayContaining(["needs-grant", "protected-destination"]));
  }, 30_000);

  it("follows a redirect the browser saw from inside the grant, and the guard then closes the tab that ended elsewhere", async () => {
    clear();
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/home`);
    await new Promise((r) => setTimeout(r, 300));
    // The link goes to shop.test/redir, which 302s to evil.test: a redirect rooted in the grant is allowed...
    await expect(pb.click(SHOP, tabId, "#go")).rejects.toBeInstanceOf(PolicyError);
    // ...but the action ended outside the approval, so the tab is gone and nothing more can be done in it.
    expect(hits).toContain("evil.test/landed");
    await expect(pb.readDOM(SHOP, tabId, "#c")).rejects.toBeInstanceOf(PolicyError);
  }, 30_000);

  it("does not let a popup carry the page somewhere it was not approved to go", async () => {
    clear();
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/popup`);
    await new Promise((r) => setTimeout(r, 300));
    // A real user gesture (mouse down and up), so Chromium opens the popup instead of blocking it itself.
    await cdp.dispatchInput(tabId, { kind: "mouseMove", x: 50, y: 50 });
    await cdp.dispatchInput(tabId, { kind: "mouseDown", x: 50, y: 50 });
    await cdp.dispatchInput(tabId, { kind: "mouseUp", x: 50, y: 50 });
    for (let i = 0; i < 100 && !denied.some((d) => d.url.includes("popped")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(hits.some((h) => h.startsWith("evil.test/popped"))).toBe(false);
    expect(denied.some((d) => d.url.includes("popped"))).toBe(true);
    await pb.closeTab(SHOP, tabId).catch(() => {});
  }, 60_000);

  it("gives every app its own cookies and storage, even for the same site", async () => {
    clear();
    const a = await pb.openTab(SHOP, `http://shop.test:${port}/setcookie`);
    await new Promise((r) => setTimeout(r, 200));
    const a2 = await pb.openTab(SHOP, `http://shop.test:${port}/readcookie`);
    await new Promise((r) => setTimeout(r, 200));
    expect(await text(SHOP, a2.tabId)).toContain("sid=secret");
    const b = await pb.openTab(OTHER, `http://shop.test:${port}/readcookie`);
    await new Promise((r) => setTimeout(r, 200));
    expect(await text(OTHER, b.tabId)).not.toContain("sid=secret");
    await expect(pb.readDOM(OTHER, a.tabId, "#c")).rejects.toBeInstanceOf(PolicyError); // not its tab
    for (const [s, t] of [[SHOP, a.tabId], [SHOP, a2.tabId], [OTHER, b.tabId]] as const) await pb.closeTab(s, t).catch(() => {});
  }, 40_000);

  it("revoking a service closes its tabs and disposes its context", async () => {
    const t = await pb.openTab(OTHER, `http://shop.test:${port}/plain`);
    await pb.revokeService(OTHER);
    await expect(pb.readDOM(OTHER, t.tabId, "#c")).rejects.toBeInstanceOf(PolicyError);
    expect(pb.tabsOf(OTHER)).toEqual([]);
  }, 30_000);
});

/**
 * The same browser, started the way production starts it (egress.ts): Chromium's default proxy approves
 * nothing and it resolves no names itself; each app's context goes through its own pinning proxy, which
 * connects only to the addresses the judge approved for that app. The proxies' dial seam maps the test's
 * public addresses to this machine's test server, so a hit on the server proves the proxy carried it.
 */
describe.skipIf(!HAVE)("app browser through the pinning proxies (real Chromium)", () => {
  let chrome: ChildProcess;
  let server: Server;
  let port = 0;
  let dir = "";
  let cdp: BrowserManager;
  let pb: PolicedBrowser;
  let proxies: import("../src/browser/egress.js").ServiceProxies;
  const hits: string[] = [];
  const dials: string[] = [];
  let rebindCalls = 0;
  const NAMES: Record<string, () => string[]> = {
    "shop.test": () => ["93.184.216.34"],
    "self.test": () => ["93.184.216.99"],
    // Public on the first look, cloud metadata on every look after.
    "rebind.test": () => (rebindCalls++ === 0 ? ["93.184.216.40"] : ["169.254.169.254"]),
  };

  beforeAll(async () => {
    const { ServiceProxies, chromiumEgressFlags } = await import("../src/browser/egress.js");
    server = createServer((req, res) => {
      hits.push(`${(req.headers.host ?? "").split(":")[0]}${req.url}`);
      res.writeHead(200, { "content-type": "text/html" });
      if ((req.url ?? "").startsWith("/home")) {
        res.end(`<!doctype html><title>t</title><p id=c>home</p><img src="http://rebind.test:${port}/one"><img src="http://self.test:${port}/self">`);
      } else res.end("<!doctype html><title>t</title><p id=c>plain</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    proxies = new ServiceProxies({
      protectedAddresses: () => ["93.184.216.99"],
      dial: (address, p) => {
        dials.push(address);
        return { host: "127.0.0.1", port: p };
      },
    });
    const flags = chromiumEgressFlags(await proxies.denyAll());
    dir = mkdtempSync(join(tmpdir(), "chrome-egress-"));
    chrome = spawn(exe, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${dir}`, "--remote-debugging-port=0", ...flags, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("chromium did not start")), 150_000);
      let buf = "";
      chrome.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    cdp = new BrowserManager({ endpoint: "http://unused", fetchVersion: async () => ({ webSocketDebuggerUrl: wsUrl }) });
    await cdp.start();
    const grants = new BrowserGrants();
    grants.approve({ serviceId: SHOP, capabilities: ["navigate", "read-dom"], origins: ["shop.test"], schemes: ["http"], ports: [port], duration: "service" });
    grants.approve({ serviceId: OTHER, capabilities: ["navigate", "read-dom"], origins: ["other.test"], schemes: ["http"], ports: [port], duration: "service" });
    const judge = new BrowserJudge({ grants, resolve: async (h) => NAMES[h]?.() ?? [] });
    pb = new PolicedBrowser({
      cdp,
      contexts: new ContextRegistry(),
      judge,
      onApproved: (host, addresses, serviceId) => proxies.allow(serviceId, host, addresses),
      contextOptions: async (serviceId) => ({ proxyServer: await proxies.proxyFor(serviceId), proxyBypassList: "<-loopback>" }),
      onContextGone: (serviceId) => void proxies.close(serviceId),
    });
    await pb.start();
  }, 200_000);

  afterAll(async () => {
    await pb?.stop();
    await cdp?.stop();
    if (chrome) {
      const exited = new Promise<void>((r) => chrome.once("exit", () => r()));
      chrome.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    await proxies?.closeAll();
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("loads the page only through the app's own proxy, to the addresses the judge approved", async () => {
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/home`);
    for (let i = 0; i < 60 && !hits.includes("rebind.test/one"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await pb.readDOM(SHOP, tabId, "#c")).toContain(">home<");
    expect(hits).toContain("shop.test/home");
    expect(dials).toContain("93.184.216.34");
    // .test names resolve nowhere: every connection the server saw came through a pinned dial.
    expect(dials.every((a) => ["93.184.216.34", "93.184.216.40"].includes(a))).toBe(true);
    await pb.closeTab(SHOP, tabId);
  }, 30_000);

  it("a name that turns into cloud metadata after the first look never reaches the new address", async () => {
    rebindCalls = 0;
    hits.length = 0;
    dials.length = 0;
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/home`);
    for (let i = 0; i < 60 && !hits.includes("rebind.test/one"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits).toContain("rebind.test/one");
    // A second load of the same name: the judge now sees metadata and refuses; the proxy never dialed it.
    await pb.navigate(SHOP, tabId, `http://shop.test:${port}/home?again`).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    expect(hits.filter((h) => h === "rebind.test/one")).toHaveLength(1);
    expect(dials).not.toContain("169.254.169.254");
    await pb.closeTab(SHOP, tabId);
  }, 30_000);

  it("an address the proxy refuses stays unreachable even though the judge approved it", async () => {
    hits.length = 0;
    const { tabId } = await pb.openTab(SHOP, `http://shop.test:${port}/home`);
    await new Promise((r) => setTimeout(r, 800));
    expect(hits).toContain("shop.test/home");
    expect(hits.some((h) => h.startsWith("self.test"))).toBe(false);
    await pb.closeTab(SHOP, tabId);
  }, 30_000);

  it("one app's approvals open nothing for another, whose own proxy has none", async () => {
    hits.length = 0;
    await expect(pb.openTab(OTHER, `http://shop.test:${port}/plain`)).rejects.toBeInstanceOf(PolicyError);
    expect(hits).toEqual([]);
  }, 30_000);
});
