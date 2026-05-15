import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { TabRegistry } from "../../src/browser/tabRegistry.js";
import { PhonePipe } from "../../src/browser/phonePipe.js";
import { InMemoryAlertInbox } from "../../src/alertInbox.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

describe("PhonePipe", () => {
  let server: FakeCdpServer;
  let mgr: BrowserManager;
  let registry: TabRegistry;
  let inbox: InMemoryAlertInbox;
  let pipe: PhonePipe;

  beforeEach(async () => {
    server = new FakeCdpServer();
    const r = await server.start();
    mgr = new BrowserManager({
      endpoint: r.endpoint,
      retryDelayMs: 50,
      maxConnectAttempts: 5,
    });
    await mgr.start();
    registry = new TabRegistry(mgr);
    registry.start();
    inbox = new InMemoryAlertInbox();
    let refCounter = 0;
    pipe = new PhonePipe({
      browser: mgr,
      tabRegistry: registry,
      inbox,
      nextRef: () => `ref-${++refCounter}`,
    });
    pipe.start();
  });
  afterEach(async () => {
    pipe.stop();
    registry.stop();
    await mgr.stop();
    await server.stop();
  });

  it("equipTab installs Runtime.addBinding + script (idempotent)", async () => {
    let bindings = 0;
    let onNewDocScripts = 0;
    let evals = 0;
    server.on("Runtime.addBinding", (params) => {
      const p = params as { name: string };
      if (p.name === "flagshipInputFocused") bindings++;
      return {};
    });
    server.on("Page.addScriptToEvaluateOnNewDocument", () => {
      onNewDocScripts++;
      return { identifier: "1" };
    });
    server.on("Runtime.evaluate", () => {
      evals++;
      return { result: { type: "boolean", value: true } };
    });

    await pipe.equipTab("tab-1");
    await pipe.equipTab("tab-1"); // idempotent
    expect(bindings).toBe(1);
    expect(onNewDocScripts).toBe(1);
    expect(evals).toBe(1);
  });

  it("focus event on an owned tab emits browser-input-needed and stashes the screenshot", async () => {
    await pipe.equipTab("tab-1");
    registry.assignTab("tab-1", "alice-shopper");

    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: JSON.stringify({ tabId: "tab-1", kind: "password", host: "amazon.com" }),
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(inbox.size()).toBe(1);
    const events = inbox.list();
    expect(events[0]?.alert).toMatchObject({
      kind: "browser-input-needed",
      appId: "alice-shopper",
      tabId: "tab-1",
      domain: "amazon.com",
      inputKind: "password",
      screenshotRef: "ref-1",
    });
    expect(pipe.getScreenshot("ref-1")?.toString("utf8")).toBe("fake-png-bytes");
  });

  it("focus event on an unowned tab emits no alert (daemon-internal tabs)", async () => {
    await pipe.equipTab("tab-orphan"); // not assigned to any app
    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: JSON.stringify({ tabId: "tab-orphan", kind: "password", host: "x" }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inbox.size()).toBe(0);
  });

  it("ignores non-flagship bindings", async () => {
    server.emitEvent("Runtime.bindingCalled", {
      name: "someOtherBinding",
      payload: JSON.stringify({ tabId: "tab-1", kind: "password" }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(inbox.size()).toBe(0);
  });

  it("ignores malformed payloads (parse error / wrong kind / missing tabId)", async () => {
    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: "{not json",
    });
    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: JSON.stringify({ tabId: "tab-1" }), // missing kind
    });
    server.emitEvent("Runtime.bindingCalled", {
      name: "flagshipInputFocused",
      payload: JSON.stringify({ tabId: "tab-1", kind: "exec-arbitrary" }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(inbox.size()).toBe(0);
  });

  it("requestInput (manual trigger) emits an alert + stores screenshot", async () => {
    registry.assignTab("tab-1", "alice-shopper");
    const r = await pipe.requestInput({
      tabId: "tab-1",
      inputKind: "text",
      host: "shop.example.com",
    });
    expect(r.screenshotRef).toMatch(/^ref-/);
    expect(inbox.size()).toBe(1);
    const events = inbox.list();
    expect(events[0]?.alert).toMatchObject({
      tabId: "tab-1",
      domain: "shop.example.com",
      inputKind: "text",
      screenshotRef: r.screenshotRef,
    });
  });

  it("requestInput throws if the tab isn't owned by any app", async () => {
    await expect(
      pipe.requestInput({ tabId: "tab-unknown", inputKind: "text" }),
    ).rejects.toThrow(/not owned/);
  });

  it("applyInputResponse dispatches via Input.insertText for the right tab", async () => {
    let captured: { sessionId?: string; text?: string } = {};
    server.on("Input.insertText", (params, sessionId) => {
      const p = params as { text: string };
      captured = { sessionId, text: p.text };
      return {};
    });
    registry.assignTab("tab-1", "alice-shopper");
    const { screenshotRef } = await pipe.requestInput({
      tabId: "tab-1",
      inputKind: "password",
      host: "amazon.com",
    });
    await pipe.applyInputResponse({
      tabId: "tab-1",
      inputKind: "password",
      value: "hunter2!@#",
      screenshotRef,
    });
    expect(captured.text).toBe("hunter2!@#");
    expect(pipe.pendingCount()).toBe(0);
  });

  it("applyInputResponse rejects when screenshotRef doesn't match a live alert", async () => {
    await expect(
      pipe.applyInputResponse({
        tabId: "tab-1",
        inputKind: "password",
        value: "x",
        screenshotRef: "never-issued",
      }),
    ).rejects.toThrow(/no pending input/);
  });

  it("applyInputResponse rejects when tabId in response differs from the alert", async () => {
    registry.assignTab("tab-1", "alice-shopper");
    const { screenshotRef } = await pipe.requestInput({
      tabId: "tab-1",
      inputKind: "password",
    });
    await expect(
      pipe.applyInputResponse({
        tabId: "tab-2",
        inputKind: "password",
        value: "x",
        screenshotRef,
      }),
    ).rejects.toThrow(/does not match/);
    // First-attempt drain — second try with the right tabId is also rejected.
    await expect(
      pipe.applyInputResponse({
        tabId: "tab-1",
        inputKind: "password",
        value: "x",
        screenshotRef,
      }),
    ).rejects.toThrow(/no pending input/);
  });

  it("applyInputResponse rejects when inputKind differs from the alert", async () => {
    registry.assignTab("tab-1", "alice-shopper");
    const { screenshotRef } = await pipe.requestInput({
      tabId: "tab-1",
      inputKind: "password",
    });
    await expect(
      pipe.applyInputResponse({
        tabId: "tab-1",
        inputKind: "otp",
        value: "x",
        screenshotRef,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("expired alerts return null on getScreenshot and reject on apply", async () => {
    let now = 1_000;
    const fakePipe = new PhonePipe({
      browser: mgr,
      tabRegistry: registry,
      inbox,
      ttlMs: 100,
      now: () => now,
      nextRef: () => "ref-x",
    });
    fakePipe.start();
    registry.assignTab("tab-1", "alice-shopper");
    await fakePipe.requestInput({ tabId: "tab-1", inputKind: "password" });
    expect(fakePipe.getScreenshot("ref-x")).toBeTruthy();
    now = 2_000; // way past TTL
    expect(fakePipe.getScreenshot("ref-x")).toBeNull();
    await expect(
      fakePipe.applyInputResponse({
        tabId: "tab-1",
        inputKind: "password",
        value: "x",
        screenshotRef: "ref-x",
      }),
    ).rejects.toThrow(/no pending input|expired/);
    fakePipe.stop();
  });

  it("evictExpired removes stale refs", async () => {
    let now = 1_000;
    const fakePipe = new PhonePipe({
      browser: mgr,
      tabRegistry: registry,
      inbox,
      ttlMs: 100,
      now: () => now,
      nextRef: (() => {
        let n = 0;
        return () => `ref-${++n}`;
      })(),
    });
    fakePipe.start();
    registry.assignTab("tab-1", "alice-shopper");
    await fakePipe.requestInput({ tabId: "tab-1", inputKind: "password" });
    await fakePipe.requestInput({ tabId: "tab-1", inputKind: "password" });
    expect(fakePipe.pendingCount()).toBe(2);
    now = 2_000;
    const removed = fakePipe.evictExpired();
    expect(removed).toBe(2);
    expect(fakePipe.pendingCount()).toBe(0);
    fakePipe.stop();
  });
});
