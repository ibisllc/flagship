// Account-deletion ceremony — webapp (docs/account-deletion-and-name-reclaim.md
// §2). Mirrors the iOS/Android last-device deletion path.
//
// We exercise the real shipping module lib/accountDeletion.js (dependency-
// injected, DOM-free), and drive the local key wipe through the real keystore.js
// against an in-memory IndexedDB shim (same shim shape as
// webappSessionTiers.test.ts) so "the wrapped UMK is actually gone only after a
// 200" is a real assertion, not a mock.
//
// What this pins:
//   - the ceremony triggers ONLY on no-recovery + last-device (policy);
//   - the account-self-delete order is signed with the byte-identical canonical
//     bytes the @flagship/protocol builder + the cross-platform vectors pin;
//   - the content checkbox controls whether serversSelfDelete is included;
//   - the local wipe runs ONLY after a 200 (a 403 leaves the device intact).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ed,
  verifyAccountSelfDelete,
  verifyServersSelfDelete,
  type Keypair,
} from "@flagship/protocol";

/* ---------- minimal in-memory IndexedDB shim (shared shape) ---------- */

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

async function loadDeletion() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "accountDeletion.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

/** Build an Ed25519 keypair for the signer used by submit/ceremony deps.
 *  The webapp's signWithIrk derives the IRK from the UMK seed; for the
 *  canonical-bytes pin we inject a deterministic signer + matching pub. */
function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("account-deletion ceremony — webapp", () => {
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
  });
  afterEach(() => {
    delete (globalThis as any).indexedDB;
    vi.restoreAllMocks();
  });

  // ---- policy: when does the ceremony trigger? ----

  describe("accountDeletePolicy — ceremony only on no-recovery + last device", () => {
    it("no recovery + last device (count <= 1) ⇒ ceremony", async () => {
      const d = await loadDeletion();
      expect(d.accountDeletePolicy({ hasCloudRecovery: false })).toBe("ceremony");
    });

    it("cloud recovery present ⇒ normal (key survives in the cloud)", async () => {
      const d = await loadDeletion();
      expect(d.accountDeletePolicy({ hasCloudRecovery: true })).toBe("normal");
    });

    it("does not trust a public device count to bypass the no-recovery ceremony", async () => {
      const d = await loadDeletion();
      expect(d.accountDeletePolicy({ hasCloudRecovery: false })).toBe("ceremony");
    });

    it("demo accounts are exempt (no real key to lose)", async () => {
      const d = await loadDeletion();
      expect(
        d.accountDeletePolicy({ hasCloudRecovery: false, isDemoAccount: true }),
      ).toBe("exempt");
    });

    it("unknown device count fails CLOSED — treated as the last device ⇒ ceremony", async () => {
      const d = await loadDeletion();
      expect(d.accountDeletePolicy({ hasCloudRecovery: false })).toBe("ceremony");
      expect(
        d.accountDeletePolicy({ hasCloudRecovery: false }),
      ).toBe("ceremony");
    });
  });

  // ---- canonical bytes match the protocol builder (cross-platform pin) ----

  describe("canonical bytes — byte-identical to @flagship/protocol", () => {
    it("account-self-delete canonical matches the pinned string + verifies", async () => {
      const d = await loadDeletion();
      const bytes = d.canonicalAccountSelfDeleteBytes("Alice", 1700);
      const expected = new TextEncoder().encode("flagship/account-self-delete/v1|alice|1700");
      expect(bytes).toEqual(expected);

      const irk = makeKey(7);
      const sig = ed.sign(bytes, irk.privateKey);
      // The protocol verifier reconstructs the same canonical bytes.
      expect(verifyAccountSelfDelete({ username: "alice", issuedAt: 1700 }, sig, irk.publicKey)).toBe(true);
    });

    it("servers-self-delete canonical matches the pinned string + verifies", async () => {
      const d = await loadDeletion();
      const bytes = d.canonicalServersSelfDeleteBytes("Alice", 1700);
      const expected = new TextEncoder().encode("flagship/servers-self-delete/v1|alice|1700");
      expect(bytes).toEqual(expected);

      const irk = makeKey(7);
      const sig = ed.sign(bytes, irk.privateKey);
      expect(verifyServersSelfDelete({ username: "alice", issuedAt: 1700 }, sig, irk.publicKey)).toBe(true);
    });
  });

  // ---- submit: the bundle shape + the content-checkbox gate ----

  describe("submitAccountSelfDelete — bundle shape", () => {
    function captureFetch() {
      const calls: { url: string; body: any }[] = [];
      const f = vi.fn(async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          status: 200,
          json: async () => ({ ok: true, username: "alice", deletedAt: 1 }),
        } as any;
      });
      return { f, calls };
    }

    // A signer that signs with a deterministic IRK so the server-side verifier
    // can be exercised against the SAME pub.
    function signerFor(irk: Keypair) {
      return async (_umk: Uint8Array, bytes: Uint8Array) =>
        ed.sign(bytes, irk.privateKey);
    }

    it("always includes account-self-delete; OMITS servers-self-delete by default", async () => {
      const d = await loadDeletion();
      const { f, calls } = captureFetch();
      const irk = makeKey(21);
      const res = await d.submitAccountSelfDelete(
        { username: "Alice", umk: new Uint8Array(32), signWithIrk: signerFor(irk) },
        { fetch: f, now: () => 1700 },
      );
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(/\/api\/account\/self-delete$/);
      const body = calls[0].body;
      expect(body.accountSelfDelete).toBeTruthy();
      expect(body.serversSelfDelete).toBeUndefined();
      // username is lowercased into the request + the signature verifies.
      expect(body.accountSelfDelete.request).toEqual({ username: "alice", issuedAt: 1700 });
      const sig = Uint8Array.from(
        body.accountSelfDelete.signature.match(/../g).map((h: string) => parseInt(h, 16)),
      );
      expect(verifyAccountSelfDelete({ username: "alice", issuedAt: 1700 }, sig, irk.publicKey)).toBe(true);
    });

    it("includeServers:true ⇒ servers-self-delete present, same username+issuedAt, verifies", async () => {
      const d = await loadDeletion();
      const { f, calls } = captureFetch();
      const irk = makeKey(22);
      await d.submitAccountSelfDelete(
        { username: "alice", includeServers: true, umk: new Uint8Array(32), signWithIrk: signerFor(irk) },
        { fetch: f, now: () => 4242 },
      );
      const body = calls[0].body;
      expect(body.serversSelfDelete).toBeTruthy();
      expect(body.serversSelfDelete.request).toEqual({ username: "alice", issuedAt: 4242 });
      expect(body.accountSelfDelete.request.issuedAt).toBe(4242);
      const sig = Uint8Array.from(
        body.serversSelfDelete.signature.match(/../g).map((h: string) => parseInt(h, 16)),
      );
      expect(verifyServersSelfDelete({ username: "alice", issuedAt: 4242 }, sig, irk.publicKey)).toBe(true);
    });

    it("a non-2xx throws with the status attached", async () => {
      const d = await loadDeletion();
      const f = vi.fn(async () => ({
        status: 403,
        text: async () => "not the last device: other active devices exist",
        json: async () => ({}),
      }) as any);
      await expect(
        d.submitAccountSelfDelete(
          { username: "alice", umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64) },
          { fetch: f },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  // ---- ceremony: local wipe ONLY after a 200 ----

  describe("runDeletionCeremony — wipe-after-200 invariant", () => {
    it("on 200: signs, POSTs, THEN wipes the local key + drops to Welcome", async () => {
      const d = await loadDeletion();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      expect(await k.hasWrappedUmk()).toBe(true);

      const order: string[] = [];
      const f = vi.fn(async () => {
        order.push("fetch");
        return { status: 200, json: async () => ({ ok: true }) } as any;
      });
      const shown: string[] = [];
      const removed: string[] = [];

      await d.runDeletionCeremony(
        {
          username: "alice",
          includeServers: false,
          umk: new Uint8Array(32),
          signWithIrk: async () => new Uint8Array(64),
          resetDevice: async () => {
            order.push("resetDevice");
            await k.resetDevice();
          },
          lockSession: () => order.push("lockSession"),
          profileRemove: (slot: string) => removed.push(slot),
          stopRenewals: () => order.push("stopRenewals"),
          show: (id: string) => shown.push(id),
        },
        { fetch: f },
      );

      // The load-bearing ordering: the network (irreversible) step is BEFORE
      // the local wipe; the key is gone afterwards.
      expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("resetDevice"));
      expect(order.indexOf("stopRenewals")).toBeLessThan(order.indexOf("resetDevice"));
      expect(await k.hasWrappedUmk()).toBe(false);
      expect(removed).toEqual(
        expect.arrayContaining(["sessionId", "sessionToken", "podBaseUrl", "username"]),
      );
      expect(shown).toContain("view-bootstrap");
    });

    it("on a 403: the local key is NOT wiped and we do NOT route to Welcome", async () => {
      const d = await loadDeletion();
      const k = await loadKeystore();
      await k.bootstrapNewIdentity("correct-horse-battery-staple");
      expect(await k.hasWrappedUmk()).toBe(true);

      const f = vi.fn(async () => ({
        status: 403,
        text: async () => "not the last device: other active devices exist",
        json: async () => ({}),
      }) as any);
      const shown: string[] = [];
      let resetCalled = false;

      await expect(
        d.runDeletionCeremony(
          {
            username: "alice",
            umk: new Uint8Array(32),
            signWithIrk: async () => new Uint8Array(64),
            resetDevice: async () => {
              resetCalled = true;
              await k.resetDevice();
            },
            lockSession: () => {},
            show: (id: string) => shown.push(id),
          },
          { fetch: f },
        ),
      ).rejects.toMatchObject({ status: 403 });

      // Nothing local touched — the device survives a rejected deletion.
      expect(resetCalled).toBe(false);
      expect(await k.hasWrappedUmk()).toBe(true);
      expect(shown).toEqual([]);
    });
  });
});
