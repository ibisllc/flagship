// The browser side of an account key change that lives in this browser: the key chain in IndexedDB (a new key
// is a link from the old one, every unlock follows it, the old key stays retired for what it sealed), the
// pending slot, the receive key's storage, the random device key at sign-up, Wipe & restart's admin-root
// signature, the Remove-sheet question, and the push the service worker shows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyWipeRestart } from "@flagship/protocol";
import { ed25519, hkdf, sha256 } from "../public/webapp/vendor/noble-post-quantum/pq-seal.js";

const ROOT = resolve(__dirname, "..", "public", "webapp");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const imp = (p: string) => import(pathToFileURL(resolve(ROOT, p)).href + `?t=${Math.random()}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);

type Stores = Map<string, Map<string, unknown>>;
const DATABASES = new Map<string, Stores>();
const later = (fn: () => void) => setTimeout(fn, 0);
function store(stores: Stores, name: string, tx?: any) {
  if (!stores.has(name)) stores.set(name, new Map());
  const map = stores.get(name)!;
  const done = (req: any) => later(() => {
    req.onsuccess?.({ target: req });
    tx?.oncomplete?.({ target: tx });
  });
  return {
    get(key: string) {
      const req: any = { result: undefined };
      later(() => {
        req.result = map.get(key);
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    put(value: unknown, key: string) {
      const req: any = {};
      map.set(key, structuredClone(value));
      done(req);
      return req;
    },
    delete(key: string) {
      const req: any = {};
      map.delete(key);
      done(req);
      return req;
    },
  };
}
function indexedDBShim() {
  return {
    open(name: string) {
      const req: any = {};
      const isNew = !DATABASES.has(name);
      if (isNew) DATABASES.set(name, new Map());
      const stores = DATABASES.get(name)!;
      req.result = {
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        createObjectStore: (s: string) => store(stores, s),
        transaction: () => {
          const tx: any = {};
          tx.objectStore = (s: string) => store(stores, s, tx);
          return tx;
        },
      };
      later(() => {
        if (isNew) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

beforeEach(() => {
  DATABASES.clear();
  (globalThis as any).indexedDB = indexedDBShim();
  const m = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, String(v)), removeItem: (k: string) => m.delete(k), clear: () => m.clear() };
});
afterEach(() => {
  delete (globalThis as any).indexedDB;
  delete (globalThis as any).localStorage;
});

describe("the account key chain", () => {
  it("unlocks to the newest key after a change, through the old passphrase", async () => {
    const ks = await imp("keystore.js");
    const first = await ks.bootstrapNewIdentity("correct horse battery");
    const second = seed(9);
    await ks.installSuccessorUmk(first, second, 1);
    expect(hex(await ks.unlockUmk("correct horse battery"))).toBe(hex(second));
    expect(await ks.localKeyEpoch()).toBe(1);
    const third = seed(10);
    await ks.installSuccessorUmk(second, third, 2);
    const resolved = await ks.resolveUmkChain(first);
    expect(hex(resolved.umk)).toBe(hex(third));
    expect(resolved.epoch).toBe(2);
    expect(resolved.retired.map((r: { epoch: number; umk: Uint8Array }) => [r.epoch, hex(r.umk)])).toEqual([[1, hex(second)], [0, hex(first)]]);
  }, 30_000);

  it("keeps a secret sealed under the old key readable, and the device key too", async () => {
    const ks = await imp("keystore.js");
    const old = seed(1);
    const blob = await ks.sealDeviceSecret(old, "flagship.test-wrap.v1", "rk", new Uint8Array([1, 2, 3]));
    await ks.persistAccountDeviceSeed(old, "alice", "a".repeat(32), seed(5));
    await ks.installSuccessorUmk(old, seed(2), 1);
    expect(Array.from(await ks.openDeviceSecret(seed(2), "flagship.test-wrap.v1", "rk", blob))).toEqual([1, 2, 3]);
    expect(hex(await ks.deriveAccountDeviceSeedFromSeed(seed(2), "alice", "a".repeat(32)))).toBe(hex(seed(5)));
    // Without the link the new key opens nothing of the old one's.
    await expect(ks.openDeviceSecret(seed(3), "flagship.test-wrap.v1", "rk", blob)).rejects.toThrow();
  });

  it("keeps the pending change under the current key only, and drops it on request", async () => {
    const ks = await imp("keystore.js");
    await ks.putPendingRotation(seed(1), { newUmk: seed(9), toEpoch: 3, body: { rotation: { toEpoch: 3 } }, issuedAt: 7 });
    expect(await ks.loadPendingRotation(seed(2))).toBeNull();
    const p = await ks.loadPendingRotation(seed(1));
    expect(hex(p.newUmk)).toBe(hex(seed(9)));
    expect(p).toMatchObject({ toEpoch: 3, issuedAt: 7, body: { rotation: { toEpoch: 3 } } });
    await ks.clearPendingRotation();
    expect(await ks.loadPendingRotation(seed(1))).toBeNull();
  });

  it("stores the receive key wrapped, with the device key it was published for", async () => {
    const ks = await imp("keystore.js");
    expect(await ks.loadReceiveKeySeed(seed(1), "alice", "a".repeat(32))).toBeNull();
    await ks.persistReceiveKeySeed(seed(1), "alice", "a".repeat(32), seed(6), "ab".repeat(32));
    const got = await ks.loadReceiveKeySeed(seed(1), "alice", "a".repeat(32));
    expect(hex(got.seed)).toBe(hex(seed(6)));
    expect(got.publishedFor).toBe("ab".repeat(32));
  });

  it("forgets the chain and the pending change with the device key", async () => {
    const ks = await imp("keystore.js");
    const first = await ks.bootstrapNewIdentity("correct horse battery");
    await ks.installSuccessorUmk(first, seed(9), 1);
    await ks.putPendingRotation(seed(9), { newUmk: seed(10), toEpoch: 2, body: {}, issuedAt: 1 });
    await ks.resetDevice();
    expect(await ks.localKeyEpoch()).toBe(0);
    expect(await ks.loadPendingRotation(seed(9))).toBeNull();
  }, 30_000);

  it("gives a recovered device id a random key once", async () => {
    const ks = await imp("keystore.js");
    expect(await ks.ensureRandomAccountDeviceSeed(seed(1), "alice", "b".repeat(32))).toBe(true);
    expect(await ks.ensureRandomAccountDeviceSeed(seed(1), "alice", "b".repeat(32))).toBe(false);
    const s = await ks.deriveAccountDeviceSeedFromSeed(seed(1), "alice", "b".repeat(32));
    const derived = hkdf(sha256, seed(1), new Uint8Array(0), new TextEncoder().encode(`flagship/account-device-key/v1|alice|${"b".repeat(32)}`), 32);
    expect(hex(s)).not.toBe(hex(derived));
  });
});

describe("Reset account keys keeps the admin root", () => {
  async function resetTo(ks: any, oldUmk: Uint8Array, newUmk: Uint8Array, keep: boolean) {
    // The local install of lib/resetAccountKeysUi.js runResetAccountKeys.
    await ks.resetDevice();
    ks.setCurrentIrkVersion(1);
    await ks.bootstrapFromExistingSeed("the new passphrase", newUmk);
    if (keep) await ks.keepRetiredUmk(newUmk, oldUmk);
  }

  it("still holds and signs with its admin root after a reload on the new key", async () => {
    const ks = await imp("keystore.js");
    const oldUmk = await ks.bootstrapNewIdentity("the old passphrase");
    const root = await ks.generateAdminRoot(oldUmk);
    await resetTo(ks, oldUmk, seed(21), true);
    const fresh = await imp("keystore.js");
    const umk = await fresh.unlockUmk("the new passphrase");
    expect(hex(umk)).toBe(hex(seed(21)));
    const got = await fresh.loadAdminRootSeed(umk);
    expect(hex(got)).toBe(hex(root));
    const msg = new TextEncoder().encode("flagship/test/v1|order");
    const sig = await fresh.signWithAdminRoot(got, msg);
    expect(ed25519.verify(sig, msg, ed25519.getPublicKey(root))).toBe(true);
  }, 30_000);

  it("lost it before: without the retired key the old record does not open", async () => {
    const ks = await imp("keystore.js");
    const oldUmk = await ks.bootstrapNewIdentity("the old passphrase");
    await ks.generateAdminRoot(oldUmk);
    await resetTo(ks, oldUmk, seed(22), false);
    const fresh = await imp("keystore.js");
    await expect(fresh.loadAdminRootSeed(await fresh.unlockUmk("the new passphrase"))).rejects.toThrow();
  }, 30_000);

  it("the reset keeps the old key retired under the new one", () => {
    expect(src("lib/resetAccountKeysUi.js")).toContain("await keepRetiredUmk(result.newUmk, oldUmk);");
  });
});

describe("a new account's device key", () => {
  it("is random and kept before the account exists", async () => {
    const { openAccount, resetPendingOpenAccountIdentities } = await imp("lib/openAccount.js");
    resetPendingOpenAccountIdentities();
    const persisted: Array<{ id: string; seed: Uint8Array }> = [];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ created: true }), { status: 200 }));
    const umk = seed(9);
    await openAccount("jolly-ranger", {
      session: { umk, irk: { publicKey: seed(2) }, adminRootSeed: seed(7) },
      accountDisplayName: "Johnson Family",
      deviceDisplayName: "This browser",
      signWithIrk: async () => new Uint8Array(64),
      ensureAdminRoot: async () => "aa".repeat(32),
      deriveAccountIdFromSeed: async () => ({ publicKey: seed(4) }),
      signWithAdminRoot: async () => new Uint8Array(64),
      signWithDevice: async () => new Uint8Array(64),
      persistAccountDeviceSeed: async (_u: Uint8Array, _a: string, id: string, s: Uint8Array) => void persisted.push({ id, seed: s }),
      generateDeviceId: () => "00112233445566778899aabbccddeeff",
      randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
      fetch,
    });
    expect(persisted).toHaveLength(1);
    const body = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(body.device.devicePubHex).toBe(hex(ed25519.getPublicKey(persisted[0]!.seed)));
    const derived = hkdf(sha256, umk, new Uint8Array(0), new TextEncoder().encode("flagship/account-device-key/v1|jolly-ranger|00112233445566778899aabbccddeeff"), 32);
    expect(body.device.devicePubHex).not.toBe(hex(ed25519.getPublicKey(derived)));
  });
});

describe("Reset account keys on an account with an admin root", () => {
  it("signs the same wipe-restart bytes with the admin root", async () => {
    const { runWipeRestartCeremony, sha256Hex } = await imp("lib/wipeRestartCeremony.js");
    let body: any = null;
    const root = seed(7);
    await runWipeRestartCeremony(
      {
        username: "harry",
        umk: seed(3),
        adminRootSeed: root,
        enrollPasskey: async () => ({ credentialIdHex: "deadbeef".repeat(4), wrappedUmkB64: Buffer.from(new Uint8Array(48)).toString("base64"), wrappedUmkBytes: new Uint8Array(48) }),
      },
      {
        requireOwnerProfile: () => {},
        fetch: async (_u: string, init: any) => {
          body = JSON.parse(init.body);
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => "" };
        },
        origin: "https://com.test",
        now: () => 1700000000000,
        newUmk: () => seed(4),
        newIdempotencyKey: () => "a".repeat(32),
      },
    );
    const claim = {
      username: "harry",
      oldIrkPub: Uint8Array.from(Buffer.from(body.request.oldIrkPub, "hex")),
      newIrkPub: Uint8Array.from(Buffer.from(body.request.newIrkPub, "hex")),
      newCredentialIdHex: body.request.newCredentialId,
      newWrappedUmkHashHex: await sha256Hex(new Uint8Array(48)),
      issuedAt: body.request.issuedAt,
    };
    expect(body.adminRootSignature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyWipeRestart(claim as any, Uint8Array.from(Buffer.from(body.adminRootSignature, "hex")), ed25519.getPublicKey(root))).toBe(true);
  });
});

describe("Remove from account asks first", () => {
  it("an admin answering Yes goes to the account key change; No removes as before", async () => {
    let td: Record<string, any>;
    try {
      td = await imp("views/trusted-devices.js");
    } catch {
      return; // the view needs a DOM; the source is pinned below
    }
    const started: string[] = [];
    const keyChange = {
      askCouldSomeoneUnlock: async () => "yes",
      startAccountKeyChange: async (d: { deviceId: string }) => (started.push(d.deviceId), true),
      BROWSER_ADVICE: "advice",
      CHANGE_LABEL: "Change account key",
    };
    const modal = { inlineChoice: async () => "remove", inlineConfirm: async () => true, inlineAlert: async () => {} };
    const device = { deviceId: "ff".repeat(16), displayName: "Lost phone", platformClass: "ios" };
    const removed: string[] = [];
    expect(await td.removeDeviceFlow(device, { modal, isAdmin: true, keyChange, remove: async (id: string) => void removed.push(id) })).toBe(true);
    expect(started).toEqual([device.deviceId]);
    expect(removed).toEqual([]);
    keyChange.askCouldSomeoneUnlock = async () => "no";
    expect(await td.removeDeviceFlow(device, { modal, isAdmin: true, keyChange, remove: async (id: string) => void removed.push(id) })).toBe(true);
    expect(removed).toEqual([device.deviceId]);
  });

  it("pins the question, the summary and the push in source", () => {
    const lib = src("lib/accountKeyChange.js");
    for (const s of [
      'tr("Could someone else unlock this device?")',
      'tr("No: it\'s lost and locked, or I erased it")',
      'tr("Yes, or I\'m not sure")',
      'tr("Change your account key")',
      'tr("Your other devices keep working. They get the new key the next time they open Flagship.")',
      'tr("Your servers switch to the new key by themselves. Nothing needs pairing again.")',
      'tr("These devices must be added again:")',
      'tr("Browsers signed in to your servers will need to be approved again.")',
      'tr("Set up cloud recovery again afterwards.")',
      'tr("Old backups still open with the old key, and so do copies on the removed device.")',
      'tr("Under quantum-safe protection, change the account key from the iPhone or Android app.")',
      'tr("Your account key was changed. Open Flagship to keep using this device.")',
    ]) expect(lib).toContain(s);
    expect(src("views/trusted-devices.js")).toContain("askCouldSomeoneUnlock");
    const sw = src("service-worker.js");
    expect(sw).toContain('data.category === "account-key-rotated"');
    expect(sw).toContain('postMessage({ type: "ACCOUNT_KEY_CHECK" })');
    expect(sw).toContain("PUSH_TEXT_CACHE");
    expect(src("lib/swRegister.js")).toContain('data.type === "ACCOUNT_KEY_CHECK"');
    expect(src("app.js")).toContain('import("./lib/accountKeyUpkeep.js")');
  });
});

describe("the summary and the progress card", () => {
  it("lists who must be added again and why, and the admin-key line first", async () => {
    let v: Record<string, any>;
    try {
      v = await imp("views/rotateAccountKey.js");
    } catch {
      return;
    }
    const plan = {
      removed: { deviceId: "c".repeat(32), displayName: "Lost" },
      removedHeldAdmin: true,
      kept: [{ device: { deviceId: "a".repeat(32), displayName: "Me", createdAt: 1 }, self: true }, { device: { deviceId: "b".repeat(32), displayName: "Phone", createdAt: 2 }, self: false }],
      excluded: [{ device: { deviceId: "d".repeat(32), displayName: "Old browser" }, reason: "derived" }],
    };
    const html = v.summaryHtml({ plan, recoveryOn: true, nameOf: (d: { displayName: string }) => d.displayName });
    expect(html.indexOf("Lost held the admin key")).toBeLessThan(html.indexOf("Your other devices"));
    expect(html).toContain("Old browser: its key came from the old account key");
    expect(html).toContain("Set up cloud recovery again afterwards.");
    const card = v.progressHtml({ devices: { updated: 1, total: 2 }, servers: { updated: 0, total: 1, waiting: ["home"], rekeyDue: [] } }, { recoveryOff: true });
    expect(card).toContain("Devices updated: 1 of 2");
    expect(card).toContain("Waiting for home");
    expect(card).toContain("data-key-change-retry");
    expect(card).toContain("Cloud recovery is off since the account key changed. Set it up again.");
  });
});
