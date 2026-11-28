// The browser's signing keys under a passkey (docs/webapp-key-custody.md, items 1, 2 and 6).
//
// The admin root (Ed25519) and its ML-DSA-65 half are sealed together in one IndexedDB record
// (the admin-root record, version 2). The AES-GCM key needs BOTH the account key this browser
// unlocked with its passphrase AND a passkey's PRF output, so no key unlocks from a typed
// passphrase alone and every unwrap asks the platform authenticator (Touch ID, Windows Hello, a
// security key) with user verification. A key is unwrapped for the one action being signed and
// wiped when that action returns: the session holds a handle (public keys and an `open`), never
// the seeds.
//
// A version 1 record (the admin root under the account key alone, from before custody) moves to
// version 2 on its first use: the passkey is created then, the ML-DSA half is made and bound.
//
// Custody label, the same everywhere it is shown or signed: "browser-passkey" =
// "Browser: software key, unlocked with a passkey".

import { tr } from "./i18n.js";
import { adminRootRecordKey, activeProfileId, hkdf32, kvGet, kvPut, loadAdminRootSeed, adminRootPubHex, bytesToHex, hexToBytes, retiredUmksFor } from "../keystore.js";

// Loaded on first use, so the unlock path stays light.
const mldsaPublicKey = async (seed) => (await import("./mldsaWasm.js")).mldsaPublicKey(seed);
const edPubHex = (seed) => adminRootPubHex(seed);

export const CUSTODY_BROWSER = "browser-passkey";
export const LOCKED_KEY = Symbol.for("flagship.lockedKey");
const RECORD_VERSION = 2;
const KEK_INFO = "flagship/web-key-custody/v1";
const UMK_INFO = "flagship/web-key-custody/umk/v1";
const AAD_TAG = "flagship/web-key-custody/v1|admin-root";

function fail(code, message = code) {
  const e = Object.assign(new Error(message), { code });
  // Every caller's humanError() shows this sentence (lib/humanError.js reads userMessage).
  if (code.startsWith("custody-")) e.userMessage = custodyErrorText(e);
  return e;
}

const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

function random(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/* ---------- the authenticator (WebAuthn PRF) ---------- */

let authenticatorOverride = null;

/** Tests: `{ create(opts) → {credentialId, prf}, get(opts) → {prf} }` in place of WebAuthn. */
export function setCustodyAuthenticatorForTests(a) {
  authenticatorOverride = a;
}

function userVerified(authData) {
  const d = new Uint8Array(authData);
  return d.length > 32 && (d[32] & 0x04) !== 0;
}

async function webauthnGet({ credentialId, salt }) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64u(credentialId) }],
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!cred) throw fail("custody-cancelled");
  if (!userVerified(cred.response.authenticatorData)) throw fail("custody-no-uv");
  const out = cred.getClientExtensionResults?.().prf?.results?.first;
  if (!out) throw fail("custody-no-prf");
  return { prf: new Uint8Array(out) };
}

async function webauthnCreate({ salt, userName }) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: tr("Flagship"), id: location.hostname },
      user: { id: random(16), name: userName, displayName: userName },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!cred) throw fail("custody-cancelled");
  const credentialId = b64u(cred.rawId);
  const ext = cred.getClientExtensionResults?.().prf;
  if (ext && ext.enabled === false) throw fail("custody-no-prf");
  const first = ext?.results?.first;
  const authData = cred.response.getAuthenticatorData?.();
  if (first && authData && userVerified(authData)) return { credentialId, prf: new Uint8Array(first) };
  // Most authenticators evaluate the PRF only on an assertion.
  const got = await webauthnGet({ credentialId, salt });
  return { credentialId, prf: got.prf };
}

function authenticator() {
  if (authenticatorOverride) return authenticatorOverride;
  if (typeof navigator === "undefined" || !navigator.credentials || typeof PublicKeyCredential === "undefined") {
    return { create: () => Promise.reject(fail("custody-unsupported")), get: () => Promise.reject(fail("custody-unsupported")) };
  }
  return { create: webauthnCreate, get: webauthnGet };
}

/** Maps a WebAuthn failure to a custody code (a cancelled prompt is not an error worth a red line). */
function normalize(e) {
  if (e?.code?.startsWith?.("custody-")) return e;
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return fail("custody-cancelled");
  if (e?.name === "NotSupportedError" || e?.name === "SecurityError") return fail("custody-unsupported");
  return fail("custody-failed", e?.message ?? "custody");
}

/* ---------- the sealed record ---------- */

async function kek(prf, umk) {
  if (!(prf instanceof Uint8Array) || prf.length < 32) throw fail("custody-no-prf");
  const part = await hkdf32(umk, UMK_INFO);
  const ikm = new Uint8Array(64);
  ikm.set(prf.subarray(0, 32), 0);
  ikm.set(part, 32);
  const raw = await hkdf32(ikm, KEK_INFO);
  ikm.fill(0);
  part.fill(0);
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

const aad = (adminPubHex, mldsaPubHex) => new TextEncoder().encode(`${AAD_TAG}|${adminPubHex}|${mldsaPubHex}`);

async function seal(record, prf, umk, edSeed, mldsaSeed) {
  const key = await kek(prf, umk);
  const nonce = random(12);
  const plain = new Uint8Array(64);
  plain.set(edSeed, 0);
  plain.set(mldsaSeed, 32);
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(record.adminRootPubHex, record.mldsaPubHex) }, key, plain));
    return { ...record, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ct) };
  } finally {
    plain.fill(0);
  }
}

async function unseal(record, prf, umk) {
  const key = await kek(prf, umk);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(record.nonce), additionalData: aad(record.adminRootPubHex, record.mldsaPubHex) }, key, hexToBytes(record.ciphertext)));
  } catch {
    throw fail("custody-wrong-passkey");
  }
  const edSeed = plain.slice(0, 32);
  const mldsaSeed = plain.slice(32, 64);
  plain.fill(0);
  if ((await edPubHex(edSeed)) !== record.adminRootPubHex) {
    edSeed.fill(0);
    mldsaSeed.fill(0);
    throw fail("custody-wrong-passkey");
  }
  return { edSeed, mldsaSeed };
}

/** `unseal` under the current account key, else under a retired one (`resealed: true`: seal it again). */
async function unsealAnyEpoch(record, prf, umk) {
  try {
    return await unseal(record, prf, umk);
  } catch (first) {
    for (const old of retiredUmksFor(umk)) {
      try {
        return { ...(await unseal(record, prf, old)), resealed: true };
      } catch { /* an older key */ }
    }
    throw first;
  }
}

/** True for a version 2 (passkey-sealed) admin-root record. */
export function isCustodyRecord(r) {
  return !!r && r.version === RECORD_VERSION && r.custody === CUSTODY_BROWSER && typeof r.credentialId === "string";
}

/* ---------- handles ---------- */

/** True for a key handle (the session's stand-in for a sealed key). */
export function isLockedKey(x) {
  return !!x && typeof x === "object" && x[LOCKED_KEY] === true;
}

/** An admin-root key: a raw 32-byte seed (tests, the moment of creation) or a handle. */
export function isAdminRootKey(x) {
  return (x instanceof Uint8Array && x.length === 32) || (isLockedKey(x) && x.role === "admin-root");
}

/**
 * Runs `fn({ edSeed, mldsaSeed })` with the key's seeds and wipes them after. A raw seed is passed
 * through (its ML-DSA half is null); a handle asks for the passkey.
 */
export async function withAdminRoot(key, fn, { reason = "" } = {}) {
  if (key instanceof Uint8Array) return fn({ edSeed: key, mldsaSeed: null, pqBound: false });
  if (!isLockedKey(key)) throw fail("not-admin");
  const s = await key.open(reason);
  try {
    return await fn({ ...s, pqBound: key.pqBound === true });
  } finally {
    s.edSeed.fill(0);
    s.mldsaSeed?.fill(0);
  }
}

/** A raw copy of the admin-root seed for a flow that hands it on (escrow, promoting a device). The caller wipes it. */
export async function exportAdminRootSeed(key, { reason = "" } = {}) {
  if (key instanceof Uint8Array) return key.slice();
  return withAdminRoot(key, ({ edSeed }) => edSeed.slice(), { reason });
}

let onBindHook = null;

/**
 * Called once, with the seeds still open, after a record moves to version 2 or gets a new ML-DSA
 * half: lib/pqCustodyBinding.js signs the `admin-root` binding there and sends it to `.com`.
 * Returns true when `.com` holds this ML-DSA key for the admin root.
 */
export function setCustodyBindHook(fn) {
  onBindHook = fn;
}

async function bind(record, seeds) {
  if (!onBindHook) return null;
  try {
    return (await onBindHook({ adminRootPubHex: record.adminRootPubHex, edSeed: seeds.edSeed, mldsaSeed: seeds.mldsaSeed })) === true;
  } catch {
    return null;
  }
}

/**
 * The handle for this profile's admin-root record, or null when the browser holds none.
 * `umk` is a getter for the unlocked account key (the session's), read on each open.
 */
export async function loadAdminRootKey(umkGetter, { profileId, userName = "Flagship" } = {}) {
  // The profile is read at each use: opening an account moves the records onto its own profile.
  const pid = () => profileId ?? activeProfileId();
  let recordKey = adminRootRecordKey(pid());
  let record = await kvGet(recordKey);
  if (!record) return null;
  const umkNow = () => {
    const u = typeof umkGetter === "function" ? umkGetter() : umkGetter;
    if (!(u instanceof Uint8Array) || u.length !== 32) throw fail("custody-locked");
    return u;
  };

  let pubHex;
  if (isCustodyRecord(record)) {
    pubHex = record.adminRootPubHex;
  } else {
    const seed = await loadAdminRootSeed(umkNow(), pid());
    if (!seed) return null;
    pubHex = await adminRootPubHex(seed);
    seed.fill(0);
  }

  const handle = {
    [LOCKED_KEY]: true,
    role: "admin-root",
    pubHex,
    get custody() {
      return isCustodyRecord(record) ? CUSTODY_BROWSER : "browser-passphrase";
    },
    get mldsaPubHex() {
      return isCustodyRecord(record) ? record.mldsaPubHex : null;
    },
    get pqBound() {
      return isCustodyRecord(record) && record.pqBound === true;
    },
    /** Passkey prompt, unwrap; a version 1 record is moved to version 2 first. */
    async open() {
      const umk = umkNow();
      const { shellAllowsSigning } = await import("./shellTrust.js");
      if (!(await shellAllowsSigning())) throw fail("custody-shell-unsigned");
      const a = authenticator();
      recordKey = adminRootRecordKey(pid());
      const current = await kvGet(recordKey);
      if (!current) throw fail("not-admin");
      record = current;
      if (isCustodyRecord(record) && record.adminRootPubHex !== pubHex) throw fail("custody-key-changed");
      if (isCustodyRecord(record)) {
        let got;
        try {
          got = await a.get({ credentialId: record.credentialId, salt: hexToBytes(record.prfSalt) });
        } catch (e) {
          throw normalize(e);
        }
        try {
          const seeds = await unsealAnyEpoch(record, got.prf, umk);
          if (seeds.resealed) {
            // Sealed under an account key that has since been replaced: seal it again under the current one.
            record = await seal(record, got.prf, umk, seeds.edSeed, seeds.mldsaSeed);
            await kvPut(recordKey, record);
          }
          delete seeds.resealed;
          if (record.pqBound !== true && record.pqBound !== false) {
            const bound = await bind(record, seeds);
            if (bound !== null) {
              record = { ...record, pqBound: bound };
              await kvPut(recordKey, record);
            }
          }
          return seeds;
        } finally {
          got.prf.fill(0);
        }
      }
      const edSeed = await loadAdminRootSeed(umk, pid());
      if (!edSeed) throw fail("not-admin");
      if ((await edPubHex(edSeed)) !== pubHex) {
        edSeed.fill(0);
        throw fail("custody-key-changed");
      }
      const salt = random(32);
      let made;
      try {
        const cred = typeof record.credentialId === "string" ? record.credentialId : await custodyCredential(pid());
        made = cred ? { credentialId: cred, prf: (await a.get({ credentialId: cred, salt })).prf } : await a.create({ salt, userName });
      } catch (e) {
        edSeed.fill(0);
        throw normalize(e);
      }
      const mldsaSeed = random(32);
      try {
        const next = {
          version: RECORD_VERSION,
          custody: CUSTODY_BROWSER,
          credentialId: made.credentialId,
          prfSalt: bytesToHex(salt),
          adminRootPubHex: pubHex,
          mldsaPubHex: bytesToHex(await mldsaPublicKey(mldsaSeed)),
          pqBound: null,
          createdAt: Date.now(),
        };
        const sealed = await seal(next, made.prf, umk, edSeed, mldsaSeed);
        await kvPut(recordKey, sealed);
        if (!(await kvGet(`${PASSKEY_RECORD}.${pid()}`))) await kvPut(`${PASSKEY_RECORD}.${pid()}`, { credentialId: made.credentialId });
        record = sealed;
        const bound = await bind(record, { edSeed, mldsaSeed });
        if (bound !== null) {
          record = { ...record, pqBound: bound };
          await kvPut(recordKey, record);
        }
        return { edSeed, mldsaSeed };
      } catch (e) {
        edSeed.fill(0);
        mldsaSeed.fill(0);
        throw e;
      } finally {
        made.prf.fill(0);
      }
    },
  };
  return handle;
}

/* ---------- other sealed keys (org seat admin keys) ---------- */

const PASSKEY_RECORD = "flagship.custodyPasskey.v1";

/** The passkey this browser seals its keys under, if it has made one (shared by every sealed key of the profile). */
async function custodyCredential(profileId) {
  const r = await kvGet(`${PASSKEY_RECORD}.${profileId}`);
  if (r && typeof r.credentialId === "string") return r.credentialId;
  const admin = await kvGet(adminRootRecordKey(profileId));
  return typeof admin?.credentialId === "string" ? admin.credentialId : null;
}

async function prfFor(profileId, salt, userName) {
  const a = authenticator();
  const cred = await custodyCredential(profileId);
  try {
    if (cred) return { credentialId: cred, prf: (await a.get({ credentialId: cred, salt })).prf };
    const made = await a.create({ salt, userName });
    await kvPut(`${PASSKEY_RECORD}.${profileId}`, { credentialId: made.credentialId });
    return made;
  } catch (e) {
    throw normalize(e);
  }
}

/**
 * Seals `plain` (a key's seeds) under a passkey and the account key at `recordKey`, labelled by
 * `label` (bound into the ciphertext). One passkey prompt; the same passkey as the admin root's.
 */
export async function sealUnderPasskey({ recordKey, label, plain, umk, profileId = activeProfileId(), userName = "Flagship", meta = {} }) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) throw fail("custody-locked");
  const { shellAllowsSigning } = await import("./shellTrust.js");
  if (!(await shellAllowsSigning())) throw fail("custody-shell-unsigned");
  const salt = random(32);
  const got = await prfFor(profileId, salt, userName);
  try {
    const key = await kek(got.prf, umk);
    const nonce = random(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`${KEK_INFO}|${label}`) }, key, plain));
    await kvPut(recordKey, { version: RECORD_VERSION, custody: CUSTODY_BROWSER, credentialId: got.credentialId, prfSalt: bytesToHex(salt), label, ...meta, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ct) });
  } finally {
    got.prf.fill(0);
  }
}

/** Opens a key `sealUnderPasskey` sealed (one passkey prompt). The caller wipes the result. */
export async function openUnderPasskey({ recordKey, umk }) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) throw fail("custody-locked");
  const { shellAllowsSigning } = await import("./shellTrust.js");
  if (!(await shellAllowsSigning())) throw fail("custody-shell-unsigned");
  const r = await kvGet(recordKey);
  if (!r || r.version !== RECORD_VERSION || typeof r.label !== "string") throw fail("not-admin");
  let got;
  try {
    got = await authenticator().get({ credentialId: r.credentialId, salt: hexToBytes(r.prfSalt) });
  } catch (e) {
    throw normalize(e);
  }
  try {
    for (const k of [umk, ...retiredUmksFor(umk)]) {
      try {
        const key = await kek(got.prf, k);
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(r.nonce), additionalData: new TextEncoder().encode(`${KEK_INFO}|${r.label}`) }, key, hexToBytes(r.ciphertext)));
      } catch { /* an older account key */ }
    }
    throw fail("custody-wrong-passkey");
  } finally {
    got.prf.fill(0);
  }
}

/** True when this browser has made a custody passkey for the profile (the one its sealed keys open with). */
export async function hasCustodyPasskey(profileId = activeProfileId()) {
  return (await custodyCredential(profileId)) !== null;
}

/**
 * One assertion of the profile's custody passkey with user verification required, opening nothing: a check that the
 * person is here before an action that needs no key, such as deleting a conversation (docs/voici-calls.md). Throws a
 * custody error; a closed prompt is `custody-cancelled`.
 */
export async function verifyUserWithPasskey(profileId = activeProfileId()) {
  const cred = await custodyCredential(profileId);
  if (!cred) throw fail("custody-no-passkey");
  let got;
  try {
    got = await authenticator().get({ credentialId: cred, salt: random(32) });
  } catch (e) {
    throw normalize(e);
  }
  got?.prf?.fill?.(0);
}

/** What Settings shows for this browser's admin key: null (not an admin device), or its custody. */
export async function adminKeyCustody(profileId = activeProfileId()) {
  const record = await kvGet(adminRootRecordKey(profileId));
  if (!record) return null;
  if (isCustodyRecord(record)) return { custody: CUSTODY_BROWSER, pqBound: record.pqBound === true, createdAt: record.createdAt ?? null };
  return { custody: "browser-passphrase", pqBound: false, createdAt: null };
}

/** A custody failure as a sentence (a cancelled prompt included). */
export function custodyErrorText(e) {
  switch (e?.code) {
    case "custody-cancelled":
      return tr("The passkey prompt was closed. Nothing was signed.");
    case "custody-unsupported":
    case "custody-no-prf":
      return tr("This browser or passkey can't protect keys (it lacks the passkey PRF extension). Use a current Chrome, Edge, Safari or Firefox with a platform passkey or a security key.");
    case "custody-no-uv":
      return tr("The passkey didn't verify you (no fingerprint, face or PIN). Nothing was signed.");
    case "custody-wrong-passkey":
      return tr("That passkey doesn't unlock this browser's admin key. Use the passkey you set up for it on this browser.");
    case "custody-key-changed":
      return tr("This browser's admin key changed. Reload the page and try again.");
    case "custody-locked":
      return tr("Unlock the webapp first.");
    case "custody-shell-unsigned":
      return tr("This version of the webapp isn't signed by Flagship, so it can't use your admin key. Reload to get a signed version.");
    default:
      return tr("This browser couldn't open its admin key. Try again.");
  }
}
