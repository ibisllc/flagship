// Multi-profile keystore keying (docs/login-and-account-redesign.md —
// "Multi-profile integration").
//
// The webapp can hold multiple clouds (personal + family + work — see
// lib/profiles.js). Each cloud must have its OWN device key: the wrapped
// UMK is stored under a per-profile IndexedDB record key derived from the
// profile's cloudName (lowercased). A second profile's UMK must never
// clobber the first.
//
// Contract pinned here:
//   1. wrapped UMK keyed by profileId (cloudName, lowercased).
//   2. the active-profile pointer (lib/profiles.js `activeCloudName`) is
//      the source of truth the keystore reads.
//   3. backward-compat: the DEFAULT sentinel reuses the legacy `wrappedUmk`
//      record (so pre-existing installs keep working unchanged).
//   4. setActiveKeystoreProfile scopes subsequent ops to a profile.
//   5. profiles.js setActiveProfile re-points keystore reads.
//
// IndexedDB isn't available under the `node` vitest environment, so we
// install a minimal in-memory IDB shim (only the API surface keystore.js
// uses) BEFORE importing the module. The store persists across openDb()
// calls keyed by DB name, mirroring a real browser DB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* ---------- minimal in-memory IndexedDB shim ---------- */

type Stores = Map<string, Map<string, unknown>>;
const DATABASES = new Map<string, Stores>();

function fireAsync(fn: () => void) {
  // Real IDB fires request/transaction events on a future task. We must
  // defer so the caller can assign onsuccess/onupgradeneeded/oncomplete
  // handlers after open()/get()/put() return.
  setTimeout(fn, 0);
}

function makeIndexedDBShim() {
  return {
    open(name: string, _version?: number) {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
      const isNew = !DATABASES.has(name);
      if (isNew) DATABASES.set(name, new Map());
      const stores = DATABASES.get(name)!;

      const db = {
        objectStoreNames: {
          contains: (s: string) => stores.has(s),
        },
        createObjectStore(storeName: string) {
          if (!stores.has(storeName)) stores.set(storeName, new Map());
          return makeStore(stores, storeName);
        },
        transaction(storeName: string, _mode?: string) {
          const tx: any = { oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = (s: string) => {
            if (!stores.has(s)) stores.set(s, new Map());
            return makeStore(stores, s, tx);
          };
          return tx;
        },
      };
      req.result = db;

      fireAsync(() => {
        // keystore.js always opens at version 1 and creates the store in
        // onupgradeneeded the first time the DB is seen.
        if (isNew && typeof req.onupgradeneeded === "function") {
          req.onupgradeneeded({ target: req });
        }
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

function makeStore(stores: Stores, storeName: string, tx?: any) {
  if (!stores.has(storeName)) stores.set(storeName, new Map());
  const map = stores.get(storeName)!;
  return {
    get(key: string) {
      const req: any = { onsuccess: null, onerror: null, result: undefined };
      fireAsync(() => {
        req.result = map.get(key);
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
      });
      return req;
    },
    put(value: unknown, key: string) {
      const req: any = { onsuccess: null, onerror: null };
      map.set(key, value);
      fireAsync(() => {
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
        if (tx && typeof tx.oncomplete === "function") tx.oncomplete({ target: tx });
      });
      return req;
    },
    delete(key: string) {
      const req: any = { onsuccess: null, onerror: null };
      map.delete(key);
      fireAsync(() => {
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
        if (tx && typeof tx.oncomplete === "function") tx.oncomplete({ target: tx });
      });
      return req;
    },
  };
}

/* ---------- minimal localStorage shim (profiles.js source of truth) ---------- */

function makeLocalStorage(): Storage {
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
  // Cache-bust so each suite gets a fresh module (resets the in-process
  // active-profile override between tests).
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadProfiles() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "profiles.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadOpenAccount() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "openAccount.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadLoginTakeover() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "loginTakeover.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

function okJson(status = 200, body: unknown = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PASS = "correct-horse-battery-staple";

describe("webapp keystore — per-profile keying (multi-profile device keys)", () => {
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as any).indexedDB;
    delete (globalThis as any).localStorage;
  });

  it("DEFAULT profileId maps to the legacy `wrappedUmk` record (backward-compat)", async () => {
    const k = await loadKeystore();
    expect(k.DEFAULT_PROFILE_ID).toBeTruthy();
    expect(k._internal.RECORD_KEY).toBe("wrappedUmk");
    // No active profile set anywhere → the active profile is DEFAULT.
    expect(k.activeProfileId()).toBe(k.DEFAULT_PROFILE_ID);
    // DEFAULT's record key is EXACTLY the legacy single-record key.
    expect(k.wrappedUmkRecordKey(k.DEFAULT_PROFILE_ID)).toBe("wrappedUmk");
    expect(k.wrappedUmkRecordKey()).toBe("wrappedUmk");
  });

  it("profileIdFromCloudName lowercases and falls back to DEFAULT for empty", async () => {
    const k = await loadKeystore();
    expect(k.profileIdFromCloudName("Harry")).toBe("harry");
    expect(k.profileIdFromCloudName("JAY-Family")).toBe("jay-family");
    expect(k.profileIdFromCloudName("")).toBe(k.DEFAULT_PROFILE_ID);
    expect(k.profileIdFromCloudName(null as any)).toBe(k.DEFAULT_PROFILE_ID);
    expect(k.profileIdFromCloudName(undefined as any)).toBe(k.DEFAULT_PROFILE_ID);
  });

  it("non-default profiles get keyed records (`wrappedUmk.<profileId>`)", async () => {
    const k = await loadKeystore();
    expect(k.wrappedUmkRecordKey("harry")).toBe("wrappedUmk.harry");
    expect(k.wrappedUmkRecordKey("jay-family")).toBe("wrappedUmk.jay-family");
    // DEFAULT stays the legacy bare key.
    expect(k.wrappedUmkRecordKey(k.DEFAULT_PROFILE_ID)).toBe("wrappedUmk");
  });

  it("the legacy default record IS the same row the legacy single-profile path wrote", async () => {
    const k = await loadKeystore();
    // Legacy single-profile bootstrap (no profiles, no override) → DEFAULT.
    const seed = await k.bootstrapNewIdentity(PASS);
    expect(seed).toBeInstanceOf(Uint8Array);
    // It landed under the legacy bare `wrappedUmk` key — the exact row
    // recovery.js export/import reads.
    expect(DATABASES.get("flagship-webapp")!.get("keystore")!.has("wrappedUmk")).toBe(true);
    // And it unlocks back to the same seed via the DEFAULT path.
    const out = await k.unlockUmk(PASS);
    expect(Array.from(out)).toEqual(Array.from(seed));
  });

  it("two profiles each store a DISTINCT wrapped UMK (B doesn't clobber A)", async () => {
    const k = await loadKeystore();

    // Profile A.
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");

    // Profile B — adding B must not touch A's record.
    k.setActiveKeystoreProfile("bob");
    const seedB = await k.bootstrapNewIdentity(PASS, "bob");

    expect(Array.from(seedA)).not.toEqual(Array.from(seedB));

    // Both records exist, under distinct keys.
    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(store.has("wrappedUmk.bob")).toBe(true);

    // A still unlocks to seedA after B was added.
    k.setActiveKeystoreProfile("alice");
    expect(Array.from(await k.unlockUmk(PASS))).toEqual(Array.from(seedA));
    // B unlocks to seedB.
    k.setActiveKeystoreProfile("bob");
    expect(Array.from(await k.unlockUmk(PASS))).toEqual(Array.from(seedB));
  });

  it("switching the active profile changes which UMK (and thus IRK) derives", async () => {
    const k = await loadKeystore();

    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");
    k.setActiveKeystoreProfile("bob");
    const seedB = await k.bootstrapNewIdentity(PASS, "bob");

    // Active = alice → unlock gives seedA → IRK from seedA.
    k.setActiveKeystoreProfile("alice");
    const unlockedA = await k.unlockUmk(PASS);
    const irkA = await k.deriveIrkFromSeed(unlockedA);

    // Switch active → bob → unlock gives seedB → a DIFFERENT IRK.
    k.setActiveKeystoreProfile("bob");
    const unlockedB = await k.unlockUmk(PASS);
    const irkB = await k.deriveIrkFromSeed(unlockedB);

    expect(Array.from(unlockedA)).toEqual(Array.from(seedA));
    expect(Array.from(unlockedB)).toEqual(Array.from(seedB));
    expect(Array.from(irkA.publicKey)).not.toEqual(Array.from(irkB.publicKey));
    // And the versioned IRK derivations differ per profile too.
    const v2A = await k.deriveIrkVersioned(seedA, 2);
    const v2B = await k.deriveIrkVersioned(seedB, 2);
    expect(Array.from(v2A.publicKey)).not.toEqual(Array.from(v2B.publicKey));
  });

  it("hasWrappedUmk / resetDevice are scoped to the active profile", async () => {
    const k = await loadKeystore();

    k.setActiveKeystoreProfile("alice");
    await k.bootstrapNewIdentity(PASS, "alice");
    k.setActiveKeystoreProfile("bob");
    await k.bootstrapNewIdentity(PASS, "bob");

    // Reset only B.
    k.setActiveKeystoreProfile("bob");
    expect(await k.hasWrappedUmk()).toBe(true);
    await k.resetDevice();
    expect(await k.hasWrappedUmk()).toBe(false);

    // A is untouched.
    k.setActiveKeystoreProfile("alice");
    expect(await k.hasWrappedUmk()).toBe(true);
  });

  it("the keystore reads the persisted active profile (profiles.js activeCloudName)", async () => {
    const k = await loadKeystore();
    const profiles = await loadProfiles();

    // Persist two profiles; alice active.
    profiles.addProfile({ cloudName: "alice" });
    profiles.addProfile({ cloudName: "bob" }, { setActive: false });
    // addProfile set the in-process override too — clear it so we exercise
    // the localStorage source-of-truth read path explicitly.
    k.setActiveKeystoreProfile(null);

    // With no override, the keystore resolves the active profile from the
    // SAME localStorage blob profiles.js owns.
    expect(k.activeProfileId()).toBe("alice");
    expect(k.wrappedUmkRecordKey()).toBe("wrappedUmk.alice");

    // Flip active to bob in profiles.js → keystore re-points.
    profiles.setActiveProfile("bob");
    k.setActiveKeystoreProfile(null); // ignore the override addProfile/setActive sets
    expect(k.activeProfileId()).toBe("bob");
    expect(k.wrappedUmkRecordKey()).toBe("wrappedUmk.bob");
  });

  it("profiles.js setActiveProfile re-points keystore reads (shared singleton)", async () => {
    // Load BOTH from cache (no cache-bust) so they share the SAME keystore
    // singleton — exactly how the live app wires them. This proves the real
    // wiring: profiles.js imports + calls setActiveKeystoreProfile, and the
    // override it sets is observed by the very keystore the rest of the app
    // reads from.
    const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
    const ppath = resolve(__dirname, "..", "public", "webapp", "lib", "profiles.js");
    const k = await import(pathToFileURL(path).href);
    const profiles = await import(pathToFileURL(ppath).href);

    // Clear any override leaked from a prior import of the singleton.
    k.setActiveKeystoreProfile(null);

    profiles.addProfile({ cloudName: "alice" });
    profiles.addProfile({ cloudName: "bob" }, { setActive: false });
    // addProfile(alice, setActive default true) synced the keystore override
    // on the shared singleton.
    expect(k._internal.getActiveProfileOverride()).toBe("alice");
    expect(k.activeProfileId()).toBe("alice");

    // Switching in profiles.js re-points the keystore override immediately.
    profiles.setActiveProfile("bob");
    expect(k._internal.getActiveProfileOverride()).toBe("bob");
    expect(k.activeProfileId()).toBe("bob");
    expect(k.wrappedUmkRecordKey()).toBe("wrappedUmk.bob");

    // Leave the singleton clean for any other suite sharing this worker.
    k.setActiveKeystoreProfile(null);
  });

  it("persistSeedForProfile stores under the NEW profile's key without clobbering others", async () => {
    const k = await loadKeystore();

    // Existing profile A.
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");

    // A fresh session seed gets persisted under profile B via the helper —
    // it sets the active profile to B as a side effect.
    const seedB = new Uint8Array(32).fill(0x55);
    const profileId = await k.persistSeedForProfile(seedB, "Bob", PASS);
    expect(profileId).toBe("bob");
    expect(k.activeProfileId()).toBe("bob");

    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(store.has("wrappedUmk.bob")).toBe(true);

    // B unlocks to seedB; A is intact.
    expect(Array.from(await k.unlockUmk(PASS, "bob"))).toEqual(Array.from(seedB));
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));
  });

  it("setActiveKeystoreProfile(null) clears the override (back to profiles.js / DEFAULT)", async () => {
    const k = await loadKeystore();
    k.setActiveKeystoreProfile("alice");
    expect(k._internal.getActiveProfileOverride()).toBe("alice");
    k.setActiveKeystoreProfile(null);
    expect(k._internal.getActiveProfileOverride()).toBeNull();
    // No profiles persisted → DEFAULT.
    expect(k.activeProfileId()).toBe(k.DEFAULT_PROFILE_ID);
  });

  it("openAccount flow: a second account's UMK lands under ITS OWN record (A intact)", async () => {
    const k = await loadKeystore();
    const openAccount = (await loadOpenAccount()).openAccount;

    // First account: bootstrap the device key under DEFAULT (no profile
    // yet — exactly the live device-key-gen step), then open the account.
    const seedA = await k.bootstrapNewIdentity(PASS); // DEFAULT record
    await openAccount("alice", {
      session: { umk: seedA, irk: await k.deriveIrkFromSeed(seedA) },
      signWithIrk: (umk: Uint8Array, bytes: Uint8Array) => k.signWithIrk(umk, bytes),
      bytesToHex: k.bytesToHex,
      fetch: (() => okJson(200)) as any,
      persistSeedForProfile: k.persistSeedForProfile,
      makePassphrase: () => PASS,
    });
    // alice now has her own record AND is the active profile.
    expect(k.activeProfileId()).toBe("alice");
    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.alice")).toBe(true);

    // Second account in the same browser: a NEW device key, NEW session.
    // The live flow generates a fresh seed under whatever's active; here we
    // simulate a distinct second seed and open under "bob".
    const seedB = new Uint8Array(32).fill(0x77);
    await openAccount("bob", {
      session: { umk: seedB, irk: await k.deriveIrkFromSeed(seedB) },
      signWithIrk: (umk: Uint8Array, bytes: Uint8Array) => k.signWithIrk(umk, bytes),
      bytesToHex: k.bytesToHex,
      fetch: (() => okJson(200)) as any,
      persistSeedForProfile: k.persistSeedForProfile,
      makePassphrase: () => PASS,
    });
    expect(k.activeProfileId()).toBe("bob");
    expect(store.has("wrappedUmk.bob")).toBe(true);

    // Critically: A's record is untouched and unlocks to seedA; B → seedB.
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));
    expect(Array.from(await k.unlockUmk(PASS, "bob"))).toEqual(Array.from(seedB));
  });

  it("runTakeover flow: recovered seed wraps under the taken-over account's record", async () => {
    const k = await loadKeystore();
    const { runTakeover } = await loadLoginTakeover();

    // Pre-existing profile A in the same browser.
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");

    // Take over account "carol" via cloud recovery (Mock unwrap → a seed).
    const recovered = new Uint8Array(32).fill(0x33);
    const resolution = {
      username: "carol",
      kind: "single",
      recovery: { present: true },
    };
    await runTakeover(resolution, {
      recoverFromCloud: async () => recovered,
      setActiveKeystoreProfile: k.setActiveKeystoreProfile,
      bootstrapFromExistingSeed: (pass: string, seed: Uint8Array) =>
        k.bootstrapFromExistingSeed(pass, seed),
      unlockSession: () => {},
      deriveIrkFromSeed: (s: Uint8Array) => k.deriveIrkFromSeed(s),
      deriveIrkVersioned: (s: Uint8Array, v: number) => k.deriveIrkVersioned(s, v),
      signWithIrkVersioned: (s: Uint8Array, v: number, b: Uint8Array) =>
        k.signWithIrkVersioned(s, v, b),
      bytesToHex: k.bytesToHex,
      makePassphrase: () => PASS,
      fetch: (() => okJson(200, { completesAt: 1, graceMs: 1, accountType: "single" })) as any,
      now: () => 0,
    });

    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    // carol's recovered key is under her own record; alice is untouched.
    expect(store.has("wrappedUmk.carol")).toBe(true);
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(Array.from(await k.unlockUmk(PASS, "carol"))).toEqual(Array.from(recovered));
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));
  });
});
