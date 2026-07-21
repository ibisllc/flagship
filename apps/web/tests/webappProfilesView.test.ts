// P12 — Profiles view (apps/web/public/webapp/views/profiles.js).
//
// Surface contract:
//   1. Empty state → "Set one up" button routes to view-bootstrap.
//   2. Non-empty state → one row per cloud, ACTIVE pill on the selected one.
//   3. Clicking a non-active row's Switch button:
//      - swaps the active cloudName in lib/profiles.js (legacy v1 pointer);
//      - swaps the active cloudName in lib/profilesStore.js (v2 store);
//      - invokes the registered profile-switch handler (host re-render hook);
//      - re-renders the rows so the new active cloud carries the ACTIVE pill.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k) { return map.get(k) ?? null; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k) { map.delete(k); },
    setItem(k, v) { map.set(k, String(v)); },
  } as Storage;
}

/** Minimal DOM the view uses. We mount the section + content holes the view
 *  reads via `$("profiles-content")`. */
function installDom() {
  // Install HTMLElement BEFORE we mint any element so `instanceof HTMLElement`
  // works inside the view's click handler.
  class HTMLElementStub {}
  (globalThis as any).HTMLElement = HTMLElementStub;
  const elements = new Map<string, any>();
  const document = {
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement(tag: string) { return makeEl(tag, document); },
  };
  function makeEl(tag: string, doc: any): any {
    const el: any = Object.create(HTMLElementStub.prototype);
    Object.assign(el, {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      innerHTML: "",
      textContent: "",
      attrs: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      children: [] as any[],
      listeners: {} as Record<string, Array<(e: any) => void>>,
      ownerDocument: doc,
      appendChild(c: any) { this.children.push(c); return c; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      addEventListener(k: string, fn: (e: any) => void) {
        (this.listeners[k] = this.listeners[k] || []).push(fn);
      },
      removeEventListener() { /* noop */ },
      __qsaCache: new Map<string, any[]>(),
      // Minimal querySelectorAll — only used to find `[data-action="switch"]`.
      // Cached by selector + last-seen innerHTML, so a re-query against the
      // SAME rendered HTML returns the same button instances (preserving the
      // click listeners the production view attached). A different innerHTML
      // invalidates the cache.
      querySelectorAll(sel: string) {
        const cacheKey = `${sel}::${this.innerHTML}`;
        if (this.__qsaCache.has(cacheKey)) return this.__qsaCache.get(cacheKey)!;
        const m = /\[data-action="([^"]+)"\]/.exec(sel);
        if (!m) { this.__qsaCache.set(cacheKey, []); return []; }
        const html = String(this.innerHTML);
        const out: any[] = [];
        const buttonRe = /<button[^>]*data-action="([^"]+)"[^>]*data-cloud="([^"]+)"[^>]*>([^<]*)<\/button>/g;
        let mm;
        while ((mm = buttonRe.exec(html))) {
          if (mm[1] === m[1]) {
            const btn: any = makeEl("button", doc);
            btn.setAttribute("data-action", mm[1]);
            btn.setAttribute("data-cloud", mm[2]);
            btn.textContent = mm[3];
            out.push(btn);
          }
        }
        this.__qsaCache.set(cacheKey, out);
        (this as any).__queriedSwitches = out;
        return out;
      },
    });
    return el;
  }

  // Pre-create the slots the view + init expect.
  elements.set("profiles-content", makeEl("div", document));
  elements.set("profiles-back", makeEl("button", document));
  elements.set("profiles-refresh", makeEl("button", document));
  elements.set("profiles-set-up", makeEl("button", document));

  (globalThis as any).document = document;
  return { elements };
}

async function loadModules() {
  const base = resolve(__dirname, "..", "public", "webapp");
  const tag = Math.random();
  // Cache-bust each module — they read globals like document/localStorage that
  // are set in beforeEach, so a fresh import every test keeps state isolated.
  const profilesView = await import(pathToFileURL(resolve(base, "views/profiles.js")).href + `?t=${tag}`);
  const profilesLib = await import(pathToFileURL(resolve(base, "lib/profiles.js")).href + `?t=${tag}`);
  const store = await import(pathToFileURL(resolve(base, "lib/profilesStore.js")).href + `?t=${tag}`);
  return { profilesView, profilesLib, store };
}

describe("webapp Profiles view (P12)", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    (globalThis as any).localStorage = storage;
    installDom();
    // The view uses `lib/router.js` which exposes show(). Pin a tiny stub via
    // module cache by writing a fake history we can inspect.
    (globalThis as any).__shown__ = [];
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).document;
    delete (globalThis as any).HTMLElement;
    delete (globalThis as any).__shown__;
  });

  it("empty state renders the 'Set one up' card", async () => {
    const { profilesView } = await loadModules();
    profilesView.renderProfiles();
    const root = (globalThis as any).document.getElementById("profiles-content");
    expect(root.innerHTML).toContain("No profiles yet");
    expect(root.innerHTML).toContain("Set one up");
  });

  it("renders one row per profile + ACTIVE pill on the selected one", async () => {
    const { profilesView, profilesLib, store } = await loadModules();
    profilesLib.addProfile({ cloudName: "alice", accountId: "alice", deviceId: "11".repeat(16) }, { storage });
    profilesLib.addProfile({ cloudName: "bob", accountId: "bob", deviceId: "22".repeat(16) }, { storage, setActive: false });
    store.ensureProfile("alice", storage);
    store.ensureProfile("bob", storage);
    store.setActiveCloudName("alice", storage);

    profilesView.renderProfiles();
    const root = (globalThis as any).document.getElementById("profiles-content");
    expect(root.innerHTML).toContain("alice");
    expect(root.innerHTML).toContain("bob");
    // ACTIVE pill is rendered for the active cloud only.
    expect(root.innerHTML.indexOf("ACTIVE")).toBeGreaterThan(-1);
    // Switch button only on the non-active row.
    expect(root.innerHTML).toMatch(/data-action="switch"[^>]*data-cloud="bob"/);
    expect(root.innerHTML).not.toMatch(/data-action="switch"[^>]*data-cloud="alice"/);
  });

  it("clicking Switch flips active cloud in BOTH profiles.js and profilesStore.js", async () => {
    const { profilesView, profilesLib, store } = await loadModules();
    profilesLib.addProfile({ cloudName: "alice" }, { storage });
    profilesLib.addProfile({ cloudName: "bob" }, { storage, setActive: false });
    store.ensureProfile("alice", storage);
    store.ensureProfile("bob", storage);
    store.setActiveCloudName("alice", storage);

    let handlerCalls = 0;
    profilesView.setProfileSwitchHandler(() => { handlerCalls += 1; });

    profilesView.renderProfiles();
    const root = (globalThis as any).document.getElementById("profiles-content");
    const switches = root.querySelectorAll('[data-action="switch"]');
    expect(switches).toHaveLength(1);
    const bobBtn = switches[0];
    expect(bobBtn.getAttribute("data-cloud")).toBe("bob");

    // Fire the registered click listener via the same path the view wires it.
    // The view's render call queried switches lazily from innerHTML — replay
    // the click by calling its handler directly. To do that, we attach a
    // listener-driven approach: the view registered listeners on the buttons
    // returned by querySelectorAll. We saved them in __queriedSwitches.
    const queried = (root as any).__queriedSwitches as any[];
    expect(queried).toHaveLength(1);
    // The view added a click listener to each queried switch button.
    const listeners = queried[0].listeners["click"] ?? [];
    expect(listeners).toHaveLength(1);
    await listeners[0]({ currentTarget: queried[0] });

    // Active flipped in both stores.
    expect(profilesLib.loadProfiles(storage).activeCloudName).toBe("bob");
    expect(store.getActiveCloudName(storage)).toBe("bob");
    expect(handlerCalls).toBe(1);
  });

  it("persists the choice across loads (re-rendering picks up the new active cloud)", async () => {
    const { profilesView, profilesLib, store } = await loadModules();
    profilesLib.addProfile({ cloudName: "alice" }, { storage });
    profilesLib.addProfile({ cloudName: "bob" }, { storage, setActive: false });
    store.ensureProfile("alice", storage);
    store.ensureProfile("bob", storage);
    store.setActiveCloudName("alice", storage);

    profilesView.renderProfiles();
    const root = (globalThis as any).document.getElementById("profiles-content");
    const queried = (root as any).__queriedSwitches as any[];
    await queried[0].listeners["click"][0]({ currentTarget: queried[0] });

    // Simulate a fresh boot — re-render from persisted storage.
    profilesView.renderProfiles();
    const root2 = (globalThis as any).document.getElementById("profiles-content");
    // ACTIVE pill now sits on bob; Switch button now sits on alice.
    expect(root2.innerHTML).toMatch(/profiles-row-active[\s\S]*?bob/);
    expect(root2.innerHTML).toMatch(/data-action="switch"[^>]*data-cloud="alice"/);
  });

  it("module exports the surfaces app.js wires (initProfilesView / enterProfiles / setProfileSwitchHandler)", async () => {
    const { profilesView } = await loadModules();
    expect(typeof profilesView.initProfilesView).toBe("function");
    expect(typeof profilesView.enterProfiles).toBe("function");
    expect(typeof profilesView.renderProfiles).toBe("function");
    expect(typeof profilesView.setProfileSwitchHandler).toBe("function");
  });
});
