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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveIRK,
  signDeviceAdmit,
  verifyDeviceAdmit,
  signDeviceCapabilityGrant,
  verifyDeviceCapabilityGrant,
  verifyDeviceSelfProfile,
  type DeviceAdmit,
  type DeviceCapabilityGrant,
} from "@flagship/protocol";

/* ---------- in-memory IndexedDB + localStorage shims ---------- */

type Stores = Map<string, Map<string, unknown>>;
const DATABASES = new Map<string, Stores>();
const DEVICE_ID = "10".repeat(16);

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
const ADMIN_SEED = new Uint8Array(32).fill(0x5a);
const GRANT_ID = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f50617283";

function protocolGrant(g: any): DeviceCapabilityGrant {
  return {
    grantId: g.grantId, username: g.username, deviceId: g.deviceId,
    devicePubKey: fromHex(g.devicePubHex), scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
  };
}

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
  it("deviceAdmitCanonicalBytes matches v2 account-scoped identity bytes", async () => {
    const { deviceAdmitCanonicalBytes, TAG_DEVICE_ADMIT } = await loadPairing();
    const admit = { username: "harry", deviceId: DEVICE_ID, newDevicePubHex: "ab".repeat(32), issuedAt: 1000 };
    const bytes = deviceAdmitCanonicalBytes(admit);
    const str = new TextDecoder().decode(bytes);
    expect(str).toBe(`${TAG_DEVICE_ADMIT}|harry|${DEVICE_ID}|${"ab".repeat(32)}|1000`);
    expect(TAG_DEVICE_ADMIT).toBe("flagship/device-admit/v2");
  });

  it("buildDeviceAdmit lowercases + validates the device pubkey", async () => {
    const { buildDeviceAdmit } = await loadPairing();
    const admit = buildDeviceAdmit({ username: "harry", deviceId: DEVICE_ID, newDevicePubHex: "AB".repeat(32), issuedAt: 5 });
    expect(admit.newDevicePubHex).toBe("ab".repeat(32));
    expect(() => buildDeviceAdmit({ username: "harry", deviceId: DEVICE_ID, newDevicePubHex: "zz", issuedAt: 5 }))
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
    const admit = buildDeviceAdmit({ username: "hilton", deviceId: DEVICE_ID, newDevicePubHex: devicePub, issuedAt: 4242 });

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
    const admit = buildDeviceAdmit({ username: "harry", deviceId: DEVICE_ID, newDevicePubHex: "11".repeat(32), issuedAt: 1 });
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
        receivePeerPub: vi.fn(async () => ({ devicePubHex: "ab".repeat(32), deviceId: DEVICE_ID })),
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
      adminRootSeed: ADMIN_SEED,
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      signWithAdminRoot: k.signWithAdminRoot,
      irkPubHex: k.bytesToHex(deriveIRK({ seed }).publicKey),
      grantId: GRANT_ID,
      bytesToHex: k.bytesToHex,
      relay,
      onJoinLink: (l: string) => { joinLink = l; },
      now: () => 7000,
    });

    expect(out.outcome).toBe("sealed");
    expect(joinLink).toBe("https://flagshipserver.com/join?sid=SID1&pk=ADMINPK");
    expect(out.admit).toEqual({ username: "harry", deviceId: DEVICE_ID, newDevicePubHex: "ab".repeat(32), issuedAt: 7000 });

    // The sealed plaintext is { umkSeedHex, admit, admitSig } and the seed
    // is the admin's account UMK.
    const bundle = JSON.parse(new TextDecoder().decode(calls.sealed));
    expect(bundle.umkSeedHex).toBe(toHex(seed));
    expect(bundle.admit).toEqual(out.admit);
    expect(bundle.admitSig).toBe(out.admitSigHex);

    // The grant: a member device (no admin scope), signed by the account key
    // so `.com`'s verifyDeviceCapabilityGrant accepts it.
    expect(bundle.irkPubHex).toBe(toHex(deriveIRK({ seed }).publicKey));
    expect(bundle.grant).toMatchObject({
      grantId: GRANT_ID, username: "harry", deviceId: DEVICE_ID, devicePubHex: "ab".repeat(32),
      scopes: ["browse", "install-service", "vibe-code", "view-directory"],
      issuedAt: 7000, expiresAt: 7000 + 90 * 86_400_000, signerRoot: "membership",
    });
    expect(verifyDeviceCapabilityGrant(
      protocolGrant(bundle.grant), fromHex(bundle.grantSignature), deriveIRK({ seed }).publicKey,
    )).toBe(true);

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
      adminRootSeed: ADMIN_SEED,
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      bytesToHex: k.bytesToHex,
      relay,
    });
    expect(out.outcome).toBe("cancelled");
    expect(relay.receivePeerPub).not.toHaveBeenCalled();
    expect(relay.seal).not.toHaveBeenCalled();
  });

  it("a device without the admin root cannot add a device (nothing opened, nothing sealed)", async () => {
    const k = await loadKeystore();
    const { runAdminAddDevice, ADD_DEVICE_ADMIN_ONLY } = await loadPairing();
    const { relay } = fakeRelay();
    await expect(runAdminAddDevice({
      username: "harry",
      seed: new Uint8Array(32).fill(1),
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      bytesToHex: k.bytesToHex,
      relay,
    })).rejects.toThrow(ADD_DEVICE_ADMIN_ONLY);
    expect(ADD_DEVICE_ADMIN_ONLY).toBe("Only an admin device of this account can add devices.");
    expect(relay.open).not.toHaveBeenCalled();
    expect(relay.seal).not.toHaveBeenCalled();
  });

  it("promoting seals an admin-root-signed grant with every scope and the admin root", async () => {
    const k = await loadKeystore();
    const { runAdminAddDevice, DEVICE_SCOPE_ORDER } = await loadPairing();
    const { relay, calls } = fakeRelay();
    const seed = new Uint8Array(32).fill(0x42);
    const out = await runAdminAddDevice({
      username: "harry", seed, adminRootSeed: ADMIN_SEED, promoteAdmin: true,
      signWithIrk: (s: Uint8Array, b: Uint8Array) => k.signWithIrk(s, b),
      signWithAdminRoot: k.signWithAdminRoot,
      irkPubHex: k.bytesToHex(deriveIRK({ seed }).publicKey),
      grantId: GRANT_ID, bytesToHex: k.bytesToHex, relay, now: () => 7000,
    });
    const bundle = JSON.parse(new TextDecoder().decode(calls.sealed));
    expect(out.promotedAdmin).toBe(true);
    expect(bundle.grant.signerRoot).toBe("admin-root");
    expect(bundle.grant.scopes).toEqual(DEVICE_SCOPE_ORDER);
    expect(bundle.wrappedAdminRoot).toBe(toHex(ADMIN_SEED));
    const adminPub = (await k.deriveAdminRootFromSeed(ADMIN_SEED)).publicKey;
    expect(verifyDeviceCapabilityGrant(
      protocolGrant(bundle.grant), fromHex(bundle.grantSignature), adminPub,
    )).toBe(true);
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
    const grant = {
      grantId: GRANT_ID, username: "harry", deviceId: DEVICE_ID, devicePubHex: "ab".repeat(32),
      scopes: ["browse"], issuedAt: 1, expiresAt: 2, signerRoot: "membership",
    };
    const bundle = JSON.stringify({
      umkSeedHex: seedHex,
      admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
      admitSig: "cc".repeat(64),
      irkPubHex: "DD".repeat(32),
      grant,
      grantSignature: "EE".repeat(64),
    });
    const out = parseSealedBundle(bundle);
    expect(toHex(out.seed)).toBe(seedHex);
    expect(out.admit.username).toBe("harry");
    expect(out.admitSigHex).toBe("cc".repeat(64));
    expect(out.grant).toEqual(grant);
    expect(out.grantSignatureHex).toBe("ee".repeat(64));
  });

  it("a bundle from an app that predates device grants says to update it", async () => {
    const { parseSealedBundle, BUNDLE_OUT_OF_DATE } = await loadPairing();
    const old = JSON.stringify({
      umkSeedHex: "55".repeat(32),
      admit: { username: "harry", newDevicePubHex: "ab".repeat(32), issuedAt: 1 },
      admitSig: "cc".repeat(64),
    });
    expect(() => parseSealedBundle(old)).toThrow(BUNDLE_OUT_OF_DATE);
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

  const HARRY_SEED = new Uint8Array(32).fill(0x21);
  const DEVICE_SEED = new Uint8Array(32).fill(0x99);

  /** What an admin device seals, built with the PROTOCOL's signers (wire
   *  interop), and the deps the join view hands runIncomingJoin. */
  async function fixture(k: any, opts: {
    promote?: boolean; passphrase?: string | undefined; badGrantSigner?: boolean;
    grantDevicePubHex?: string; admitPubHex?: string; admitSigner?: any;
  } = {}) {
    const harryIrk = deriveIRK({ seed: HARRY_SEED });
    const devicePubHex = k.bytesToHex((await k.deriveAdminRootFromSeed(DEVICE_SEED)).publicKey);
    const admit = {
      username: "harry", deviceId: DEVICE_ID, newDevicePubHex: opts.admitPubHex ?? devicePubHex, issuedAt: 100,
    };
    const promote = opts.promote === true;
    const grant = {
      grantId: GRANT_ID, username: "harry", deviceId: DEVICE_ID,
      devicePubHex: opts.grantDevicePubHex ?? devicePubHex,
      scopes: promote
        ? ["browse", "install-service", "vibe-code", "add-device", "manage-services", "revoke-others", "demo-provision", "admin", "view-directory"]
        : ["browse", "install-service", "vibe-code", "view-directory"],
      issuedAt: 100, expiresAt: 100 + 90 * 86_400_000,
      signerRoot: promote ? "admin-root" : "membership",
    };
    const adminKp = await k.deriveAdminRootFromSeed(ADMIN_SEED);
    const grantSigner = opts.badGrantSigner
      ? deriveIRK({ seed: new Uint8Array(32).fill(0x03) })
      : promote
        ? { privateKey: ADMIN_SEED, publicKey: adminKp.publicKey }
        : harryIrk;
    const bundle = JSON.stringify({
      umkSeedHex: k.bytesToHex(HARRY_SEED),
      admit,
      admitSig: toHex(signDeviceAdmit(admit as DeviceAdmit, opts.admitSigner ?? harryIrk)),
      irkPubHex: k.bytesToHex(harryIrk.publicKey),
      grant,
      grantSignature: toHex(signDeviceCapabilityGrant(protocolGrant(grant), grantSigner)),
      ...(promote ? { wrappedAdminRoot: k.bytesToHex(ADMIN_SEED) } : {}),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, tokenId: "tok-1", quarantineUntil: 100 + 14 * 86_400_000 }),
    );
    const addedProfiles: any[] = [];
    const registerPush = vi.fn(async ({ username }: any) => ({
      request: {
        username, deviceId: DEVICE_ID, platform: "webpush", providerToken: "{}",
        pushX25519Pub: "00".repeat(32), issuedAt: 100,
      },
      signatureHex: "dd".repeat(64),
    }));
    const deps = {
      bundlePlaintext: bundle,
      deviceIrkPubHex: devicePubHex,
      deviceId: DEVICE_ID,
      deviceSeed: DEVICE_SEED,
      signWithDevice: (b: Uint8Array) => k.signWithAdminRoot(DEVICE_SEED, b),
      deviceDisplayName: "This browser",
      fetchAccountIrkPubHex: async () => k.bytesToHex(harryIrk.publicKey),
      verifyEd25519: k.verifyWithEd25519Pub,
      setActiveKeystoreProfile: k.setActiveKeystoreProfile,
      persistSeedForProfile: k.persistSeedForProfile,
      persistAccountDeviceSeed: k.persistAccountDeviceSeed,
      persistAdminRootSeed: k.persistAdminRootSeed,
      unlockSession: () => {},
      registerPush,
      addProfile: (p: any) => addedProfiles.push(p),
      setUsername: () => {},
      bytesToHex: k.bytesToHex,
      hexToBytes: k.hexToBytes,
      ...(("passphrase" in opts) && opts.passphrase === undefined ? {} : { localPassphrase: opts.passphrase ?? PASS }),
      fetch: fetchMock as any,
      now: () => 100,
    };
    return { deps, fetchMock, addedProfiles, registerPush, grant, devicePubHex, bundle };
  }

  it("verifies the admit and grant, POSTs grant + profile, persists the UMK under a NEW profile and leaves the EXISTING one untouched", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");
    const f = await fixture(k);

    const out = await runIncomingJoin(f.deps);

    expect(out.username).toBe("harry");
    expect(out.promotedAdmin).toBe(false);
    expect(f.addedProfiles).toHaveLength(1);
    expect(f.addedProfiles[0].cloudName).toBe("harry");

    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.harry")).toBe(true);
    expect(store.has("wrappedUmk.alice")).toBe(true);
    expect(Array.from(await k.unlockUmk(PASS, "harry"))).toEqual(Array.from(HARRY_SEED));
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));

    // The body is exactly what `.com`'s handleVouchedDeviceAdmit requires.
    expect(f.registerPush).toHaveBeenCalledTimes(1);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/users/harry/devices/admit");
    const body = JSON.parse(init.body);
    expect(body.admit).toMatchObject({ username: "harry", deviceId: DEVICE_ID, newDevicePubHex: f.devicePubHex });
    expect(body.grant).toEqual(f.grant);
    expect(verifyDeviceCapabilityGrant(
      protocolGrant(body.grant), fromHex(body.grantSignature), deriveIRK({ seed: HARRY_SEED }).publicKey,
    )).toBe(true);
    expect(body.profile).toMatchObject({
      accountId: "harry", deviceId: DEVICE_ID, revision: 1, keyVersion: 1, signerPubHex: f.devicePubHex,
    });
    expect(verifyDeviceSelfProfile(body.profile, fromHex(f.devicePubHex))).toBe(true);
    expect(body.request.deviceId).toBe(DEVICE_ID);
    expect(body.signature).toBe("dd".repeat(64));

    // The device key picked before the account key was known is kept, wrapped
    // under it, and is what the browser signs as from now on.
    expect(Array.from(await k.deriveAccountDeviceSeedFromSeed(HARRY_SEED, "harry", DEVICE_ID)))
      .toEqual(Array.from(DEVICE_SEED));
    const sig = await k.signWithAccountDeviceKey(HARRY_SEED, "harry", DEVICE_ID, new Uint8Array([1, 2, 3]));
    expect(await k.verifyWithEd25519Pub(fromHex(f.devicePubHex), sig, new Uint8Array([1, 2, 3]))).toBe(true);

    expect(out.quarantine.quarantined).toBe(true);
    expect(out.quarantine.remainingMs).toBe(14 * 86_400_000);
  });

  it("REFUSES a bundle whose admit does NOT verify under the account key (nothing sent or persisted)", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    k.setActiveKeystoreProfile("alice");
    const seedA = await k.bootstrapNewIdentity(PASS, "alice");
    const f = await fixture(k, { admitSigner: deriveIRK({ seed: new Uint8Array(32).fill(0x01) }) });

    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/did not verify/);

    const store = DATABASES.get("flagship-webapp")!.get("keystore")!;
    expect(store.has("wrappedUmk.harry")).toBe(false);
    expect(Array.from(await k.unlockUmk(PASS, "alice"))).toEqual(Array.from(seedA));
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("REFUSES a grant signed by the wrong key (nothing sent or persisted)", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const f = await fixture(k, { badGrantSigner: true });
    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/grant did not verify/);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(DATABASES.get("flagship-webapp")?.get("keystore")?.has("wrappedUmk.harry") ?? false).toBe(false);
  });

  it("REFUSES a grant that names another device key", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const f = await fixture(k, { grantDevicePubHex: "ab".repeat(32) });
    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/grant is for a different device/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("REFUSES a bundle aimed at a DIFFERENT device (admit pub != this device key)", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const f = await fixture(k, { admitPubHex: "ab".repeat(32) });
    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/different device/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("a refusal from .com stores nothing in this browser", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const f = await fixture(k);
    f.fetchMock.mockResolvedValue(jsonResponse(400, { error: "missing device bootstrap" }));
    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/400/);
    expect(DATABASES.get("flagship-webapp")?.get("keystore")?.has("wrappedUmk.harry") ?? false).toBe(false);
    expect(f.addedProfiles).toHaveLength(0);
  });

  it("a promoted join checks the grant under the sealed admin root and stays admin after a reload with the chosen passphrase", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const chosen = "the-owner-chose-this";
    const f = await fixture(k, { promote: true, passphrase: chosen });
    const out = await runIncomingJoin(f.deps);
    expect(out.promotedAdmin).toBe(true);
    expect(JSON.parse(f.fetchMock.mock.calls[0]![1].body).grant.signerRoot).toBe("admin-root");
    expect(k.activeProfileId()).toBe("harry");
    const seed = await k.unlockUmk(chosen);
    expect(Array.from(seed)).toEqual(Array.from(HARRY_SEED));
    expect(Array.from((await k.loadAdminRootSeed(seed))!)).toEqual(Array.from(ADMIN_SEED));
  });

  it("a promoted bundle whose grant was NOT signed by the sealed admin root is refused", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    const f = await fixture(k, { promote: true, badGrantSigner: true });
    await expect(runIncomingJoin(f.deps)).rejects.toThrow(/grant did not verify/);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("a join with no chosen passphrase is refused before anything is stored", async () => {
    const k = await loadKeystore();
    const { runIncomingJoin } = await loadPairing();
    for (const pass of [undefined, "short"]) {
      const f = await fixture(k, { promote: true, passphrase: pass });
      await expect(runIncomingJoin(f.deps)).rejects.toThrow(/passphrase/);
      expect(f.fetchMock).not.toHaveBeenCalled();
    }
    const store = DATABASES.get("flagship-webapp")?.get("keystore");
    expect(store?.has("wrappedUmk.harry") ?? false).toBe(false);
  });
});

describe("crossDevicePairing — packages/protocol/test-vectors/device-pairing", () => {
  const V = JSON.parse(readFileSync(
    resolve(__dirname, "../../../packages/protocol/test-vectors/device-pairing/vectors.json"), "utf8",
  ));

  it("builds the vectors' grants and canonical bytes, and their signatures verify", async () => {
    const k = await loadKeystore();
    const P = await loadPairing();
    expect(P.DEVICE_SCOPE_ORDER).toEqual(V.scopeOrder);
    expect(P.MEMBER_DEVICE_SCOPES).toEqual(V.memberScopes);
    expect(P.DEVICE_GRANT_TTL_MS).toBe(V.grantTtlMs);
    expect(P.ADD_DEVICE_ADMIN_ONLY).toBe(V.adminOnlyLine);
    const admit = V.admit.fields;
    for (const [name, promoted, pub] of [
      ["memberGrant", false, V.keys.irkPubHex], ["adminGrant", true, V.keys.adminRootPubHex],
    ] as const) {
      const g = P.buildDeviceGrant({ admit, promoted, grantId: V[name].grant.grantId });
      expect(g).toEqual(V[name].grant);
      expect(new TextDecoder().decode(P.deviceGrantCanonicalBytes(g))).toBe(V[name].canonical);
      expect(await k.verifyWithEd25519Pub(
        fromHex(pub), fromHex(V[name].signatureHex), P.deviceGrantCanonicalBytes(g),
      )).toBe(true);
    }
  });

  it("the admit's canonical bytes are the vectors'", async () => {
    const P = await loadPairing();
    expect(new TextDecoder().decode(P.deviceAdmitCanonicalBytes(V.admit.fields))).toBe(V.admit.canonical);
  });

  it("the sealed bundle and the POST carry exactly the vectors' keys", async () => {
    const k = await loadKeystore();
    const { runAdminAddDevice, postDeviceAdmit } = await loadPairing();
    let sealed: Uint8Array | undefined;
    const relay = {
      open: async () => ({ sid: "S", pkB64u: "P" }), awaitConfirm: async () => true,
      receivePeerPub: async () => ({ devicePubHex: V.keys.devicePubHex, deviceId: V.admit.fields.deviceId }),
      seal: async (b: Uint8Array) => { sealed = b; }, close: () => {},
    };
    const seed = new Uint8Array(32).fill(7);
    await runAdminAddDevice({
      username: "harry", seed, adminRootSeed: ADMIN_SEED, promoteAdmin: true, relay,
      signWithIrk: k.signWithIrk, signWithAdminRoot: k.signWithAdminRoot, bytesToHex: k.bytesToHex,
      irkPubHex: k.bytesToHex(deriveIRK({ seed }).publicKey),
    });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(sealed!))).sort())
      .toEqual(V.bundleKeys.map((x: string) => x.replace("?", "")).sort());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await postDeviceAdmit({
      username: "harry", admit: {}, admitSigHex: "a", grant: {}, grantSignatureHex: "b", profile: {},
      request: {}, signatureHex: "c", fetch: fetchMock,
    });
    expect(Object.keys(JSON.parse(fetchMock.mock.calls[0]![1].body)).sort()).toEqual([...V.postKeys].sort());
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
