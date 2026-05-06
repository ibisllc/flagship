import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { TabRegistry } from "../../src/browser/tabRegistry.js";
import { DomainGate } from "../../src/browser/domainGate.js";
import { PhonePipe } from "../../src/browser/phonePipe.js";
import { InMemoryAlertInbox } from "../../src/alertInbox.js";
import { InMemoryAppAuthTokens } from "../../src/appAuthToken.js";
import { buildBrowserApiHandlers } from "../../src/browser/apiHandlers.js";
import type { HttpRequest } from "../../src/runtime.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

describe("Browser HTTP handlers", () => {
  let server: FakeCdpServer;
  let mgr: BrowserManager;
  let registry: TabRegistry;
  let gate: DomainGate;
  let pipe: PhonePipe;
  let tokens: InMemoryAppAuthTokens;
  let inbox: InMemoryAlertInbox;
  let handle: (req: HttpRequest) => Promise<{ status: number; headers?: Record<string, string>; body: string | Buffer } | null>;
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    server = new FakeCdpServer();
    const r = await server.start();
    mgr = new BrowserManager({ endpoint: r.endpoint, retryDelayMs: 50, maxConnectAttempts: 5 });
    await mgr.start();
    registry = new TabRegistry(mgr);
    registry.start();
    gate = new DomainGate();
    gate.setGrant("alice--shopper", ["amazon.com", "*.amazon.com"]);
    gate.setGrant("bob--mailer", ["gmail.com"]);
    inbox = new InMemoryAlertInbox();
    pipe = new PhonePipe({
      browser: mgr,
      tabRegistry: registry,
      inbox,
      nextRef: (() => {
        let n = 0;
        return () => `ref-${++n}`;
      })(),
    });
    pipe.start();
    tokens = new InMemoryAppAuthTokens();
    aliceToken = await tokens.mint("alice--shopper");
    bobToken = await tokens.mint("bob--mailer");
    handle = buildBrowserApiHandlers({
      browser: mgr,
      tabRegistry: registry,
      domainGate: gate,
      phonePipe: pipe,
      appAuthTokens: tokens,
    });
  });
  afterEach(async () => {
    pipe.stop();
    registry.stop();
    await mgr.stop();
    await server.stop();
  });

  function req(args: {
    method: string;
    path: string;
    token?: string;
    body?: unknown;
  }): HttpRequest {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (args.token) headers["authorization"] = `Bearer ${args.token}`;
    return {
      method: args.method,
      path: args.path,
      headers,
      body: args.body !== undefined ? Buffer.from(JSON.stringify(args.body)) : Buffer.alloc(0),
    };
  }

  it("returns null for non-/api/browser paths so the runtime can keep dispatching", async () => {
    const r = await handle(req({ method: "GET", path: "/api/health" }));
    expect(r).toBeNull();
  });

  it("401 when the bearer is missing or unknown", async () => {
    const r1 = await handle(req({ method: "POST", path: "/api/browser/tabs", body: { url: "https://amazon.com/" } }));
    expect(r1?.status).toBe(401);
    const r2 = await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: "bogus", body: { url: "https://amazon.com/" } }),
    );
    expect(r2?.status).toBe(401);
  });

  it("403 when the app has no browser grant (didn't declare browser.domains)", async () => {
    // Mint a token for an app with no grant.
    const noGrantToken = await tokens.mint("carol--simple");
    const r = await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: noGrantToken, body: { url: "https://amazon.com/" } }),
    );
    expect(r?.status).toBe(403);
    expect(JSON.parse(String(r?.body)).error).toContain("does not declare browser.domains");
  });

  it("POST /api/browser/tabs opens a tab when URL is allowlisted; assigns ownership", async () => {
    let createdUrl = "";
    server.on("Target.createTarget", (params) => {
      createdUrl = (params as { url: string }).url;
      return { targetId: "tab-amzn" };
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: aliceToken,
        body: { url: "https://www.amazon.com/" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r?.body)).tabId).toBe("tab-amzn");
    expect(createdUrl).toBe("https://www.amazon.com/");
    expect(registry.appIdForTab("tab-amzn")).toBe("alice--shopper");
  });

  it("POST /api/browser/tabs rejects URL outside the allowlist with 403", async () => {
    const r = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: aliceToken,
        body: { url: "https://walmart.com/" },
      }),
    );
    expect(r?.status).toBe(403);
    expect(JSON.parse(String(r?.body)).error).toContain("not in app's browser.domains");
  });

  it("400 when openTab body is missing url", async () => {
    const r = await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: {} }),
    );
    expect(r?.status).toBe(400);
  });

  it("cross-tenant access to another app's tab returns 404 (NOT 403, no existence leak)", async () => {
    // Bob owns tab-bob-1.
    server.on("Target.createTarget", () => ({ targetId: "tab-bob-1" }));
    await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: bobToken, body: { url: "https://gmail.com/" } }),
    );
    // Alice tries to navigate it.
    const r = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-bob-1/navigate",
        token: aliceToken,
        body: { url: "https://amazon.com/" },
      }),
    );
    expect(r?.status).toBe(404);
  });

  it("navigate enforces DomainGate before reaching the browser", async () => {
    // Alice opens a tab to amazon.
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }),
    );
    // Tries to navigate to gmail (not allowed for alice).
    const r = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-1/navigate",
        token: aliceToken,
        body: { url: "https://gmail.com/" },
      }),
    );
    expect(r?.status).toBe(403);
  });

  it("fill / click / readDOM / screenshot all work for the owning app", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    // Differentiate: fill/click expressions return a boolean truthy result;
    // readDOM expression returns the outerHTML string.
    server.on("Runtime.evaluate", (params) => {
      const expr = (params as { expression: string }).expression;
      if (expr.includes(".outerHTML")) {
        return { result: { type: "string", value: "<h1>hi</h1>" } };
      }
      return { result: { type: "boolean", value: true } };
    });
    await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }),
    );
    const fillR = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-1/fill",
        token: aliceToken,
        body: { selector: "#q", value: "lamp" },
      }),
    );
    expect(fillR?.status).toBe(200);
    const clickR = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-1/click",
        token: aliceToken,
        body: { selector: "#submit" },
      }),
    );
    expect(clickR?.status).toBe(200);
    const domR = await handle(
      req({
        method: "GET",
        path: "/api/browser/tabs/tab-1/dom?selector=h1",
        token: aliceToken,
      }),
    );
    expect(domR?.status).toBe(200);
    expect(JSON.parse(String(domR?.body)).outerHTML).toBe("<h1>hi</h1>");
    const shotR = await handle(
      req({
        method: "GET",
        path: "/api/browser/tabs/tab-1/screenshot",
        token: aliceToken,
      }),
    );
    expect(shotR?.status).toBe(200);
    expect(shotR?.headers?.["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(shotR?.body)).toBe(true);
  });

  it("DELETE /api/browser/tabs/:id closes the tab and forgets ownership", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    let closeCount = 0;
    server.on("Target.closeTarget", () => {
      closeCount++;
      return { success: true };
    });
    await handle(
      req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }),
    );
    const r = await handle(
      req({ method: "DELETE", path: "/api/browser/tabs/tab-1", token: aliceToken }),
    );
    expect(r?.status).toBe(200);
    expect(closeCount).toBe(1);
    expect(registry.appIdForTab("tab-1")).toBeNull();
  });

  it("GET /api/browser/tabs lists this app's tabs only", async () => {
    server.on("Target.createTarget", () => ({ targetId: `tab-${Math.random().toString(36).slice(2, 6)}` }));
    await handle(req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }));
    await handle(req({ method: "POST", path: "/api/browser/tabs", token: bobToken, body: { url: "https://gmail.com/" } }));
    const r = await handle(req({ method: "GET", path: "/api/browser/tabs", token: aliceToken }));
    expect(r?.status).toBe(200);
    const tabs = JSON.parse(String(r?.body)).tabs;
    expect(tabs.length).toBe(1);
    // bob's tab should not appear.
  });

  it("POST .../request-input emits an alert and returns a screenshotRef", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    await handle(req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }));
    const r = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-1/request-input",
        token: aliceToken,
        body: { inputKind: "password", host: "amazon.com" },
      }),
    );
    expect(r?.status).toBe(200);
    const ref = JSON.parse(String(r?.body)).screenshotRef;
    expect(ref).toMatch(/^ref-/);
    expect(inbox.size()).toBe(1);
  });

  it("GET /api/browser/screenshot/:ref returns the PNG bytes", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    await handle(req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }));
    const reqR = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-1/request-input",
        token: aliceToken,
        body: { inputKind: "password" },
      }),
    );
    const ref = JSON.parse(String(reqR?.body)).screenshotRef;
    const r = await handle(req({ method: "GET", path: `/api/browser/screenshot/${ref}`, token: aliceToken }));
    expect(r?.status).toBe(200);
    expect(r?.headers?.["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(r?.body)).toBe(true);
    // Unknown ref → 404.
    const r2 = await handle(req({ method: "GET", path: "/api/browser/screenshot/nope", token: aliceToken }));
    expect(r2?.status).toBe(404);
  });

  it("405 for an unsupported verb under /tabs/:id/", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-1" }));
    await handle(req({ method: "POST", path: "/api/browser/tabs", token: aliceToken, body: { url: "https://amazon.com/" } }));
    const r = await handle(
      req({ method: "POST", path: "/api/browser/tabs/tab-1/eval", token: aliceToken, body: {} }),
    );
    expect(r?.status).toBe(405);
  });
});
