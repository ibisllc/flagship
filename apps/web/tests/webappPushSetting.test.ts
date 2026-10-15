// The "Push notifications" switch on the webapp (docs/ai-privacy-and-staging.md
// §3a, "Turning alerts off"): on by default, stored on the device; off drops
// this browser's push registration and tells every box to send no alerts (and
// no access sheet shows); on registers again; boxes are corrected on start and
// on each return to the foreground; a generic push's click checks requests.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { buildServer } from "../src/server.js";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

const storage = new MemStorage();
const docListeners = new Map<string, (() => void)[]>();
const winListeners = new Map<string, (() => void)[]>();
const g = globalThis as Record<string, unknown>;

beforeAll(() => {
  g.localStorage = storage;
  g.document = {
    visibilityState: "visible",
    addEventListener: (t: string, cb: () => void) => void (docListeners.get(t) ?? docListeners.set(t, []).get(t)!).push(cb),
  };
  g.window = { addEventListener: (t: string, cb: () => void) => void (winListeners.get(t) ?? winListeners.set(t, []).get(t)!).push(cb) };
});
afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadSetting = () => load("lib/pushSetting.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const PATH = "/api/screens/settings/access-alerts";

/** A fake box: GET returns its value (or 404 when `old`), POST stores it. */
function fakeBox(id: string, opts: { enabled?: boolean; old?: boolean; down?: boolean } = {}) {
  const box = {
    id,
    enabled: opts.enabled ?? true,
    calls: [] as string[],
    async fetch(path: string, init: { method?: string; body?: string } = {}) {
      const m = init.method ?? "GET";
      box.calls.push(`${m} ${path}`);
      if (opts.down) throw Object.assign(new Error("offline"), { status: 0 });
      if (opts.old) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      if (m === "POST") {
        box.enabled = JSON.parse(init.body!).enabled;
        return { ok: true, enabled: box.enabled };
      }
      return { enabled: box.enabled };
    },
  };
  return box;
}

describe("the switch", () => {
  it("is on by default and remembers off and on", async () => {
    const { pushNotificationsEnabled, setPushNotificationsEnabled, PUSH_SETTING_TITLE, PUSH_SETTING_NOTE } = await loadSetting();
    expect(pushNotificationsEnabled(storage)).toBe(true);
    setPushNotificationsEnabled(false, storage);
    expect(pushNotificationsEnabled(storage)).toBe(false);
    setPushNotificationsEnabled(true, storage);
    expect(pushNotificationsEnabled(storage)).toBe(true);
    expect(pushNotificationsEnabled({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
    expect(PUSH_SETTING_TITLE).toBe("Push notifications");
    expect(PUSH_SETTING_NOTE).toBe(
      "When this is off, nothing from Flagship is pushed to this device, so Apple and Google never see when your servers need you. You'll have to open Flagship to approve unlocks and see requests.",
    );
  });

  it("off revokes this browser's registration and writes enabled:false to every box; on registers again", async () => {
    const { applyPushSetting, pushNotificationsEnabled } = await loadSetting();
    const a = fakeBox("home.harry.flagship.services");
    const b = fakeBox("work.harry.flagship.services");
    const old = fakeBox("old.harry.flagship.services", { old: true });
    const down = fakeBox("down.harry.flagship.services", { down: true });
    const subscribe = vi.fn(async () => ({ tokenId: "t" }));
    const unsubscribe = vi.fn(async () => {});
    const off = await applyPushSetting(false, { storage, boxes: () => [a, b, old, down], subscribe, unsubscribe });
    expect(pushNotificationsEnabled(storage)).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
    expect([a.enabled, b.enabled]).toEqual([false, false]);
    expect(off.written.sort()).toEqual([a.id, b.id].sort());
    expect(off.skipped).toEqual([old.id]);
    expect(off.failed).toEqual([down.id]);
    expect(off.pushError).toBeNull();

    const on = await applyPushSetting(true, {
      storage,
      boxes: () => [a, b],
      subscribe: async () => {
        throw new Error("notification permission: denied");
      },
      unsubscribe,
    });
    expect(pushNotificationsEnabled(storage)).toBe(true);
    expect([a.enabled, b.enabled]).toEqual([true, true]);
    expect(on.pushError?.message).toBe("notification permission: denied");
  });

  it("on start, each box is read and corrected only where it disagrees; older boxes are skipped", async () => {
    const { startPushSettingSync, setPushNotificationsEnabled } = await loadSetting();
    setPushNotificationsEnabled(false, storage);
    const agrees = fakeBox("a.harry.flagship.services", { enabled: false });
    const differs = fakeBox("b.harry.flagship.services", { enabled: true });
    const old = fakeBox("c.harry.flagship.services", { old: true });
    const unsubscribe = vi.fn(async () => {});
    const target = { document: { visibilityState: "visible", addEventListener: () => {} }, addEventListener: () => {} };
    const { sync } = startPushSettingSync({
      isActive: () => true,
      unsubscribe,
      storage,
      boxes: () => [agrees, differs, old],
      hasRegistration: () => true,
      target,
    });
    const r = await sync({ force: true });
    expect(agrees.calls).toEqual([`GET ${PATH}`]);
    expect(differs.calls).toEqual([`GET ${PATH}`, `POST ${PATH}`]);
    expect(differs.enabled).toBe(false);
    expect(r.written).toEqual([differs.id]);
    expect(r.skipped).toEqual([old.id]);
    // Off with a registration still on file: it is revoked.
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("the foreground resync is throttled and waits for the unlock", async () => {
    const { startPushSettingSync } = await loadSetting();
    const box = fakeBox("a.harry.flagship.services", { enabled: false });
    let unlocked = false;
    let t = 1_000_000;
    const listeners: Record<string, () => void> = {};
    const target = {
      document: { visibilityState: "visible", addEventListener: (k: string, cb: () => void) => void (listeners[k] = cb) },
      addEventListener: (k: string, cb: () => void) => void (listeners[`win:${k}`] = cb),
    };
    const { sync } = startPushSettingSync({
      isActive: () => unlocked,
      storage,
      boxes: () => [box],
      hasRegistration: () => false,
      now: () => t,
      target,
    });
    await new Promise((r) => setImmediate(r));
    expect(box.calls).toEqual([]);
    unlocked = true;
    listeners["flagship:view-shown"]!();
    await new Promise((r) => setImmediate(r));
    expect(box.calls).toEqual([`GET ${PATH}`, `POST ${PATH}`]);
    expect(box.enabled).toBe(true);
    await sync();
    expect(box.calls).toHaveLength(2);
    t += 61_000;
    listeners.visibilitychange!();
    await new Promise((r) => setImmediate(r));
    expect(box.calls).toHaveLength(3);
  });

  it("the managed boxes are every paired pod plus the legacy active pod, and none on a companion", async () => {
    const { managedBoxes } = await loadSetting();
    const ps = await load("lib/profilesStore.js");
    ps.ensureProfile("harry", storage);
    ps.setActiveCloudName("harry", storage);
    ps.setSessionTokenFor("home.harry.flagship.services", "tok-home", { storage });
    ps.setSessionTokenFor("work.harry.flagship.services", "tok-work", { storage });
    ps.set("podBaseUrl", "https://legacy.harry.flagship.services", { storage });
    ps.set("sessionToken", "tok-legacy", { storage });
    const seen: Array<{ url: string; tok: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers: Record<string, string> }) => {
      seen.push({ url, tok: init.headers["x-flagship-session"]!, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true, enabled: false }), { status: 200 });
    });
    const boxes = managedBoxes();
    expect(boxes.map((b: { id: string }) => b.id).sort()).toEqual([
      "home.harry.flagship.services",
      "legacy.harry.flagship.services",
      "work.harry.flagship.services",
    ]);
    const { writeAccessAlertsToBoxes } = await loadSetting();
    await writeAccessAlertsToBoxes(false, boxes);
    expect(seen.map((s) => `${s.method} ${s.url} ${s.tok}`).sort()).toEqual([
      `POST https://home.harry.flagship.services${PATH} tok-home`,
      `POST https://legacy.harry.flagship.services${PATH} tok-legacy`,
      `POST https://work.harry.flagship.services${PATH} tok-work`,
    ]);
    ps.set("kind", "companion", { storage });
    expect(managedBoxes()).toEqual([]);
  });
});

describe("no access sheets with the switch off", () => {
  it("the alert controller never fetches requests while off, and does once on", async () => {
    const { setPushNotificationsEnabled } = await loadSetting();
    const ps = await load("lib/profilesStore.js");
    const { getSession } = await load("lib/state.js");
    ps.ensureProfile("harry", storage);
    ps.setActiveCloudName("harry", storage);
    ps.set("podBaseUrl", "https://home.harry.flagship.services", { storage });
    ps.set("sessionToken", "tok", { storage });
    getSession().umk = new Uint8Array(32).fill(1);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ requests: [] }), { status: 200 });
    });
    vi.stubGlobal("WebSocket", undefined);
    setPushNotificationsEnabled(false, storage);
    const { startAccessAlerts } = await load("lib/accessAlerts.js");
    const alerts = startAccessAlerts({ isUnlocked: () => true });
    await alerts.controller.check({ force: true });
    expect(urls).toEqual([]);
    setPushNotificationsEnabled(true, storage);
    await alerts.controller.check({ force: true });
    expect(urls).toEqual(["https://home.harry.flagship.services/api/screens/access-requests"]);
    getSession().umk = null;
  });
});

describe("a generic push checks the box's access requests", () => {
  function sandbox(clients: { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }[] = []) {
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const shown: { title: string; opts: { body: string; data: { kind: string } } }[] = [];
    const opened: string[] = [];
    const self = {
      location: { origin: "https://webapp.flagshipserver.com" },
      addEventListener: (t: string, cb: (ev: unknown) => void) => { (listeners.get(t) ?? listeners.set(t, []).get(t)!).push(cb); },
      registration: { showNotification: async (title: string, opts: never) => { shown.push({ title, opts }); } },
      clients: { matchAll: async () => clients, openWindow: async (u: string) => { opened.push(u); } },
    };
    const src = readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8");
    vm.runInNewContext(src, { self, caches: {}, fetch: async () => ({}), URL, Response: class {}, Headers: class {}, console, Date });
    const fire = async (t: string, ev: object) => {
      const waits: Promise<unknown>[] = [];
      for (const cb of listeners.get(t) ?? []) cb({ ...ev, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { fire, shown, opened };
  }

  it("an empty or generic push shows the generic text, and its click asks the open webapp to check", async () => {
    for (const data of [null, { json: () => ({ category: "generic" }) }]) {
      const posted: unknown[] = [];
      const tab = { url: "https://webapp.flagshipserver.com/", focus: async () => {}, postMessage: (m: unknown) => posted.push(m) };
      const h = sandbox([tab]);
      await h.fire("push", { data });
      expect(h.shown).toHaveLength(1);
      expect(h.shown[0]!.opts.data.kind).toBe("generic");
      await h.fire("notificationclick", { notification: { close: () => {}, data: h.shown[0]!.opts.data } });
      expect(posted).toEqual([{ type: "ACCESS_REQUESTS" }]);
    }
  });
});

describe("the shell wires it", () => {
  it("settings has the switch with its text, app.js syncs it, the shell precaches it", async () => {
    const html = await asset("/webapp/index.html");
    expect(html).toContain('id="push-switch"');
    expect(html).toContain("Push notifications");
    expect(html).toContain("so Apple and Google never see when your servers need you");
    const app = await asset("/webapp/app.js");
    expect(app).toContain("startPushSettingSync({");
    const alerts = await asset("/webapp/lib/accessAlerts.js");
    expect(alerts).toContain("pushNotificationsEnabled()");
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/pushSetting.js"');
    expect(sw).toContain('SHELL_VERSION = "v120"');
  });
});
