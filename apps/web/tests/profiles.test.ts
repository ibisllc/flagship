// W3 — webapp multi-profile state. Mirrors iOS MultiProfileTests +
// Android MultiProfileTest. Persists under a single versioned key in
// localStorage. The dropdown helper exposes a minimal listbox the
// chrome can mount; tests assert that clicking a non-active row
// switches the active cloud and re-renders.

import { describe, expect, it, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Dynamic import so we exercise the EXACT JS we ship to browsers.
async function loadProfilesLib() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "profiles.js");
  return import(pathToFileURL(path).href);
}

/** Minimal `Storage`-shaped in-memory adapter. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() { map.clear(); },
    getItem(k) { return map.get(k) ?? null; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k) { map.delete(k); },
    setItem(k, v) { map.set(k, String(v)); },
  } as Storage;
}

/** Minimal DOM shim — just the element APIs the dropdown helper uses. */
function makeDoc() {
  type El = {
    tagName: string;
    children: El[];
    attrs: Record<string, string>;
    dataset: Record<string, string>;
    classList: { add: (c: string) => void };
    className: string;
    textContent: string;
    innerHTML: string;
    type?: string;
    listeners: Record<string, Array<() => void>>;
    ownerDocument: { createElement: (t: string) => El };
    appendChild(c: El): El;
    setAttribute(k: string, v: string): void;
    addEventListener(k: string, f: () => void): void;
    click(): void;
  };
  function createElement(tag: string): El {
    const el: any = {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      classList: { add: (c: string) => { el.className = (el.className + " " + c).trim(); } },
      className: "",
      textContent: "",
      innerHTML: "",
      listeners: {},
      appendChild(c: any) { this.children.push(c); return c; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      addEventListener(k: string, f: () => void) {
        (this.listeners[k] = this.listeners[k] || []).push(f);
      },
      click() { (this.listeners["click"] || []).forEach((f) => f()); },
    };
    el.ownerDocument = { createElement };
    return el;
  }
  return { createElement };
}

describe("webapp profiles (W3 multi-cloud)", () => {
  let storage: Storage;
  beforeEach(() => { storage = memoryStorage(); });

  it("loadProfiles returns empty state for fresh storage", async () => {
    const lib = await loadProfilesLib();
    const state = lib.loadProfiles(storage);
    expect(state.profiles).toEqual([]);
    expect(state.activeCloudName).toBeNull();
  });

  it("addProfile + setActiveProfile round-trips through localStorage", async () => {
    const lib = await loadProfilesLib();
    lib.addProfile({ cloudName: "harry", cloudRootPubHex: "abc" }, { storage });
    lib.addProfile({ cloudName: "jay-family", deviceLabel: "browser" }, { storage, setActive: false });
    const state = lib.loadProfiles(storage);
    expect(state.profiles.map((p: any) => p.cloudName)).toEqual(["harry", "jay-family"]);
    expect(state.activeCloudName).toBe("harry");

    lib.setActiveProfile("jay-family", storage);
    const after = lib.loadProfiles(storage);
    expect(after.activeCloudName).toBe("jay-family");
    expect(lib.getActiveProfile(storage)?.cloudName).toBe("jay-family");
  });

  it("addProfile replaces an existing entry by cloudName (no duplicate)", async () => {
    const lib = await loadProfilesLib();
    lib.addProfile({ cloudName: "harry" }, { storage });
    lib.addProfile({ cloudName: "harry", deviceLabel: "phone" }, { storage });
    const state = lib.loadProfiles(storage);
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].deviceLabel).toBe("phone");
  });

  it("setActiveProfile ignores unknown cloudName", async () => {
    const lib = await loadProfilesLib();
    lib.addProfile({ cloudName: "harry" }, { storage });
    lib.setActiveProfile("does-not-exist", storage);
    expect(lib.loadProfiles(storage).activeCloudName).toBe("harry");
  });

  it("dropdown lists every profile and clicking switches active", async () => {
    const lib = await loadProfilesLib();
    lib.addProfile({ cloudName: "harry" }, { storage });
    lib.addProfile({ cloudName: "jay-family" }, { storage, setActive: false });

    const doc = makeDoc();
    const container = (doc as any).createElement("div");
    let changeCount = 0;
    const root = lib.renderProfilesDropdown(container, {
      storage,
      onChange: () => { changeCount += 1; },
    });

    // Container holds the dropdown root.
    expect((container as any).children).toContain(root);

    // Find the non-active option (jay-family) and click it.
    const list = (root as any).children.find((c: any) => c.tagName === "UL");
    expect(list).toBeTruthy();
    const items = (list as any).children;
    expect(items.map((i: any) => i.textContent)).toEqual(["harry", "jay-family"]);
    const harryItem = items.find((i: any) => i.dataset.cloudName === "harry");
    const jayItem = items.find((i: any) => i.dataset.cloudName === "jay-family");
    // harry is active → no click listener wired.
    expect(harryItem.attrs["aria-current"]).toBe("true");
    expect(harryItem.listeners["click"]).toBeUndefined();
    // jay-family is NOT active → clicking flips the active profile.
    jayItem.click();
    expect(lib.loadProfiles(storage).activeCloudName).toBe("jay-family");
    expect(changeCount).toBe(1);
  });

  it("corrupt JSON in storage degrades to an empty state (no crash)", async () => {
    const lib = await loadProfilesLib();
    storage.setItem(lib.KEY, "{not valid json");
    const state = lib.loadProfiles(storage);
    expect(state.profiles).toEqual([]);
    expect(state.activeCloudName).toBeNull();
  });
});
