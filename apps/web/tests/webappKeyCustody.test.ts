// The browser's admin key under a passkey (lib/keyCustody.js, lib/adminSigning.js;
// docs/webapp-key-custody.md items 2, 4 and 6): a version 1 record moves under a passkey on its
// first use, every signature needs the passkey's PRF output AND the account key, the seeds are
// wiped after each action, and an admin order carries a hybrid companion once `.com` holds the
// browser's ML-DSA key for the admin root.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATABASES, makeIndexedDBShim, makeLocalStorage } from "./support/idbShim";

const ROOT = join(__dirname, "../../..");
const WASM = readFileSync(join(ROOT, "apps/web/public/webapp/vendor/mldsa-wasm/mldsa65.wasm"));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mods = {
  ks: any;
  kc: any;
  as: any;
  pb: any;
};

async function load(): Promise<Mods> {
  const mw = await import("../public/webapp/lib/mldsaWasm.js");
  mw.setMldsaWasmBytesForTests(new Uint8Array(WASM));
  return {
    ks: await import("../public/webapp/keystore.js"),
    kc: await import("../public/webapp/lib/keyCustody.js"),
    as: await import("../public/webapp/lib/adminSigning.js"),
    pb: await import("../public/webapp/lib/pqBinding.js"),
  };
}

/** A fake platform authenticator: one credential, PRF = HMAC-like digest of (secret, salt). */
function fakeAuthenticator(secret = "s1") {
  const calls = { create: 0, get: 0 };
  let mode: "ok" | "cancel" | "wrong" = "ok";
  const prf = async (salt: Uint8Array, s: string) => {
    const d = await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode(s), ...salt]));
    return new Uint8Array(d);
  };
  return {
    calls,
    set(m: typeof mode) {
      mode = m;
    },
    auth: {
      async create({ salt }: { salt: Uint8Array }) {
        calls.create++;
        if (mode === "cancel") throw Object.assign(new Error("no"), { name: "NotAllowedError" });
        return { credentialId: "cred-1", prf: await prf(salt, secret) };
      },
      async get({ credentialId, salt }: { credentialId: string; salt: Uint8Array }) {
        calls.get++;
        expect(credentialId).toBe("cred-1");
        if (mode === "cancel") throw Object.assign(new Error("no"), { name: "NotAllowedError" });
        return { prf: await prf(salt, mode === "wrong" ? "other" : secret) };
      },
    },
  };
}

const UMK = new Uint8Array(32).fill(3);
const ADMIN = new Uint8Array(32).fill(5);
const msg = new TextEncoder().encode("flagship/box-release/v1|home.alice.flagship.services|" + "ab".repeat(32) + "|1|" + "00".repeat(16));

describe("webapp key custody", () => {
  let m: Mods;
  beforeAll(async () => {
    m = await load();
  });
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
    m.kc.setCustodyBindHook(null);
  });
  afterEach(() => {
    m.kc.setCustodyAuthenticatorForTests(null);
    delete (globalThis as any).indexedDB;
    delete (globalThis as any).localStorage;
  });

  async function legacyHandle(fake = fakeAuthenticator()) {
    m.kc.setCustodyAuthenticatorForTests(fake.auth);
    await m.ks.persistAdminRootSeed(UMK, ADMIN);
    const h = await m.kc.loadAdminRootKey(() => UMK);
    return { h, fake };
  }

  it("a version 1 record gives a handle with the public key, before any passkey", async () => {
    const { h, fake } = await legacyHandle();
    expect(m.kc.isLockedKey(h)).toBe(true);
    expect(m.kc.isAdminRootKey(h)).toBe(true);
    expect(h.pubHex).toBe(await m.ks.adminRootPubHex(ADMIN));
    expect(await m.ks.adminRootPubHex(h)).toBe(h.pubHex);
    expect(h.custody).toBe("browser-passphrase");
    expect(fake.calls).toEqual({ create: 0, get: 0 });
    expect(await m.kc.adminKeyCustody()).toMatchObject({ custody: "browser-passphrase" });
  });

  it("the first signature creates the passkey, seals the record and makes the ML-DSA half", async () => {
    const { h, fake } = await legacyHandle();
    const sig = await m.ks.signWithAdminRoot(h, msg);
    expect(await m.ks.verifyWithEd25519Pub(m.ks.hexToBytes(h.pubHex), sig, msg)).toBe(true);
    expect(fake.calls.create).toBe(1);
    const rec = await m.ks.kvGet(m.ks.adminRootRecordKey());
    expect(rec).toMatchObject({ version: 2, custody: "browser-passkey", credentialId: "cred-1", adminRootPubHex: h.pubHex });
    expect(rec.mldsaPubHex).toMatch(/^[0-9a-f]{3904}$/);
    expect(JSON.stringify(rec)).not.toContain(m.ks.bytesToHex(ADMIN));
    expect(h.custody).toBe("browser-passkey");
    // The passphrase path can no longer open it.
    await expect(m.ks.loadAdminRootSeed(UMK)).rejects.toMatchObject({ code: "custody-sealed" });
    // The next signature asserts with the same passkey.
    await m.ks.signWithAdminRoot(h, msg);
    expect(fake.calls).toEqual({ create: 1, get: 1 });
  });

  it("needs both the passkey and the account key", async () => {
    const { h, fake } = await legacyHandle();
    await m.ks.signWithAdminRoot(h, msg);
    fake.set("wrong");
    await expect(m.ks.signWithAdminRoot(h, msg)).rejects.toMatchObject({ code: "custody-wrong-passkey" });
    fake.set("ok");
    const other = await m.kc.loadAdminRootKey(() => new Uint8Array(32).fill(4));
    await expect(m.ks.signWithAdminRoot(other, msg)).rejects.toMatchObject({ code: "custody-wrong-passkey" });
    const locked = await m.kc.loadAdminRootKey(() => null);
    await expect(m.ks.signWithAdminRoot(locked, msg)).rejects.toMatchObject({ code: "custody-locked" });
  });

  it("a cancelled prompt signs nothing and leaves the record as it was", async () => {
    const { h, fake } = await legacyHandle();
    fake.set("cancel");
    await expect(m.ks.signWithAdminRoot(h, msg)).rejects.toMatchObject({ code: "custody-cancelled" });
    expect((await m.ks.kvGet(m.ks.adminRootRecordKey())).version).toBe(1);
  });

  it("wipes the seeds when the action returns", async () => {
    const { h } = await legacyHandle();
    let seen: Uint8Array[] = [];
    await m.kc.withAdminRoot(h, async ({ edSeed, mldsaSeed }: { edSeed: Uint8Array; mldsaSeed: Uint8Array }) => {
      seen = [edSeed, mldsaSeed];
      expect(edSeed.some((b) => b !== 0)).toBe(true);
    });
    expect(seen.every((s) => s.every((b) => b === 0))).toBe(true);
  });

  it("binds the admin root's ML-DSA key once and signs hybrid orders after", async () => {
    const puts: any[] = [];
    m.kc.setCustodyBindHook((seeds: any) =>
      m.as.bindAdminRootPq(seeds, {
        username: "alice",
        apex: "https://flagshipserver.com",
        fetch: async (url: string, init: any) => {
          puts.push({ url, body: JSON.parse(init.body) });
          return new Response("{}", { status: 200 });
        },
      }),
    );
    const { h } = await legacyHandle();
    const first = await m.as.signAdminOrder(h, msg);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("https://flagshipserver.com/api/accounts/alice/pq-key-bindings");
    const wire = puts[0].body;
    expect(wire).toMatchObject({ role: "admin-root", subjectId: "alice", ed25519PubHex: h.pubHex, mldsaPubHex: h.mldsaPubHex });
    // Bound during this very open: the first order already carries the companion.
    expect(h.pqBound).toBe(true);
    expect(first.pqSignature).not.toBeNull();
    const binding = m.pb.verifyPqKeyBinding(wire, { role: "admin-root", subjectId: "alice", ed25519PubHex: h.pubHex, now: wire.issuedAt });
    expect(
      m.pb.verifyCriticalSignature({
        message: msg,
        expectedPurpose: "flagship/box-release/v1",
        envelope: first.pqSignature,
        signerEd25519PubHex: h.pubHex,
        binding,
        policy: { profile: "strict", rollout: "enforced" },
      }),
    ).toMatchObject({ strict: true });
    await m.as.signAdminOrder(h, msg);
    expect(puts).toHaveLength(1);
  });

  it("signs classically when another device bound the admin root first", async () => {
    m.kc.setCustodyBindHook((seeds: any) =>
      m.as.bindAdminRootPq(seeds, { username: "alice", apex: "https://x", fetch: async () => new Response(JSON.stringify({ error: "pq-key-changed" }), { status: 409 }) }),
    );
    const { h } = await legacyHandle();
    const s = await m.as.signAdminOrder(h, msg);
    expect(h.pqBound).toBe(false);
    expect(s.pqSignature).toBeNull();
    expect(await m.kc.adminKeyCustody()).toMatchObject({ custody: "browser-passkey", pqBound: false });
  });

  it("a rotated root moves under the same passkey (no second passkey)", async () => {
    const { h, fake } = await legacyHandle();
    await m.ks.signWithAdminRoot(h, msg);
    const next = new Uint8Array(32).fill(9);
    await m.ks.persistAdminRootSeed(UMK, next);
    expect((await m.ks.kvGet(m.ks.adminRootRecordKey())).credentialId).toBe("cred-1");
    const h2 = await m.kc.loadAdminRootKey(() => UMK);
    expect(h2.pubHex).toBe(await m.ks.adminRootPubHex(next));
    await m.ks.signWithAdminRoot(h2, msg);
    expect(fake.calls.create).toBe(1);
    // The old handle no longer opens the new root.
    await expect(m.ks.signWithAdminRoot(h, msg)).rejects.toMatchObject({ code: "custody-key-changed" });
  });

  it("hands a raw copy on only through exportAdminRootSeed", async () => {
    const { h } = await legacyHandle();
    const raw = await m.kc.exportAdminRootSeed(h);
    expect(Array.from(raw)).toEqual(Array.from(ADMIN));
  });
});
