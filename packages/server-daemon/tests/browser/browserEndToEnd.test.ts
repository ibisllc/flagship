/**
 * End-to-end isolation test for the browser feature.
 *
 * Wires the full daemon-side stack (BrowserManager + TabRegistry +
 * DomainGate + PhonePipe + AlertInbox + apiHandlers + AppPlatform +
 * AppAuthTokens) against a FakeCdpServer. Asserts the contract every
 * tenant boundary stays in place under realistic flows:
 *
 *   - Two apps installed with different browser.domains.
 *   - Each app opens tabs and drives them; cross-tenant access
 *     attempts return 404 (NOT 403, no existence leak).
 *   - DomainGate.check is enforced on both openTab and navigate.
 *   - Descendant popups (window.open) inherit the parent's appId.
 *   - PhonePipe roundtrip: alert → screenshot ref → PSK-signed
 *     response → CDP Input.insertText.
 *   - Uninstall closes the app's tabs + revokes its grant; old
 *     tokens become 401, old tabIds become 404.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signInstallApp,
  signUninstallApp,
  type Keypair,
} from "@flagship/protocol";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { TabRegistry } from "../../src/browser/tabRegistry.js";
import { DomainGate } from "../../src/browser/domainGate.js";
import { PhonePipe } from "../../src/browser/phonePipe.js";
import { buildBrowserApiHandlers } from "../../src/browser/apiHandlers.js";
import { InMemoryAlertInbox } from "../../src/alertInbox.js";
import { InMemoryAppAuthTokens } from "../../src/appAuthToken.js";
import { AppPlatform } from "../../src/appPlatform.js";
import { AppRunner, type CommandRunner } from "../../src/appRunner.js";
import {
  DataProvisioner,
  InMemoryPostgresAdmin,
} from "../../src/dataLayer/index.js";
import type { HttpRequest } from "../../src/runtime.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

const HOST = "alice";
const HOST_FQDN = `home.${HOST}.flagship.services`;

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function fakeSwk(): Uint8Array {
  const swk = new Uint8Array(32);
  crypto.getRandomValues(swk);
  return swk;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const NOOP_CMD: CommandRunner = {
  run: async () => undefined,
  capture: async () => ({ stdout: "", stderr: "" }),
};

function manifestForShopper(): string {
  return JSON.stringify({
    schema_version: 1,
    name: "shopper",
    version: "0.1.0",
    runtime: { image: "ghcr.io/alice/shopper:0.1.0", port: 8080 },
    data: {},
    network: { subdomain: "shopper" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    browser: { domains: ["amazon.com", "*.amazon.com"], login_required: true },
  });
}

function manifestForMailer(): string {
  return JSON.stringify({
    schema_version: 1,
    name: "mailer",
    version: "0.1.0",
    runtime: { image: "ghcr.io/alice/mailer:0.1.0", port: 8080 },
    data: {},
    network: { subdomain: "mailer" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    browser: { domains: ["gmail.com", "*.google.com"] },
  });
}

describe("Browser feature — full-stack isolation", () => {
  let server: FakeCdpServer;
  let browser: BrowserManager;
  let registry: TabRegistry;
  let gate: DomainGate;
  let pipe: PhonePipe;
  let inbox: InMemoryAlertInbox;
  let tokens: InMemoryAppAuthTokens;
  let platform: AppPlatform;
  let irk: Keypair;
  let handle: (req: HttpRequest) => Promise<{ status: number; headers?: Record<string, string>; body: string | Buffer } | null>;

  let shopperToken: string;
  let mailerToken: string;

  beforeEach(async () => {
    server = new FakeCdpServer();
    const r = await server.start();
    browser = new BrowserManager({
      endpoint: r.endpoint,
      retryDelayMs: 50,
      maxConnectAttempts: 5,
    });
    await browser.start();
    registry = new TabRegistry(browser);
    registry.start();
    gate = new DomainGate();
    inbox = new InMemoryAlertInbox();
    let refN = 0;
    pipe = new PhonePipe({
      browser,
      tabRegistry: registry,
      inbox,
      nextRef: () => `ref-${++refN}`,
    });
    pipe.start();
    tokens = new InMemoryAppAuthTokens();
    irk = makeKey();
    platform = new AppPlatform({
      host: { username: HOST, irkPub: irk.publicKey },
      swk: fakeSwk(),
      appRunner: new AppRunner(NOOP_CMD),
      dataProvisioner: new DataProvisioner({ postgres: new InMemoryPostgresAdmin() }),
      appAuthTokens: tokens,
      domainGate: gate,
      tabRegistry: registry,
    });
    handle = buildBrowserApiHandlers({
      browser,
      tabRegistry: registry,
      domainGate: gate,
      phonePipe: pipe,
      appAuthTokens: tokens,
    });

    // Install both apps.
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST,
        slug: "shopper",
        manifestJson: manifestForShopper(),
        addOwnerToMembership: false,
        issuedAt: Date.now(),
      },
      signature: signInstallApp(
        {
          serverId: HOST_FQDN,
          creator: HOST,
          slug: "shopper",
          manifestJson: manifestForShopper(),
          addOwnerToMembership: false,
          issuedAt: Date.now(),
        },
        irk,
      ),
      verify: () => true,
    });
    await platform.install({
      request: {
        serverId: HOST_FQDN,
        creator: HOST,
        slug: "mailer",
        manifestJson: manifestForMailer(),
        addOwnerToMembership: false,
        issuedAt: Date.now(),
      },
      signature: new Uint8Array(64),
      verify: () => true,
    });

    shopperToken = (await tokens.tokenForApp("alice--shopper"))!;
    mailerToken = (await tokens.tokenForApp("alice--mailer"))!;
  });
  afterEach(async () => {
    pipe.stop();
    registry.stop();
    await browser.stop();
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

  it("install wires both apps' grants on the gate", () => {
    expect(gate.hasGrant("alice--shopper")).toBe(true);
    expect(gate.hasGrant("alice--mailer")).toBe(true);
    expect(gate.check("alice--shopper", "https://amazon.com/")).toBe("allow");
    expect(gate.check("alice--mailer", "https://amazon.com/")).toBe("deny");
    expect(gate.check("alice--mailer", "https://mail.google.com/")).toBe("allow");
  });

  it("two apps each open tabs to their own domains; cross-domain navigation is blocked", async () => {
    server.on("Target.createTarget", (params) => {
      const url = (params as { url: string }).url;
      const id = url.includes("amazon") ? "tab-amzn" : "tab-gmail";
      return { targetId: id };
    });

    const shopperOpen = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: shopperToken,
        body: { url: "https://amazon.com/" },
      }),
    );
    expect(shopperOpen?.status).toBe(200);

    const mailerOpen = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: mailerToken,
        body: { url: "https://gmail.com/" },
      }),
    );
    expect(mailerOpen?.status).toBe(200);

    // Shopper tries to navigate to gmail.com → 403 from DomainGate.
    const cross = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-amzn/navigate",
        token: shopperToken,
        body: { url: "https://gmail.com/" },
      }),
    );
    expect(cross?.status).toBe(403);
  });

  it("cross-tenant tabId access returns 404 (no existence leak)", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-mailer-1" }));
    await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: mailerToken,
        body: { url: "https://gmail.com/" },
      }),
    );
    // Shopper attempts every operation against mailer's tab — all 404.
    for (const verb of ["navigate", "fill", "click"]) {
      const r = await handle(
        req({
          method: "POST",
          path: `/api/browser/tabs/tab-mailer-1/${verb}`,
          token: shopperToken,
          body: { url: "https://amazon.com/", selector: "#x", value: "y" },
        }),
      );
      expect(r?.status).toBe(404);
    }
    const r = await handle(
      req({
        method: "DELETE",
        path: "/api/browser/tabs/tab-mailer-1",
        token: shopperToken,
      }),
    );
    expect(r?.status).toBe(404);
  });

  it("descendant popup inherits the opener app via TabRegistry events", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-shopper-1" }));
    await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: shopperToken,
        body: { url: "https://amazon.com/" },
      }),
    );
    server.emitEvent("Target.targetCreated", {
      targetInfo: {
        targetId: "tab-shopper-popup",
        type: "page",
        openerId: "tab-shopper-1",
        url: "https://www.amazon.com/popup",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.appIdForTab("tab-shopper-popup")).toBe("alice--shopper");
    // mailer can't see the popup — 404.
    const r = await handle(
      req({
        method: "GET",
        path: "/api/browser/tabs/tab-shopper-popup/dom?selector=h1",
        token: mailerToken,
      }),
    );
    expect(r?.status).toBe(404);
  });

  it("PhonePipe roundtrip: focus event emits alert; applyInputResponse fires Input.insertText for the right tab", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-shopper-1" }));
    await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: shopperToken,
        body: { url: "https://amazon.com/login" },
      }),
    );

    let typed: { sessionId?: string; text?: string } = {};
    server.on("Input.insertText", (params, sessionId) => {
      typed = { sessionId, text: (params as { text: string }).text };
      return {};
    });

    // Simulate the page-side script firing the binding.
    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: JSON.stringify({
        tabId: "tab-shopper-1",
        kind: "password",
        host: "amazon.com",
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inbox.size()).toBe(1);
    const alert = inbox.list()[0]?.alert;
    expect(alert).toMatchObject({
      kind: "browser-input-needed",
      appId: "alice--shopper",
      tabId: "tab-shopper-1",
      domain: "amazon.com",
      inputKind: "password",
    });
    const ref = (alert as { screenshotRef: string }).screenshotRef;

    // Phone responds (signature verification was already covered upstream;
    // here we exercise the pipe's tabId/inputKind/screenshotRef gate).
    await pipe.applyInputResponse({
      tabId: "tab-shopper-1",
      inputKind: "password",
      value: "hunter2!@#",
      screenshotRef: ref,
    });
    expect(typed.text).toBe("hunter2!@#");
    expect(pipe.pendingCount()).toBe(0);
  });

  it("uninstall closes the app's tabs + revokes the grant; old token is rejected, old tabId becomes 404", async () => {
    server.on("Target.createTarget", () => ({ targetId: "tab-shopper-uninst" }));
    await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: shopperToken,
        body: { url: "https://amazon.com/" },
      }),
    );
    expect(registry.appIdForTab("tab-shopper-uninst")).toBe("alice--shopper");

    await platform.uninstall({
      request: {
        serverId: HOST_FQDN,
        creator: HOST,
        slug: "shopper",
        issuedAt: Date.now(),
      },
      signature: signUninstallApp(
        { serverId: HOST_FQDN, creator: HOST, slug: "shopper", issuedAt: Date.now() },
        irk,
      ),
      verify: () => true,
    });

    expect(gate.hasGrant("alice--shopper")).toBe(false);
    expect(registry.appIdForTab("tab-shopper-uninst")).toBeNull();

    // Old token → 401.
    const oldTokenResp = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs",
        token: shopperToken,
        body: { url: "https://amazon.com/" },
      }),
    );
    expect(oldTokenResp?.status).toBe(401);

    // (Old tabId after uninstall would 401 anyway because the token
    // is gone — verifying with mailerToken gives 404.)
    const otherToken = await handle(
      req({
        method: "POST",
        path: "/api/browser/tabs/tab-shopper-uninst/navigate",
        token: mailerToken,
        body: { url: "https://gmail.com/" },
      }),
    );
    expect(otherToken?.status).toBe(404);

    void bytesToHex; // suppress unused-import warning
  });
});
