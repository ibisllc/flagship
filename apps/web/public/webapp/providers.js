// Webapp provider entries — multi-key, single-active.
//
// Each entry is a `{ id, provider, label, apiKey, baseUrl?, defaultModel?,
// defaultEffort?, relay }` shape; the list's `flagshipDefaultModel` is
// Flagship Inference's default (a catalog id). `relay` (send the key's calls through the Flagship relay so
// the provider sees Flagship's address, not the box's) is on unless the owner
// turned it off; entries saved before it existed read as on. The full list is JSON-serialized and AES-GCM-wrapped under a key
// derived from the UMK seed (`flagship.providers.v1`), then stored in the
// same IndexedDB instance as the wrapped UMK. After unlock the seed is in
// memory and the providers list opens without an extra prompt.
//
// flagshipserver.com NEVER sees these entries — they live only on the
// device. The vibe-coding flow seals the active entry under SWK and posts
// to the user's own Flagship server, which calls the provider (through the
// Flagship relay unless the key says otherwise).

import { _internal, bytesToHex, hexToBytes } from "./keystore.js";

import { tr } from "./lib/i18n.js";
const DB_NAME = "flagship-webapp";
const DB_STORE = "keystore";
const RECORD_KEY = "providers";

const PROMO_PROVIDER_ID = "flagship-promo";

/* ---------- IndexedDB helpers (same DB the keystore uses) ---------- */

// Shared `flagship-webapp` DB — see keystore.js: schema version is 2 and every
// opener must open at the SAME version (a lower-version open throws
// VersionError once a v2 store exists). Open at v2 + create every known store
// so the first creator provisions them all.
const DB_VERSION = 2;
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("keystore")) db.createObjectStore("keystore");
      if (!db.objectStoreNames.contains("labelBook")) db.createObjectStore("labelBook");
      if (!db.objectStoreNames.contains("buildDrafts")) {
        db.createObjectStore("buildDrafts", { keyPath: "id" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- crypto: AES-GCM wrap/unwrap with a UMK-derived KEK ---------- */

async function deriveProvidersKey(umkSeed) {
  const ikm = await crypto.subtle.importKey("raw", umkSeed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("flagship.providers.v1"),
    },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrapList(umkSeed, list) {
  const key = await deriveProvidersKey(umkSeed);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plain = new TextEncoder().encode(JSON.stringify(list));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: tr("AES-GCM"), iv: nonce }, key, plain),
  );
  return { version: 1, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
}

async function unwrapList(umkSeed, blob) {
  const key = await deriveProvidersKey(umkSeed);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: tr("AES-GCM"), iv: hexToBytes(blob.nonce) },
      key,
      hexToBytes(blob.ciphertext),
    ),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- entry validation ---------- */

const VALID_PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter", "ollama", "flagship"]);

// Optional per-entry provenance. "promo" marks a Flagship-minted free-credits
// key (scoped .com token → our blessed inference endpoint); the daemon pins a
// promo credential's baseUrl to the RunPod host. Absent ⇒ a BYOK key.
const VALID_SOURCES = new Set(["byok", "promo"]);

function isValidEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || e.id.length < 1 || e.id.length > 64) return false;
  if (typeof e.provider !== "string" || !VALID_PROVIDERS.has(e.provider)) return false;
  if (typeof e.label !== "string" || e.label.length < 1 || e.label.length > 64) return false;
  if (typeof e.apiKey !== "string" || e.apiKey.length < 1 || e.apiKey.length > 1024) return false;
  if (e.baseUrl !== undefined && (typeof e.baseUrl !== "string" || e.baseUrl.length > 256)) return false;
  if (e.defaultModel !== undefined && (typeof e.defaultModel !== "string" || e.defaultModel.length > 128)) {
    return false;
  }
  if (e.defaultEffort !== undefined && (typeof e.defaultEffort !== "string" || e.defaultEffort.length > 32)) {
    return false;
  }
  if (e.source !== undefined && (typeof e.source !== "string" || !VALID_SOURCES.has(e.source))) return false;
  if (e.relay !== undefined && typeof e.relay !== "boolean") return false;
  return true;
}

/** An entry with `relay` filled in: on unless explicitly off. */
export function withRelayDefault(e) {
  return { ...e, relay: e.relay !== false };
}

/** A stored list as the app uses it: every entry's `relay` filled in (keys
 *  saved before the relay existed read as on). */
export function normalizeList(list) {
  return { ...list, entries: (list?.entries || []).map(withRelayDefault) };
}

/**
 * The in-memory credential a build sends the box for this entry. `relay` is
 * always explicit, so the box never has to guess.
 */
export function credentialFor(e) {
  const credential = { provider: e.provider, apiKey: e.apiKey };
  if (e.baseUrl) credential.baseUrl = e.baseUrl;
  credential.relay = e.relay !== false;
  return credential;
}

/** The saved entry a credential came from (same provider, key and base URL). */
export function entryForCredential(entries, credential) {
  if (!credential) return null;
  return (
    (entries || []).find(
      (e) =>
        e.provider === credential.provider &&
        e.apiKey === credential.apiKey &&
        (e.baseUrl || "") === (credential.baseUrl || ""),
    ) ?? null
  );
}

function newEntryId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/* ---------- public surface ---------- */

export async function loadProviders(umkSeed) {
  const blob = await dbGet(RECORD_KEY);
  if (!blob) return { entries: [], activeId: PROMO_PROVIDER_ID };
  try {
    const list = await unwrapList(umkSeed, blob);
    return normalizeList(list);
  } catch {
    // Corrupted or wrong key — return empty rather than throw, so the user
    // can recover by adding a fresh entry.
    return { entries: [], activeId: PROMO_PROVIDER_ID };
  }
}

export async function saveProviders(umkSeed, list) {
  // Defensive validation: never persist a malformed entry.
  for (const e of list.entries) {
    if (!isValidEntry(e)) throw new Error(`invalid provider entry: ${JSON.stringify(e)}`);
  }
  const blob = await wrapList(umkSeed, list);
  await dbPut(RECORD_KEY, blob);
}

export async function addProvider(umkSeed, partial) {
  const list = await loadProviders(umkSeed);
  const entry = {
    id: newEntryId(),
    provider: partial.provider,
    label: partial.label,
    apiKey: partial.apiKey,
    baseUrl: partial.baseUrl || undefined,
    defaultModel: partial.defaultModel || undefined,
    defaultEffort: partial.defaultEffort || undefined,
    source: partial.source || undefined,
    relay: partial.relay !== false,
  };
  if (!isValidEntry(entry)) throw new Error("invalid provider entry");
  list.entries.push(entry);
  // First user-added entry implicitly becomes active (over the promo default).
  if (list.activeId === PROMO_PROVIDER_ID && list.entries.length === 1) {
    list.activeId = entry.id;
  }
  await saveProviders(umkSeed, list);
  return entry;
}

export async function removeProvider(umkSeed, id) {
  const list = await loadProviders(umkSeed);
  list.entries = list.entries.filter((e) => e.id !== id);
  if (list.activeId === id) {
    list.activeId = list.entries[0]?.id ?? PROMO_PROVIDER_ID;
  }
  await saveProviders(umkSeed, list);
}

export async function setActive(umkSeed, id) {
  const list = await loadProviders(umkSeed);
  if (id !== PROMO_PROVIDER_ID && !list.entries.find((e) => e.id === id)) {
    throw new Error("unknown provider id");
  }
  list.activeId = id;
  await saveProviders(umkSeed, list);
}

/** Turn the Flagship relay on or off for one saved key. */
export async function setRelay(umkSeed, id, relay) {
  const list = await loadProviders(umkSeed);
  const entry = list.entries.find((e) => e.id === id);
  if (!entry) throw new Error("unknown provider id");
  entry.relay = relay === true;
  await saveProviders(umkSeed, list);
  return entry;
}

/**
 * Turn the relay off for the saved key behind `credential` (a call failed
 * because the relay wasn't reachable), and on the in-memory credential too
 * so the next send goes direct. Resolves false when no saved key matches.
 */
export async function turnRelayOffForCredential(umkSeed, credential) {
  const list = await loadProviders(umkSeed);
  const entry = entryForCredential(list.entries, credential);
  if (!entry) return false;
  await setRelay(umkSeed, entry.id, false);
  credential.relay = false;
  return true;
}

/**
 * The default model (and effort) a chat starts with: on a saved key, or,
 * for `PROMO_ID`, Flagship Inference's catalog id. An empty model clears it.
 */
export async function setDefaultModel(umkSeed, id, { model, effort } = {}) {
  const list = await loadProviders(umkSeed);
  const m = typeof model === "string" && model.trim() ? model.trim().slice(0, 128) : undefined;
  const ef = m && typeof effort === "string" && effort ? effort.slice(0, 32) : undefined;
  if (id === PROMO_PROVIDER_ID) {
    list.flagshipDefaultModel = m;
  } else {
    const entry = list.entries.find((e) => e.id === id);
    if (!entry) throw new Error("unknown provider id");
    entry.defaultModel = m;
    entry.defaultEffort = ef;
  }
  await saveProviders(umkSeed, list);
}

/** The saved default `{ model, effort }` for a credential (a Flagship pass or a saved key). */
export function defaultModelFor(list, credential) {
  if (!credential) return {};
  if (credential.provider === "flagship") return { model: list?.flagshipDefaultModel };
  const entry = entryForCredential(list?.entries, credential);
  return entry ? { model: entry.defaultModel, effort: entry.defaultEffort } : {};
}

export const PROMO_ID = PROMO_PROVIDER_ID;
export const SUPPORTED_PROVIDERS = [...VALID_PROVIDERS].sort();

// Re-export helpers used by app.js so it doesn't have to know about
// keystore internals.
export { bytesToHex, hexToBytes };

// _internal is exported for tests so they can poke at the wrap/unwrap surface
// without going through IndexedDB.
export const _testing = {
  wrapList,
  unwrapList,
  deriveProvidersKey,
  isValidEntry,
  hkdfHelper: _internal.hkdf32,
};
