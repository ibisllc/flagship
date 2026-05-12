// P2.12 — Recovery flow.
//
// Two paths coexist:
//
//   (A) Cloud-shard recovery via WebAuthn passkey (primary).
//       Wraps the UMK seed under a passkey's PRF output and
//       uploads the ciphertext to .com. Recovery from a new
//       browser: enter username → WebAuthn → unwrap → restore.
//       See lib/recovery.js + protocol's UploadRecoveryRecord.
//
//   (B) Manual export/import of the wrapped UMK (fallback).
//       The user moves a JSON file between browsers themselves.
//       Useful for devices without WebAuthn or for paranoid
//       users who don't want any cloud copy.

import { $, registerView, show } from "../lib/router.js";
import {
  deleteCloudRecovery,
  hasCloudRecovery,
  setupCloudRecovery,
} from "../lib/recovery.js";
import { ensureUsername } from "../lib/state.js";
import { toast } from "../lib/toast.js";

registerView("view-recovery");

// Must match keystore.js's RECORD_KEY exactly — both sides write/read
// the same IndexedDB row, so a typo here was silently breaking export
// and import (toast would say "no wrapped UMK on this device yet" even
// right after a successful bootstrap).
const WRAPPED_UMK_KEY = "wrappedUmk";

async function exportWrapped() {
  // The keystore module stores the wrapped UMK in IndexedDB. We fetch
  // it via a thin re-implementation of what keystore.js does — the
  // full module-internal handle isn't exported, but the schema is
  // stable enough that direct access works for export/import.
  try {
    const db = await openDb();
    const tx = db.transaction("keystore", "readonly");
    const store = tx.objectStore("keystore");
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
    const tx = db.transaction("keystore", "readwrite");
    tx.objectStore("keystore").put(parsed, WRAPPED_UMK_KEY);
    await txDone(tx);
    toast("imported — refresh, then unlock with your passphrase");
  } catch (e) {
    toast(`import failed: ${e.message}`, "err");
  }
}

function openDb() {
  // Must match keystore.js's DB_NAME exactly. Bootstrap writes the
  // wrapped UMK into "flagship-webapp", so export/import has to open
  // the same database.
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("flagship-webapp", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("keystore")) db.createObjectStore("keystore");
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

async function refreshCloudStatus() {
  const pill = $("recovery-cloud-pill");
  const setupBtn = $("recovery-cloud-setup");
  const removeBtn = $("recovery-cloud-remove");
  if (!pill || !setupBtn || !removeBtn) return;
  const username = (await import("../lib/state.js")).getSession().username;
  if (!username) {
    pill.textContent = "no username yet";
    setupBtn.textContent = "Set up cloud recovery";
    removeBtn.style.display = "none";
    return;
  }
  pill.textContent = "checking…";
  const exists = await hasCloudRecovery(username);
  pill.textContent = exists ? "on" : "off";
  setupBtn.textContent = exists ? "Re-register passkey" : "Set up cloud recovery";
  removeBtn.style.display = exists ? "" : "none";
}

async function runSetupCloud() {
  const btn = $("recovery-cloud-setup");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Waiting for passkey…";
  }
  try {
    const username = await ensureUsername();
    await setupCloudRecovery(username);
    toast(`cloud recovery on for ${username}`, "ok");
  } catch (e) {
    toast(`setup failed: ${e.message ?? e}`, "err");
  } finally {
    if (btn) btn.disabled = false;
    void refreshCloudStatus();
  }
}

async function runRemoveCloud() {
  const btn = $("recovery-cloud-remove");
  const username = (await import("../lib/state.js")).getSession().username;
  if (!username) return;
  if (!confirm(`Remove cloud recovery for ${username}? You'll lose the ability to recover this account from a new browser unless you have a manual export.`)) {
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Removing…";
  }
  try {
    await deleteCloudRecovery(username);
    toast("cloud recovery removed", "ok");
  } catch (e) {
    toast(`remove failed: ${e.message ?? e}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Remove cloud recovery";
    }
    void refreshCloudStatus();
  }
}

export function initRecoveryView() {
  $("recovery-back")?.addEventListener("click", () => show("view-home"));
  $("recovery-export")?.addEventListener("click", exportWrapped);
  $("recovery-import-input")?.addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (f) importWrapped(f);
  });
  $("recovery-cloud-setup")?.addEventListener("click", runSetupCloud);
  $("recovery-cloud-remove")?.addEventListener("click", runRemoveCloud);
  // J.4 integration: after a recovery binds, the user lands here. The
  // "reattach progress" button opens the per-app re-issuance summary.
  $("recovery-open-reattach")?.addEventListener("click", async () => {
    const { enterPostRecovery } = await import("./post-recovery.js");
    enterPostRecovery();
  });
}

export function enterRecovery() {
  show("view-recovery");
  void refreshCloudStatus();
}
