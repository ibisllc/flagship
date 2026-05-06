import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../../src/browser/browserManager.js";
import { TabRegistry } from "../../src/browser/tabRegistry.js";
import { FakeCdpServer } from "./fakeCdpServer.js";

describe("TabRegistry", () => {
  let server: FakeCdpServer;
  let mgr: BrowserManager;
  let reg: TabRegistry;

  beforeEach(async () => {
    server = new FakeCdpServer();
    const r = await server.start();
    mgr = new BrowserManager({
      endpoint: r.endpoint,
      retryDelayMs: 50,
      maxConnectAttempts: 5,
    });
    await mgr.start();
    reg = new TabRegistry(mgr);
    reg.start();
  });
  afterEach(async () => {
    reg.stop();
    await mgr.stop();
    await server.stop();
  });

  it("assignTab maps a tab to its app", () => {
    reg.assignTab("tab-1", "alice--game1");
    expect(reg.appIdForTab("tab-1")).toBe("alice--game1");
  });

  it("appIdForTab returns null for unknown tabs (cross-tenant lookup)", () => {
    reg.assignTab("tab-1", "alice--game1");
    expect(reg.appIdForTab("tab-2")).toBeNull();
  });

  it("popup with known openerId inherits the parent's appId", async () => {
    reg.assignTab("tab-parent", "alice--game1");
    server.emitEvent("Target.targetCreated", {
      targetInfo: {
        targetId: "tab-popup",
        type: "page",
        openerId: "tab-parent",
        url: "https://example.com/popup",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.appIdForTab("tab-popup")).toBe("alice--game1");
  });

  it("descendant popup-of-popup inherits all the way back up", async () => {
    reg.assignTab("tab-parent", "alice--game1");
    server.emitEvent("Target.targetCreated", {
      targetInfo: { targetId: "popup-1", type: "page", openerId: "tab-parent" },
    });
    await new Promise((r) => setTimeout(r, 10));
    server.emitEvent("Target.targetCreated", {
      targetInfo: { targetId: "popup-2", type: "page", openerId: "popup-1" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.appIdForTab("popup-2")).toBe("alice--game1");
  });

  it("popup with unknown openerId stays unowned (daemon-internal tabs)", async () => {
    server.emitEvent("Target.targetCreated", {
      targetInfo: { targetId: "tab-orphan", type: "page", openerId: "unknown-parent" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.appIdForTab("tab-orphan")).toBeNull();
  });

  it("non-page targets (workers/iframes as separate targets) are ignored", async () => {
    reg.assignTab("tab-parent", "alice--game1");
    server.emitEvent("Target.targetCreated", {
      targetInfo: {
        targetId: "service-worker-1",
        type: "service_worker",
        openerId: "tab-parent",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.appIdForTab("service-worker-1")).toBeNull();
  });

  it("Target.targetDestroyed drops the entry", async () => {
    reg.assignTab("tab-1", "alice--game1");
    server.emitEvent("Target.targetDestroyed", { targetId: "tab-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.appIdForTab("tab-1")).toBeNull();
  });

  it("tabsForApp returns the snapshot of owned tabs", () => {
    reg.assignTab("tab-1", "alice--game1");
    reg.assignTab("tab-2", "alice--game1");
    reg.assignTab("tab-3", "alice--game2");
    const tabs = reg.tabsForApp("alice--game1").sort();
    expect(tabs).toEqual(["tab-1", "tab-2"]);
  });

  it("closeAllForApp closes every tab and forgets them", async () => {
    let closeCount = 0;
    server.on("Target.closeTarget", () => {
      closeCount++;
      return { success: true };
    });
    reg.assignTab("tab-1", "alice--game1");
    reg.assignTab("tab-2", "alice--game1");
    reg.assignTab("tab-3", "alice--game2");
    const r = await reg.closeAllForApp("alice--game1");
    expect(r.closed).toBe(2);
    expect(closeCount).toBe(2);
    expect(reg.tabsForApp("alice--game1")).toEqual([]);
    // Other app's tabs untouched.
    expect(reg.tabsForApp("alice--game2")).toEqual(["tab-3"]);
  });

  it("forgetTab clears local state without invoking the browser (used after explicit closeTab)", () => {
    reg.assignTab("tab-1", "alice--game1");
    reg.forgetTab("tab-1");
    expect(reg.appIdForTab("tab-1")).toBeNull();
  });

  it("isolation contract: appA cannot 'see' appB's tab via appIdForTab", () => {
    reg.assignTab("tab-A", "alice--game1");
    reg.assignTab("tab-B", "alice--game2");
    // appA reaches in for tab-B; null is what enforces 404 at the
    // apiHandler layer (NOT 403, to avoid leaking that tab-B exists).
    expect(reg.appIdForTab("tab-B")).toBe("alice--game2");
    // The apiHandler will compare to the calling app and reject.
    expect(reg.appIdForTab("tab-A") === "alice--game2").toBe(false);
  });

  it("start() is idempotent (double-start doesn't double-register handlers)", () => {
    reg.start();
    reg.start();
    reg.assignTab("tab-parent", "alice--game1");
    server.emitEvent("Target.targetCreated", {
      targetInfo: { targetId: "tab-popup", type: "page", openerId: "tab-parent" },
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(reg.appIdForTab("tab-popup")).toBe("alice--game1");
        resolve();
      }, 10);
    });
  });
});
