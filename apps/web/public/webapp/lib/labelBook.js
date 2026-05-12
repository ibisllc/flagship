// Local label-book (#82).
//
// The daemon's invite system (#80) uses opaque 16-byte tags to identify
// whom an invite was issued to. The mapping "tag b8…ec1 → John (work)"
// is the load-bearing private information — and it MUST NOT touch the
// daemon's storage or flagshipserver.com's storage. This module is the
// owner-only side of that mapping.
//
// Persistence: IndexedDB ("flagship-webapp", store "labelBook"), keyed
// on `<appId>|<opaqueTagHex>`. Sync to the encrypted user-identity blob
// (#71) is lazy: every mutation writes locally first, then enqueues
// a "dirty" flag the sync hook can pick up when online. Until the sync
// hook lands, the local IDB is the source of truth — losing the
// browser loses the labels, never the daemon's access rows.
//
// Sync hook contract (stubbed for cross-worker dep):
//   `syncToEncryptedBlob(entries)` is left as a function the bootstrap
//   module wires in once the encrypted-blob worker is ready. Calls
//   here proceed without it; an unconfigured sync is the default.

const DB_NAME = "flagship-webapp";
const STORE = "labelBook";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keystore")) db.createObjectStore("keystore");
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function key(appId, tagHex) {
  return `${appId}|${tagHex.toLowerCase()}`;
}

/**
 * Persist one label. Returns the stored entry.
 *
 * @param {string} appId
 * @param {string} opaqueTagHex 32 lowercase hex chars
 * @param {{displayName: string, channel: string, sentTo?: string, notes?: string}} fields
 */
export async function putLabel(appId, opaqueTagHex, fields) {
  const tag = opaqueTagHex.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new Error("opaqueTag must be 32 hex chars");
  const entry = {
    displayName: (fields.displayName ?? "").slice(0, 200),
    channel: normalizeChannel(fields.channel),
    sentTo: (fields.sentTo ?? "").slice(0, 280),
    sentAt: Date.now(),
    notes: (fields.notes ?? "").slice(0, 2000),
    appId,
    opaqueTagHex: tag,
    dirty: true,
  };
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(entry, key(appId, tag));
  await txDone(tx);
  return entry;
}

/**
 * Read a single label. Undefined when missing.
 */
export async function getLabel(appId, opaqueTagHex) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const got = await reqToPromise(tx.objectStore(STORE).get(key(appId, opaqueTagHex)));
  return got ?? undefined;
}

/**
 * List every label for one app. Sorted by sentAt descending.
 */
export async function listLabelsForApp(appId) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const items = [];
  await new Promise((resolve, reject) => {
    const cur = store.openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value && c.value.appId === appId) items.push(c.value);
      c.continue();
    };
  });
  items.sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
  return items;
}

/**
 * Remove a label. Idempotent.
 */
export async function removeLabel(appId, opaqueTagHex) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(key(appId, opaqueTagHex));
  await txDone(tx);
}

/**
 * Snapshot every dirty entry. The cross-worker encrypted-blob sync
 * hook reads this, ships the blob upstream, then calls clearDirty.
 */
export async function snapshotDirty() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = store.openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value && c.value.dirty) out.push(c.value);
      c.continue();
    };
  });
  return out;
}

export async function clearDirty(entries) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const e of entries) {
    store.put({ ...e, dirty: false }, key(e.appId, e.opaqueTagHex));
  }
  await txDone(tx);
}

const VALID_CHANNELS = new Set([
  "imessage", "whatsapp", "telegram", "signal", "email",
  "qr", "airdrop", "manual", "other",
]);

function normalizeChannel(c) {
  return typeof c === "string" && VALID_CHANNELS.has(c) ? c : "other";
}

/**
 * Build the canonical share-URL the user copies. Mirrors the daemon's
 * /invite HTML page contract: `#k=<secretHex>&a=<appId>`.
 */
export function buildShareUrl(appUrl, secretHex, appId) {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/invite#k=${secretHex}&a=${encodeURIComponent(appId)}`;
}

/**
 * Generate 16 random bytes for an opaqueTag. Returns lowercase hex.
 */
export function generateOpaqueTag() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
