// Where flagship-web keeps what a sign-in leaves in the browser: one small key-value store.
//
// The browser key B is a WebCrypto CryptoKey made with `extractable: false`; IndexedDB stores it by structured clone,
// so its private half never exists as bytes this code (or an XSS) could read and send away. It can still SIGN while a
// page of the origin is open (docs/voici-and-messages.md §12.2): the delegation's expiry and scope bound that.
//
//   openIndexedDbStore({ name? }) -> store       the browser's store (IndexedDB, one object store "kv")
//   memoryStore() -> store                       tests, and browsers where IndexedDB is unavailable (nothing kept)
//   store = { get(key), put(key, value), delete(key), keys(prefix) }  all async

const DB_VERSION = 1;
const OBJECT_STORE = "kv";

export function memoryStore() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
    async keys(prefix = "") {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

export async function openIndexedDbStore({ name = "flagship-web", indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) return memoryStore();
  const open = indexedDB.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(OBJECT_STORE)) open.result.createObjectStore(OBJECT_STORE);
  };
  let db;
  try {
    db = await req(open);
  } catch {
    return memoryStore();
  }
  const tx = (mode) => db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE);
  return {
    async get(k) {
      const v = await req(tx("readonly").get(k));
      return v === undefined ? null : v;
    },
    async put(k, v) {
      await req(tx("readwrite").put(v, k));
    },
    async delete(k) {
      await req(tx("readwrite").delete(k));
    },
    async keys(prefix = "") {
      const all = await req(tx("readonly").getAllKeys());
      return all.filter((k) => typeof k === "string" && k.startsWith(prefix)).sort();
    },
  };
}
