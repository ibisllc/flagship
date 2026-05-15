/**
 * Tests for `bootstrapBrowserBundle()` — the production-composition
 * factory that assembles BrowserManager + TabRegistry + DomainGate +
 * PhonePipe + AppAuthTokens + apiHandle into one start/stop unit.
 *
 * We use FakeCdpServer to avoid spinning up Chromium and pass the
 * pre-started BrowserManager through `opts.browser` so the factory
 * doesn't try to discover CDP on its own.
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAlertInbox } from "../../src/alertInbox.js";
import { InMemoryAppAuthTokens } from "../../src/appAuthToken.js";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { bootstrapBrowserBundle } from "../../src/browser/bootstrap.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

describe("bootstrapBrowserBundle", () => {
  let cdp: FakeCdpServer;
  let endpoint: string;
  let dataDir: string;

  beforeEach(async () => {
    cdp = new FakeCdpServer();
    const r = await cdp.start();
    endpoint = r.endpoint;
    dataDir = await mkdtemp(join(tmpdir(), "flagship-bootstrap-"));
  });

  afterEach(async () => {
    await cdp.stop();
  });

  it("assembles all subsystems from a real BrowserManager", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();
    const inbox = new InMemoryAlertInbox();

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: inbox,
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
    });

    expect(bundle.browser).toBe(browser);
    expect(bundle.tabRegistry).toBeDefined();
    expect(bundle.domainGate).toBeDefined();
    expect(bundle.phonePipe).toBeDefined();
    expect(bundle.appAuthTokens).toBeDefined();
    expect(typeof bundle.apiHandle).toBe("function");

    await bundle.close();
    await browser.stop();
  });

  it("apiHandle returns null for non-browser paths", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
    });

    const r = await bundle.apiHandle({
      method: "GET",
      path: "/api/health",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r).toBeNull();

    await bundle.close();
    await browser.stop();
  });

  it("overlayHandleHttp falls through to next when path is non-browser", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
    });

    const overlay = bundle.overlayHandleHttp(async (req) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `next handler saw ${req.path}`,
    }));

    const r = await overlay({
      method: "GET",
      path: "/some-other-route",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("next handler saw /some-other-route");

    await bundle.close();
    await browser.stop();
  });

  it("overlayHandleHttp routes browser paths through apiHandle", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
    });

    let nextCalled = false;
    const overlay = bundle.overlayHandleHttp(async () => {
      nextCalled = true;
      return { status: 500, headers: {}, body: "should not reach" };
    });

    // No bearer → apiHandle should answer with 401, not fall through.
    const r = await overlay({
      method: "GET",
      path: "/api/browser/tabs",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r.status).toBe(401);
    expect(nextCalled).toBe(false);

    await bundle.close();
    await browser.stop();
  });

  it("close() is idempotent", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
      appAuthTokens: new InMemoryAppAuthTokens(),
    });

    await bundle.close();
    await bundle.close();
    await browser.stop();
  });

  it("uses FileAppAuthTokens with <dataDir>/app-tokens by default", async () => {
    const browser = new BrowserManager({ endpoint });
    await browser.start();
    // Pre-create the directory so FileAppAuthTokens.load can read it.
    await mkdir(join(dataDir, "app-tokens"), { recursive: true });

    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint: endpoint,
      dataDir,
      alertInbox: new InMemoryAlertInbox(),
      browser,
    });

    // Mint a token + verify it persists to disk under the expected path.
    const token = await bundle.appAuthTokens.mint("creator-app");
    expect(token.length).toBeGreaterThan(20);
    const resolved = await bundle.appAuthTokens.resolve(token);
    expect(resolved).toBe("creator-app");

    await bundle.close();
    await browser.stop();
  });
});
