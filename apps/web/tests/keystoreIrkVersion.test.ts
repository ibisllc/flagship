// B3 — keystore.currentIrkVersion / setCurrentIrkVersion go through
// profilesStore for NAMED profiles, closing the P12 hard-cut-over
// carve-out. The DEFAULT profile keeps the legacy direct-read path
// (the legacy flat key has no cloudName under which profilesStore
// could index it).
//
// Coverage:
//   - default profile: reads + writes hit `flagship.irk.version`
//     directly (unchanged from pre-B3).
//   - named profile: writes go through profilesStore; reads come back
//     from profilesStore as the canonical source.
//   - named-profile write does NOT clobber the default profile's
//     legacy key (the auto-mirror trap).
//   - pre-B3 legacy suffix key (`flagship.irk.version.<profileId>`)
//     migrates one-shot on first read into profilesStore.
//   - profile A's write doesn't leak into profile B's read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadStore() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "profilesStore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

describe("keystore.currentIrkVersion — B3 routes named profiles through profilesStore", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
    (globalThis as { localStorage: Storage }).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("default profile: write + read round-trip through the legacy flat key", async () => {
    const ks = await loadKeystore();
    ks.setCurrentIrkVersion(7, ks.DEFAULT_PROFILE_ID);
    expect(storage.getItem("flagship.irk.version")).toBe("7");
    expect(ks.currentIrkVersion(ks.DEFAULT_PROFILE_ID)).toBe(7);
  });

  it("named profile: write goes through profilesStore (per-profile slot)", async () => {
    const ks = await loadKeystore();
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    ks.setCurrentIrkVersion(4, "alice");
    expect(s.get("currentIrkVersion", { storage, cloudName: "alice" })).toBe("4");
    expect(ks.currentIrkVersion("alice")).toBe(4);
  });

  it("named-profile write does NOT clobber the default profile's legacy key", async () => {
    // Pre-B3 bug would have been: write to a named profile auto-mirrors
    // to `flagship.irk.version` (the SLOT_FIELDS legacy key, which is
    // the DEFAULT profile's key). B3's `mirror:false` suppresses that.
    const ks = await loadKeystore();
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    // Plant a default-profile value first.
    ks.setCurrentIrkVersion(2, ks.DEFAULT_PROFILE_ID);
    expect(storage.getItem("flagship.irk.version")).toBe("2");
    // Now write a different version under a named profile.
    ks.setCurrentIrkVersion(9, "alice");
    // Default profile's flat key MUST still be 2.
    expect(storage.getItem("flagship.irk.version")).toBe("2");
    expect(ks.currentIrkVersion(ks.DEFAULT_PROFILE_ID)).toBe(2);
    // And alice's slot is 9.
    expect(ks.currentIrkVersion("alice")).toBe(9);
  });

  it("pre-B3 legacy suffix key migrates one-shot on first read", async () => {
    // Simulate a pre-B3 named-profile install: `flagship.irk.version.alice`
    // is set directly; profilesStore knows nothing.
    storage.setItem("flagship.irk.version.alice", "5");
    const ks = await loadKeystore();
    const s = await loadStore();
    expect(s.get("currentIrkVersion", { storage, cloudName: "alice" })).toBeNull();
    // First read returns the legacy value AND migrates it.
    expect(ks.currentIrkVersion("alice")).toBe(5);
    expect(s.get("currentIrkVersion", { storage, cloudName: "alice" })).toBe("5");
    // Second read comes from profilesStore (no need to re-touch legacy).
    storage.removeItem("flagship.irk.version.alice");
    expect(ks.currentIrkVersion("alice")).toBe(5);
  });

  it("setCurrentIrkVersion mirrors to the per-profile suffix key for backward-compat", async () => {
    // Old webapp tabs read the suffix key directly. The mirror keeps
    // them in sync until the tab refreshes onto the new code.
    const ks = await loadKeystore();
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    ks.setCurrentIrkVersion(6, "alice");
    expect(storage.getItem("flagship.irk.version.alice")).toBe("6");
  });

  it("profile A's write doesn't leak into profile B's read", async () => {
    const ks = await loadKeystore();
    const s = await loadStore();
    s.ensureProfile("alice", storage);
    s.ensureProfile("bob", storage);
    ks.setCurrentIrkVersion(3, "alice");
    ks.setCurrentIrkVersion(8, "bob");
    expect(ks.currentIrkVersion("alice")).toBe(3);
    expect(ks.currentIrkVersion("bob")).toBe(8);
  });

  it("no localStorage available → defaults to 1 (no crash)", async () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const ks = await loadKeystore();
    expect(ks.currentIrkVersion("alice")).toBe(1);
    expect(() => ks.setCurrentIrkVersion(2, "alice")).not.toThrow();
  });

  it("invalid version throws on set (input validation preserved)", async () => {
    const ks = await loadKeystore();
    expect(() => ks.setCurrentIrkVersion(0, "alice")).toThrow();
    expect(() => ks.setCurrentIrkVersion(-1, "alice")).toThrow();
    expect(() => ks.setCurrentIrkVersion(1.5, "alice")).toThrow();
  });
});
