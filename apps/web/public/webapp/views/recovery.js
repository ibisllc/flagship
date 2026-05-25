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
import { ensureUsername, getSession, unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import {
  KEYFILE_COPY,
  createBackupFile,
  passphraseStrengthError,
  restoreFromBackupFile,
  importErrorMessage,
} from "../lib/keyfileBackup.js";
import { escapeHtml } from "../lib/util.js";

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
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Remove cloud recovery for ${username}?`,
    message: "You'll lose the ability to recover this account from a new browser unless you have a manual export.",
    okLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
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

/* ---------- `.flagshipkey` backup (primary path) ---------- */

// Build the export ceremony overlay: the heavy warning, a strong passphrase
// (entered twice), and the 3 required acknowledgments. The "Create backup
// file" button stays disabled until all three boxes are ticked and the
// passphrases match + pass the strength gate. Returns { passphrase } on
// confirm or null on cancel.
function openExportCeremony() {
  return new Promise((resolve) => {
    let host = document.getElementById("flagship-modal-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "flagship-modal-host";
      document.body.appendChild(host);
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const ackHtml = KEYFILE_COPY.acks
      .map(
        (a, i) =>
          `<label class="modal-ack"><input type="checkbox" data-ack="${i}" /> <span>${escapeHtml(a)}</span></label>`,
      )
      .join("");
    overlay.innerHTML = `
      <div class="modal-card" role="document">
        <h3 class="modal-title">${escapeHtml(KEYFILE_COPY.exportTitle)}</h3>
        <p class="modal-message">${escapeHtml(KEYFILE_COPY.intro)}</p>
        <p class="modal-message err-text"><strong>${escapeHtml(KEYFILE_COPY.danger)}</strong></p>
        <p class="modal-message">${escapeHtml(KEYFILE_COPY.passphrase)}</p>
        <input type="password" class="modal-input" data-pass1 placeholder="Passphrase" autocomplete="new-password" />
        <input type="password" class="modal-input mt-2" data-pass2 placeholder="Confirm passphrase" autocomplete="new-password" />
        <p class="modal-error err-text hidden" data-err></p>
        <div class="modal-acks mt-3">${ackHtml}</div>
        <div class="row-2 mt-3">
          <button class="secondary" data-cancel>Cancel</button>
          <button data-ok disabled>${escapeHtml(KEYFILE_COPY.createButton)}</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");

    const pass1 = overlay.querySelector("[data-pass1]");
    const pass2 = overlay.querySelector("[data-pass2]");
    const errEl = overlay.querySelector("[data-err]");
    const okBtn = overlay.querySelector("[data-ok]");
    const cancelBtn = overlay.querySelector("[data-cancel]");
    const acks = Array.from(overlay.querySelectorAll("[data-ack]"));
    queueMicrotask(() => pass1?.focus({ preventScroll: true }));

    const allAcked = () => acks.every((c) => c.checked);
    const validate = () => {
      // Strength + match. Only surface an error once the user has typed.
      const p1 = pass1.value;
      const p2 = pass2.value;
      let reason = null;
      if (p1) {
        reason = passphraseStrengthError(p1);
        if (!reason && p2 && p1 !== p2) reason = "Passphrases don't match.";
      }
      if (reason) {
        errEl.textContent = reason;
        errEl.classList.remove("hidden");
      } else {
        errEl.classList.add("hidden");
      }
      const ready = !reason && p1.length > 0 && p1 === p2 && allAcked();
      okBtn.disabled = !ready;
      return ready;
    };

    const close = (value) => {
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(null); }
    };
    pass1.addEventListener("input", validate);
    pass2.addEventListener("input", validate);
    acks.forEach((c) => c.addEventListener("change", validate));
    okBtn.addEventListener("click", () => {
      if (validate()) close({ passphrase: pass1.value });
    });
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);
  });
}

async function runKeyfileExport() {
  const session = getSession();
  if (!session.umk) return toast("unlock first", "err");
  const username =
    session.username || localStorage.getItem("flagship.username") || "";
  const ceremony = await openExportCeremony();
  if (!ceremony) return;
  try {
    const accountId = localStorage.getItem("flagship.accountId") || undefined;
    await createBackupFile({
      seed: session.umk,
      username: username || "account",
      accountId,
      passphrase: ceremony.passphrase,
    });
    toast(KEYFILE_COPY.afterSave, "ok");
  } catch (e) {
    toast(`backup failed: ${e?.message ?? e}`, "err");
  }
}

async function runKeyfileImport(file) {
  const { inlinePrompt } = await import("../lib/modal.js");
  const fileText = await file.text();
  const passphrase = await inlinePrompt({
    title: "Open backup file",
    message: "Enter the passphrase you set when you created this backup.",
    placeholder: "Passphrase",
    type: "password",
    okLabel: "Restore",
    validate: (v) => (v ? null : "Passphrase required"),
  });
  if (!passphrase) return;
  const localPassphrase = await inlinePrompt({
    title: "Lock this browser",
    message: "Set a passphrase to unlock this account on this browser from now on (8+ characters).",
    placeholder: "New device passphrase",
    type: "password",
    okLabel: "Restore account",
    validate: (v) => (v && v.length >= 8 ? null : "Use at least 8 characters"),
  });
  if (!localPassphrase) return;
  try {
    const keystore = await import("../keystore.js");
    const { username } = await restoreFromBackupFile({
      fileText,
      passphrase,
      localPassphrase,
      keystore,
      unlockSession,
    });
    toast(`restored ${username}`, "ok");
    const { dispatchInitialView } = await import("../lib/deepLink.js");
    await dispatchInitialView();
  } catch (e) {
    toast(importErrorMessage(e), "err");
  }
}

export function initRecoveryView() {
  $("recovery-back")?.addEventListener("click", () => show("view-home"));
  $("recovery-keyfile-export")?.addEventListener("click", runKeyfileExport);
  $("recovery-keyfile-input")?.addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (f) runKeyfileImport(f);
    ev.target.value = "";
  });
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
