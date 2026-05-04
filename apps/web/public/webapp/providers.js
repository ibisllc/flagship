// Webapp provider entries — multi-key, single-active.
//
// Each entry is a `{ id, provider, label, apiKey, baseUrl?, defaultModel? }`
// shape. The full list is JSON-serialized and AES-GCM-wrapped under a key
// derived from the UMK seed (`flagship.providers.v1`), then stored in the
// same IndexedDB instance as the wrapped UMK. After unlock the seed is in
// memory and the providers list opens without an extra prompt.
//
// flagshipserver.com NEVER sees these entries — they live only on the
// device. The vibe-coding flow seals the active entry under SWK and posts
// to the user's own Flagship server, which calls the provider directly.

import { _internal, bytesToHex, hexToBytes } from "./keystore.js";

const DB_NAME = "flagship-webapp";
const DB_STORE = "keystore";
const RECORD_KEY = "providers";

const PROMO_PROVIDER_ID = "flagship-promo";

/* ---------- IndexedDB helpers (same DB the keystore uses) ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
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
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain),
  );
  return { version: 1, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
}

async function unwrapList(umkSeed, blob) {
  const key = await deriveProvidersKey(umkSeed);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(blob.nonce) },
      key,
      hexToBytes(blob.ciphertext),
    ),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- entry validation ---------- */

const VALID_PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter", "ollama"]);

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
  return true;
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
    return list;
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
