// In-memory IndexedDB and localStorage for tests that run the shipped webapp keystore in Node
// (the same shim webappCrossDevicePairing.test.ts carries inline).
/* eslint-disable @typescript-eslint/no-explicit-any */

type Stores = Map<string, Map<string, unknown>>;
export const DATABASES = new Map<string, Stores>();

function fireAsync(fn: () => void) {
  setTimeout(fn, 0);
}

export function makeIndexedDBShim() {
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

export function makeLocalStorage(): Storage {
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
