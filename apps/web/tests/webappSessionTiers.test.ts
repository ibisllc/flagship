// Three-tier session model (task #46 — webapp parity with iOS 725be0f).
//
//   Tier 1 LOCK     — drop the in-memory session, re-gate the app behind
//                     the passphrase unlock screen. Removes NOTHING from
//                     IndexedDB; the wrapped UMK survives.
//   Tier 2 SIGN OUT — erase this device's local key material (resetDevice)
//                     WITHOUT a server-side revoke; gated/warned on cloud-
//                     recovery enrollment. Comes back via WebAuthn-PRF.
//   Tier 3 REMOVE   — cryptographic eviction (revoke + rotate). Lives in
//                     paired-sessions; NOT re-implemented here. The contract
//                     this file pins is that Tier 2 never calls a revoke.
//
// We exercise the real shipping module lib/sessionTiers.js (dependency-
// injected, DOM-free) and drive the Tier-2 key wipe through the real
// keystore.js against an in-memory IndexedDB shim (same shim shape as
// webappKeystoreMultiProfile.test.ts) so the "the wrapped UMK is actually
// gone" assertion is real, not mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* ---------- minimal in-memory IndexedDB shim ---------- */

type Stores = Map<string, Map<string, unknown>>;
const DATABASES = new Map<string, Stores>();

function fireAsync(fn: () => void) {
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
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        createObjectStore(storeName: string) {
          if (!stores.has(storeName)) stores.set(storeName, new Map());
          return makeStore(stores, storeName);
        },
        transaction(_storeName: string, _mode?: string) {
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
        if (isNew && typeof req.onupgradeneeded === "function") req.onupgradeneeded({ target: req });
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

async function loadTiers() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "sessionTiers.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

describe("three-tier session model — webapp (task #46)", () => {
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
  });
  afterEach(() => {
    delete (globalThis as any).indexedDB;
    vi.restoreAllMocks();
  });

  // ---- Tier 1: LOCK ----

  describe("Tier 1 — LOCK", () => {
    it("clears the in-memory session and routes to the unlock gate WITHOUT removing the key", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();

      // A device with key material present in IndexedDB.
      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      expect(await k.hasWrappedUmk()).toBe(true);

      const calls: string[] = [];
      let lockSessionCalled = false;
      let resetDeviceCalled = false;
      tiers.lock({
        lockSession: () => { lockSessionCalled = true; },
        show: (id: string) => calls.push(`show:${id}`),
        setSubtitle: (t: string) => calls.push(`subtitle:${t}`),
        stopRenewals: () => calls.push("stopRenewals"),
        // NB: lock() is not given resetDevice — it must never wipe the key.
      });

      expect(lockSessionCalled).toBe(true);
      expect(resetDeviceCalled).toBe(false);
      expect(calls).toContain("stopRenewals");
      expect(calls).toContain("show:view-unlock");
      // The load-bearing assertion: the key SURVIVES a lock.
      expect(await k.hasWrappedUmk()).toBe(true);
    });

    it("stops background renewals BEFORE dropping the session (renewer can't repopulate)", async () => {
      const tiers = await loadTiers();
      const order: string[] = [];
      tiers.lock({
        lockSession: () => order.push("lockSession"),
        show: () => order.push("show"),
        stopRenewals: () => order.push("stopRenewals"),
      });
      expect(order.indexOf("stopRenewals")).toBeLessThan(order.indexOf("lockSession"));
    });
  });

  // ---- Tier 2: SIGN OUT ----

  describe("Tier 2 — SIGN OUT", () => {
    it("erases this device's local key material (wrapped UMK gone after)", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();

      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      expect(await k.hasWrappedUmk()).toBe(true);

      await tiers.signOut({
        hasCloudRecovery: true,
        resetDevice: () => k.resetDevice(),
        lockSession: () => {},
        show: () => {},
      });

      expect(await k.hasWrappedUmk()).toBe(false);
    });

    it("does NOT call any revoke / server-mutating endpoint (fetch never hit)", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");

      const fetchSpy = vi.fn();
      (globalThis as any).fetch = fetchSpy;

      let revokeCalled = false;
      await tiers.signOut({
        hasCloudRecovery: true,
        resetDevice: () => k.resetDevice(),
        lockSession: () => {},
        // A revoke would be an injected dep; sign-out is deliberately
        // given none and must not fabricate one.
        show: () => {},
      });

      expect(revokeCalled).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      delete (globalThis as any).fetch;
    });

    it("drops the in-memory session and the per-profile session slots, then routes to bootstrap", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");

      let lockSessionCalled = false;
      const removedSlots: string[] = [];
      const shown: string[] = [];
      await tiers.signOut({
        hasCloudRecovery: true,
        resetDevice: () => k.resetDevice(),
        lockSession: () => { lockSessionCalled = true; },
        profileRemove: (slot: string) => removedSlots.push(slot),
        stopRenewals: () => {},
        show: (id: string) => shown.push(id),
        setSubtitle: () => {},
      });

      expect(lockSessionCalled).toBe(true);
      expect(removedSlots).toEqual(
        expect.arrayContaining(["sessionId", "sessionToken", "podBaseUrl", "username"]),
      );
      expect(shown).toContain("view-bootstrap");
    });

    it("wipes the key BEFORE clearing the session (no window where a session points at a wiped key… and vice-versa)", async () => {
      const tiers = await loadTiers();
      const order: string[] = [];
      await tiers.signOut({
        hasCloudRecovery: true,
        resetDevice: async () => { order.push("resetDevice"); },
        lockSession: () => order.push("lockSession"),
        show: () => order.push("show"),
      });
      expect(order.indexOf("resetDevice")).toBeLessThan(order.indexOf("lockSession"));
    });
  });

  // ---- Tier 2 gating: the #52 cloud-recovery BLOCK ----

  describe("Tier 2 — cloud-recovery gate (#52: block, not warn)", () => {
    it("signOutPolicy: enrolled ⇒ allowed; not enrolled ⇒ blocked", async () => {
      const tiers = await loadTiers();
      expect(tiers.signOutPolicy(true)).toBe("allowed");
      expect(tiers.signOutPolicy(false)).toBe("blocked-no-recovery");
    });

    it("signOutPolicy: demo sandboxes are exempt (no real key to lose)", async () => {
      const tiers = await loadTiers();
      expect(tiers.signOutPolicy(false, true)).toBe("allowed");
      expect(tiers.signOutPolicy(true, true)).toBe("allowed");
    });

    it("BLOCKED sign-out touches NOTHING — key survives, session survives, no routing", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      expect(await k.hasWrappedUmk()).toBe(true);

      let lockSessionCalled = false;
      const shown: string[] = [];
      const res = await tiers.signOut({
        hasCloudRecovery: false,
        resetDevice: () => k.resetDevice(),
        lockSession: () => { lockSessionCalled = true; },
        show: (id: string) => shown.push(id),
      });

      expect(res).toEqual({ blocked: true });
      // The load-bearing assertion: the ONLY copy of the key SURVIVES.
      expect(await k.hasWrappedUmk()).toBe(true);
      expect(lockSessionCalled).toBe(false);
      expect(shown).toEqual([]);
    });

    it("omitting hasCloudRecovery fails CLOSED (treated as not enrolled ⇒ blocked)", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");

      const res = await tiers.signOut({
        resetDevice: () => k.resetDevice(),
        lockSession: () => {},
        show: () => {},
      });

      expect(res).toEqual({ blocked: true });
      expect(await k.hasWrappedUmk()).toBe(true);
    });

    it("demo exemption: blocked-by-recovery is bypassed for a demo sandbox", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");

      const res = await tiers.signOut({
        hasCloudRecovery: false,
        isDemoAccount: true,
        resetDevice: () => k.resetDevice(),
        lockSession: () => {},
        show: () => {},
      });

      expect(res).toEqual({ blocked: false });
      expect(await k.hasWrappedUmk()).toBe(false);
    });

    it("allowed sign-out reports blocked:false", async () => {
      const tiers = await loadTiers();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      const res = await tiers.signOut({
        hasCloudRecovery: true,
        resetDevice: () => k.resetDevice(),
        lockSession: () => {},
        show: () => {},
      });
      expect(res).toEqual({ blocked: false });
    });

    it("confirm copy: enrolled ⇒ routine destructive framing (not blocked)", async () => {
      const tiers = await loadTiers();
      const copy = tiers.signOutConfirmCopy(true);
      expect(copy.title).toMatch(/lock with passkey/i);
      expect(copy.message).toMatch(/recovery passkey/i);
      expect(copy.message).not.toMatch(/lost for good|permanently/i);
      expect(copy.okLabel).toBe("Lock with passkey");
      expect(copy.blocked).toBe(false);
    });

    it("confirm copy: NOT enrolled ⇒ NO destructive proceed — the OK routes to recovery enrollment", async () => {
      const tiers = await loadTiers();
      const copy = tiers.signOutConfirmCopy(false);
      expect(copy.blocked).toBe(true);
      expect(copy.title).toMatch(/set up recovery first/i);
      expect(copy.message).toMatch(/enroll cloud recovery first/i);
      expect(copy.message).toMatch(/permanently lose access/i);
      expect(copy.okLabel).toBe("Set up recovery");
      expect(copy.okLabel).not.toMatch(/sign out/i);
      expect(copy.danger).toBe(false);
    });
  });
});
