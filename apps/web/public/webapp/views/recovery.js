// P2.12 — Recovery flow.
//
// Status (2026-05-09): cloud-shard wrap/unwrap primitives (iCloud
// Keychain / Google Block Store) live in the iOS + Android keystores
// but the webapp's keystore.js doesn't yet have web-equivalent
// primitives. The recovery story for the webapp is currently:
//
//   1. Keep your wrapped UMK + passphrase backed up somewhere.
//   2. On a fresh device, open this webapp + use Unlock with the same
//      passphrase against the same browser profile (the wrapped UMK
//      lives in IndexedDB).
//
// This view documents that path and offers a manual "export wrapped
// UMK" + "import wrapped UMK" pair so a determined user can move
// between browsers / devices today.
//
// Real cloud-shard recovery lands in a follow-up cycle once the
// platform-specific webauthn / passkey path is designed.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";

registerView("view-recovery");

const WRAPPED_UMK_KEY = "flagship.wrappedUmk";

async function exportWrapped() {
  // The keystore module stores the wrapped UMK in IndexedDB. We fetch
  // it via a thin re-implementation of what keystore.js does — the
  // full module-internal handle isn't exported, but the schema is
  // stable enough that direct access works for export/import.
  try {
    const db = await openDb();
    const tx = db.transaction("kv", "readonly");
    const store = tx.objectStore("kv");
    const wrapped = await reqToPromise(store.get(WRAPPED_UMK_KEY));
    if (!wrapped) return toast("no wrapped UMK on this device yet", "err");
    const json = JSON.stringify(wrapped, (_, v) => {
      if (v instanceof ArrayBuffer) {
        return { __ab: Array.from(new Uint8Array(v)) };
      }
      if (v instanceof Uint8Array) {
        return { __u8: Array.from(v) };
      }
      return v;
    });
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flagship-wrapped-umk-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("downloaded wrapped UMK — store it like a passport");
  } catch (e) {
    toast(`export failed: ${e.message}`, "err");
  }
}

async function importWrapped(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text, (_, v) => {
      if (v && typeof v === "object" && Array.isArray(v.__ab)) {
        return new Uint8Array(v.__ab).buffer;
      }
      if (v && typeof v === "object" && Array.isArray(v.__u8)) {
        return new Uint8Array(v.__u8);
      }
      return v;
    });
    const db = await openDb();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(parsed, WRAPPED_UMK_KEY);
    await txDone(tx);
    toast("imported — refresh, then unlock with your passphrase");
  } catch (e) {
    toast(`import failed: ${e.message}`, "err");
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("flagship", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
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

export function initRecoveryView() {
  $("recovery-back")?.addEventListener("click", () => show("view-home"));
  $("recovery-export")?.addEventListener("click", exportWrapped);
  $("recovery-import-input")?.addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (f) importWrapped(f);
  });
}

export function enterRecovery() {
  show("view-recovery");
}
