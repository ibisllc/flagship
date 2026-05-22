// Phase 3b — cross-device QR pairing CLIENT (webapp).
//
// docs/login-and-account-redesign.md §"Cross-device sets" + "Safeguards"
// + "Multi-profile integration". The business-adding-collaborators case:
// a multi-device account spanning ecosystems, where iCloud can't carry
// the credential, so keys move out-of-band via a pairing QR.
//
// Pins the webapp side end-to-end:
//   ADMIN     builds + signs a valid DeviceAdmit (verifies under the
//             protocol's verifyDeviceAdmit — wire-compatible), and seals
//             { umkSeed, admit, admitSig } over the relay.
//   INCOMING  verifies the admit under the account IRK pub, persists the
//             UMK under a NEW profile (an EXISTING profile is untouched),
//             registers push + POSTs /devices/admit, surfaces quarantine.
//   /join     parsing (the webapp-router hook).
//
// The pure orchestrators take injected collaborators; the "persists under
// a new profile" property runs against the REAL keystore behind an
// in-memory IndexedDB shim (mirrors webappKeystoreMultiProfile.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveIRK,
  signDeviceAdmit,
  verifyDeviceAdmit,
  type DeviceAdmit,
} from "@flagship/protocol";

/* ---------- in-memory IndexedDB + localStorage shims ---------- */

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

/* ---------- module loaders (exercise the shipped JS) ---------- */

async function loadPairing() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "crossDevicePairing.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}
async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PASS = "correct-horse-battery-staple";

/* ─────────────────────────────────────────────────────────────────────
 * /join link — build + parse (the webapp-router hook).
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — /join link build + parse", () => {
  it("buildJoinLink emits the universal /join link with sid + pk", async () => {
    const { buildJoinLink } = await loadPairing();
    const link = buildJoinLink({ sid: "abc", pkB64u: "PK_b64u" });
    expect(link).toBe("https://flagshipserver.com/join?sid=abc&pk=PK_b64u");
  });

  it("parseJoinLink reads a full /join URL", async () => {
    const { parseJoinLink } = await loadPairing();
    expect(parseJoinLink("https://flagshipserver.com/join?sid=S1&pk=K1")).toEqual({ sid: "S1", pk: "K1" });
  });

  it("parseJoinLink reads the flagship:// deep-link form", async () => {
    const { parseJoinLink } = await loadPairing();
    expect(parseJoinLink("flagship://join?sid=S2&pk=K2")).toEqual({ sid: "S2", pk: "K2" });
  });

  it("parseJoinLink reads a bare sid=&pk= query fragment", async () => {
    const { parseJoinLink } = await loadPairing();
    expect(parseJoinLink("sid=S3&pk=K3")).toEqual({ sid: "S3", pk: "K3" });
    expect(parseJoinLink("?sid=S4&pk=K4")).toEqual({ sid: "S4", pk: "K4" });
  });

  it("parseJoinLink returns null for non-join input / missing params", async () => {
    const { parseJoinLink } = await loadPairing();
    expect(parseJoinLink("")).toBeNull();
    expect(parseJoinLink("https://flagshipserver.com/")).toBeNull();
    expect(parseJoinLink("sid=onlySid")).toBeNull();
    expect(parseJoinLink("hello world")).toBeNull();
  });

  it("joinLinkFromLocation only fires on the /join path", async () => {
    const { joinLinkFromLocation } = await loadPairing();
    expect(joinLinkFromLocation({ pathname: "/join", search: "?sid=S5&pk=K5" }))
      .toEqual({ sid: "S5", pk: "K5" });
    // A stray ?sid= on some OTHER path must NOT hijack the boot.
    expect(joinLinkFromLocation({ pathname: "/", search: "?sid=S6&pk=K6" })).toBeNull();
    expect(joinLinkFromLocation({ pathname: "/join", search: "" })).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Device-admit envelope — build + sign (admin) is wire-compatible with
 * the protocol, and verifyAdmit accepts a protocol-signed admit.
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — DeviceAdmit canonical bytes (protocol interop)", () => {
  it("deviceAdmitCanonicalBytes matches flagship/device-admit/v1|u|pub|issuedAt", async () => {
    const { deviceAdmitCanonicalBytes, TAG_DEVICE_ADMIT } = await loadPairing();
    const admit = { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1000 };
    const bytes = deviceAdmitCanonicalBytes(admit);
    const str = new TextDecoder().decode(bytes);
    expect(str).toBe(`${TAG_DEVICE_ADMIT}|harry|${"ab".repeat(32)}|1000`);
    expect(TAG_DEVICE_ADMIT).toBe("flagship/device-admit/v1");
  });

  it("buildDeviceAdmit lowercases + validates the device pubkey", async () => {
    const { buildDeviceAdmit } = await loadPairing();
    const admit = buildDeviceAdmit({ username: "harry", newDevicePubHex: "AB".repeat(32), issuedAt: 5 });
    expect(admit.newDevicePubHex).toBe("ab".repeat(32));
    expect(() => buildDeviceAdmit({ username: "harry", newDevicePubHex: "zz", issuedAt: 5 }))
      .toThrow(/32 bytes hex/);
  });

  it("ADMIN signAdmit produces a signature the PROTOCOL's verifyDeviceAdmit accepts", async () => {
    const k = await loadKeystore();
    const { signAdmit, buildDeviceAdmit } = await loadPairing();

    // The admin's account UMK seed → IRK (deriveIRK == webapp deriveIrkFromSeed).
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7) & 0xff;
    const accountIrk = deriveIRK({ seed });

    // The incoming device's fresh pubkey.
    const devicePub = "cd".repeat(32);
    const admit = buildDeviceAdmit({ username: "hilton", newDevicePubHex: devicePub, issuedAt: 4242 });

    const admitSigHex = await signAdmit({
      admit,
      seed,
      signWithIrk: (s: Uint8Array, bytes: Uint8Array) => k.signWithIrk(s, bytes),
      bytesToHex: k.bytesToHex,
    });

    // The Worker verifies via the PROTOCOL's verifyDeviceAdmit under the
    // registered IRK pub — so the webapp's signature MUST be accepted there.
    const ok = verifyDeviceAdmit(
      admit as DeviceAdmit,
      fromHex(admitSigHex),
      accountIrk.publicKey,
    );
    expect(ok).toBe(true);

    // A tampered admit (different device) must FAIL under the same sig.
    const tampered = { ...admit, newDevicePubHex: "ef".repeat(32) };
    expect(verifyDeviceAdmit(tampered as DeviceAdmit, fromHex(admitSigHex), accountIrk.publicKey)).toBe(false);
  });

  it("INCOMING verifyAdmit accepts a PROTOCOL-signed admit (and rejects a bad one)", async () => {
    const k = await loadKeystore();
    const { verifyAdmit, buildDeviceAdmit } = await loadPairing();

    const seed = new Uint8Array(32).fill(9);
    const accountIrk = deriveIRK({ seed });
    const admit = buildDeviceAdmit({ username: "harry", newDevicePubHex: "11".repeat(32), issuedAt: 1 });
    const sig = signDeviceAdmit(admit as DeviceAdmit, accountIrk);

    const good = await verifyAdmit({
      admit,
      admitSigHex: toHex(sig),
      irkPubHex: toHex(accountIrk.publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      hexToBytes: k.hexToBytes,
    });
    expect(good).toBe(true);

    // Wrong account key → reject.
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(8) });
    const bad = await verifyAdmit({
      admit,
      admitSigHex: toHex(sig),
      irkPubHex: toHex(otherIrk.publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      hexToBytes: k.hexToBytes,
    });
    expect(bad).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * ADMIN orchestrator — vouch + seal { umkSeed, admit, admitSig }.
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — runAdminAddDevice (vouch + seal)", () => {
  function fakeRelay() {
    const calls: any = {};
    return {
      calls,
      relay: {
        open: vi.fn(async () => ({ sid: "SID1", pkB64u: "ADMINPK" })),
        onSas: vi.fn(),
        awaitConfirm: vi.fn(async () => true),
        receivePeerPub: vi.fn(async () => "ab".repeat(32)),
        seal: vi.fn(async (bytes: Uint8Array) => { calls.sealed = bytes; }),
        close: vi.fn(),
      },
    };
  }

  it("builds + signs the admit for the peer pubkey, seals the bundle, surfaces the join link", async () => {
    const k = await loadKeystore();
    const { runAdminAddDevice } = await loadPairing();
    const { relay, calls } = fakeRelay();
    const seed = new Uint8Array(32).fill(0x42);
    let joinLink: string | null = null;

    const out = await runAdminAddDevice({
      username: "harry",
      seed,
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      bytesToHex: k.bytesToHex,
      relay,
      onJoinLink: (l: string) => { joinLink = l; },
      now: () => 7000,
    });

    expect(out.outcome).toBe("sealed");
    expect(joinLink).toBe("https://flagshipserver.com/join?sid=SID1&pk=ADMINPK");
    expect(out.admit).toEqual({ username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 7000 });

    // The sealed plaintext is { umkSeedHex, admit, admitSig } and the seed
    // is the admin's account UMK.
    const bundle = JSON.parse(new TextDecoder().decode(calls.sealed));
    expect(bundle.umkSeedHex).toBe(toHex(seed));
    expect(bundle.admit).toEqual(out.admit);
    expect(bundle.admitSig).toBe(out.admitSigHex);

    // The admit signature verifies under the account IRK (protocol).
    const accountIrk = deriveIRK({ seed });
    expect(verifyDeviceAdmit(out.admit as DeviceAdmit, fromHex(out.admitSigHex), accountIrk.publicKey)).toBe(true);
    expect(relay.close).toHaveBeenCalled();
  });

  it("cancelling the SAS confirm aborts before any vouch (no seal)", async () => {
    const k = await loadKeystore();
    const { runAdminAddDevice } = await loadPairing();
    const { relay } = fakeRelay();
    relay.awaitConfirm = vi.fn(async () => false);

    const out = await runAdminAddDevice({
      username: "harry",
      seed: new Uint8Array(32).fill(1),
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      bytesToHex: k.bytesToHex,
      relay,
    });
    expect(out.outcome).toBe("cancelled");
    expect(relay.receivePeerPub).not.toHaveBeenCalled();
    expect(relay.seal).not.toHaveBeenCalled();
  });

  it("rejects when the admin seed is unavailable / malformed", async () => {
    const { runAdminAddDevice } = await loadPairing();
    await expect(runAdminAddDevice({ username: "harry", seed: new Uint8Array(16) } as any))
      .rejects.toThrow(/seed unavailable/);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Sealed-bundle parsing + quarantine surface.
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — parseSealedBundle + quarantineTimeline", () => {
  it("parses a well-formed bundle to { seed, admit, admitSigHex }", async () => {
    const { parseSealedBundle } = await loadPairing();
    const seedHex = "55".repeat(32);
    const bundle = JSON.stringify({
      umkSeedHex: seedHex,
      admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
      admitSig: "cc".repeat(64),
    });
    const out = parseSealedBundle(bundle);
    expect(toHex(out.seed)).toBe(seedHex);
    expect(out.admit.username).toBe("harry");
    expect(out.admitSigHex).toBe("cc".repeat(64));
  });

  it("rejects a malformed bundle", async () => {
    const { parseSealedBundle } = await loadPairing();
    expect(() => parseSealedBundle("not json")).toThrow();
    expect(() => parseSealedBundle(JSON.stringify({ admit: {} }))).toThrow(/missing fields/);
    expect(() => parseSealedBundle(JSON.stringify({ umkSeedHex: "xy", admit: {}, admitSig: "z" })))
      .toThrow(/umkSeed/);
  });

  it("quarantineTimeline surfaces a 14-day-style countdown", async () => {
    const { quarantineTimeline } = await loadPairing();
    const until = 1_000_000 + 14 * 86_400_000;
    const t = quarantineTimeline({ quarantineUntil: until }, 1_000_000);
    expect(t.quarantined).toBe(true);
    expect(t.remainingMs).toBe(14 * 86_400_000);
    expect(t.label).toMatch(/under review for 14d/);
    // Elapsed window → not quarantined.
    const past = quarantineTimeline({ quarantineUntil: 10 }, 1_000_000);
    expect(past.quarantined).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * INCOMING orchestrator — verify + persist under a NEW profile.
 * The keystore + IndexedDB are REAL here (in-memory shim) so the
 * "existing profile untouched" property is proven, not mocked.
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — runIncomingJoin (verify + persist under NEW profile)", () => {
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as any).indexedDB;
    delete (globalThis as any).localStorage;
  });

  it("verifies the admit, persists the UMK under a NEW profile, leaves the EXISTING one untouched", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin, buildDeviceAdmit } = await loadPairing();

    // Pre-existing profile A in this same browser.
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");

    // The collaborator account "harry" — its UMK is what the admin seals.
    const harrySeed = new Uint8Array(32).fill(0x21);
    const harryIrk = deriveIRK({ seed: harrySeed });

    // The incoming device's fresh device key (independent Ed25519). Its pub
    // is what the admin bound in the admit.
    const deviceSeed = new Uint8Array(32).fill(0x99);
    const deviceIrk = await k.deriveIrkFromSeed(deviceSeed);
    const deviceIrkPubHex = k.bytesToHex(deviceIrk.publicKey);

    // The admin's vouch (signed by harry's account IRK).
    const admit = buildDeviceAdmit({ username: "harry", newDevicePubHex: deviceIrkPubHex, issuedAt: 100 });
    const admitSig = signDeviceAdmit(admit as DeviceAdmit, harryIrk);
    const bundle = JSON.stringify({
      umkSeedHex: k.bytesToHex(harrySeed),
      admit,
      admitSig: toHex(admitSig),
    });

    const registerPush = vi.fn(async ({ username }: any) => ({
      request: {
        username,
        platform: "webpush",
        providerToken: "{}",
        pushX25519Pub: "00".repeat(32),
        label: "Web (paired)",
        issuedAt: 100,
      },
      signatureHex: "dd".repeat(64),
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, tokenId: "tok-1", quarantineUntil: 100 + 14 * 86_400_000 }),
    );
    const addedProfiles: any[] = [];

    const out = await runIncomingJoin({
      bundlePlaintext: bundle,
      deviceIrkPubHex,
      // Resolve the account IRK pub straight from harry's seed (mirrors the
      // pubkey-cert response) instead of hitting the network.
      fetchAccountIrkPubHex: async () => k.bytesToHex(harryIrk.publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      setActiveKeystoreProfile: k.setActiveKeystoreProfile,
      persistSeedForProfile: k.persistSeedForProfile,
      unlockSession: () => {},
      registerPush,
      addProfile: (p: any) => addedProfiles.push(p),
      setUsername: () => {},
      bytesToHex: k.bytesToHex,
      hexToBytes: k.hexToBytes,
      makePassphrase: () => PASS,
      fetch: fetchMock as any,
      now: () => 100,
    });

    // Joined harry; profile added (set active).
    expect(out.username).toBe("harry");
    expect(addedProfiles).toHaveLength(1);
    expect(addedProfiles[0].cloudName).toBe("harry");

    // The UMK landed under harry's OWN record; alice's is untouched.
    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.harry")).toBe(true);
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(Array.from(await k.unlockUmk(PASS, "harry"))).toEqual(Array.from(harrySeed));
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));

    // Push registered + admit POSTed; the body carries the admit + sig.
    expect(registerPush).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/users/harry/devices/admit");
    const body = JSON.parse(init.body);
    expect(body.admit).toEqual(admit);
    expect(body.admitSig).toBe(toHex(admitSig));
    expect(body.request.username).toBe("harry");
    expect(body.signature).toBe("dd".repeat(64));

    // 14-day quarantine surfaced.
    expect(out.quarantine.quarantined).toBe(true);
    expect(out.quarantine.remainingMs).toBe(14 * 86_400_000);
  });

  it("REFUSES a bundle whose admit does NOT verify under the account key (nothing persisted)", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin, buildDeviceAdmit } = await loadPairing();

    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");

    const harrySeed = new Uint8Array(32).fill(0x21);
    const wrongIrk = deriveIRK({ seed: new Uint8Array(32).fill(0x01) });
    const deviceSeed = new Uint8Array(32).fill(0x99);
    const deviceIrkPubHex = k.bytesToHex((await k.deriveIrkFromSeed(deviceSeed)).publicKey);

    const admit = buildDeviceAdmit({ username: "harry", newDevicePubHex: deviceIrkPubHex, issuedAt: 1 });
    // Sign with the WRONG key → must fail verification under the resolved
    // account key.
    const admitSig = signDeviceAdmit(admit as DeviceAdmit, wrongIrk);
    const bundle = JSON.stringify({
      umkSeedHex: k.bytesToHex(harrySeed),
      admit,
      admitSig: toHex(admitSig),
    });

    const fetchMock = vi.fn();
    await expect(runIncomingJoin({
      bundlePlaintext: bundle,
      deviceIrkPubHex,
      // The resolved account key is harry's REAL IRK (not the wrong signer).
      fetchAccountIrkPubHex: async () => k.bytesToHex(deriveIRK({ seed: harrySeed }).publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      setActiveKeystoreProfile: k.setActiveKeystoreProfile,
      persistSeedForProfile: k.persistSeedForProfile,
      unlockSession: () => {},
      registerPush: vi.fn(),
      addProfile: vi.fn(),
      bytesToHex: k.bytesToHex,
      hexToBytes: k.hexToBytes,
      makePassphrase: () => PASS,
      fetch: fetchMock as any,
    })).rejects.toThrow(/did not verify/);

    // Nothing was persisted for harry; alice intact.
    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.harry")).toBe(false);
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REFUSES a bundle aimed at a DIFFERENT device (admit pub != this device key)", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin, buildDeviceAdmit } = await loadPairing();

    const harrySeed = new Uint8Array(32).fill(0x21);
    const harryIrk = deriveIRK({ seed: harrySeed });
    // The admit binds SOME OTHER device pubkey.
    const admit = buildDeviceAdmit({ username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 });
    const admitSig = signDeviceAdmit(admit as DeviceAdmit, harryIrk);
    const bundle = JSON.stringify({
      umkSeedHex: k.bytesToHex(harrySeed),
      admit,
      admitSig: toHex(admitSig),
    });

    // THIS device's key is different from the bound one.
    const myPub = k.bytesToHex((await k.deriveIrkFromSeed(new Uint8Array(32).fill(0x99))).publicKey);
    await expect(runIncomingJoin({
      bundlePlaintext: bundle,
      deviceIrkPubHex: myPub,
      fetchAccountIrkPubHex: async () => k.bytesToHex(harryIrk.publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      setActiveKeystoreProfile: k.setActiveKeystoreProfile,
      persistSeedForProfile: k.persistSeedForProfile,
      unlockSession: () => {},
      registerPush: vi.fn(),
      addProfile: vi.fn(),
      bytesToHex: k.bytesToHex,
      hexToBytes: k.hexToBytes,
      makePassphrase: () => PASS,
      fetch: vi.fn() as any,
    })).rejects.toThrow(/different device/);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Safeguard copy is present (Safeguards 1 + 4): every warning is non-empty
 * and unambiguous so the surfaces can render them verbatim.
 * ───────────────────────────────────────────────────────────────────── */

describe("crossDevicePairing — safeguard copy", () => {
  it("exports the admin risk, incoming risk, and no-screenshot warnings", async () => {
    const { ADMIN_RISK_WARNING, INCOMING_RISK_WARNING, NO_SCREENSHOT_WARNING } = await loadPairing();
    expect(ADMIN_RISK_WARNING).toMatch(/shares your account keys/i);
    expect(INCOMING_RISK_WARNING).toMatch(/account keys/i);
    expect(NO_SCREENSHOT_WARNING).toMatch(/screenshot/i);
  });
});
