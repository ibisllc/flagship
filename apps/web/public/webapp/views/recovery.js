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
import { humanError } from "../lib/humanError.js";
import {
  KEYFILE_COPY,
  createBackupFile,
  passphraseStrengthError,
  restoreFromBackupFile,
  importErrorMessage,
} from "../lib/keyfileBackup.js";
import { escapeHtml } from "../lib/util.js";
import { get as profileGet } from "../lib/profilesStore.js";

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
    if (!wrapped) return toast("No wrapped UMK on this device yet", "err");
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
    toast("Downloaded wrapped UMK — store it like a passport");
  } catch (e) {
    toast(`Export failed: ${e.message}`, "err");
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
    toast("Imported — refresh, then unlock with your passphrase");
  } catch (e) {
    toast(`Import failed: ${e.message}`, "err");
  }
}

function openDb() {
  // Must match keystore.js's DB_NAME + VERSION exactly. The shared
  // `flagship-webapp` DB is at version 2 (keystore.js / providers.js /
  // labelBook.js / buildDraft.js); opening at a lower version throws
  // VersionError once a v2 store exists. Create every known store so the
  // first creator provisions them all.
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("flagship-webapp", 2);
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
    toast(`Cloud recovery on for ${username}`, "ok");
  } catch (e) {
    toast(`Setup failed: ${e.message ?? e}`, "err");
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
    toast("Cloud recovery removed", "ok");
  } catch (e) {
    toast(`Remove failed: ${e.message ?? e}`, "err");
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

/**
 * Run the `.flagshipkey` export ceremony (heavy warning + strong
 * passphrase + the three acknowledgments) and download the file.
 * Returns true when a backup file was actually written, false when the
 * user cancelled the ceremony or the export errored. Exported so the
 * first-run wizard's "Secure your account" step can reuse this exact
 * flow instead of rebuilding the backup crypto.
 */
export async function runKeyfileExportCeremony() {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock first", "err");
    return false;
  }
  const username =
    session.username || profileGet("username") || "";
  const ceremony = await openExportCeremony();
  if (!ceremony) return false;
  try {
    const accountId = profileGet("accountId") || undefined;
    await createBackupFile({
      seed: session.umk,
      username: username || "account",
      accountId,
      passphrase: ceremony.passphrase,
    });
    toast(KEYFILE_COPY.afterSave, "ok");
    return true;
  } catch (e) {
    toast(`Backup failed: ${e?.message ?? e}`, "err");
    return false;
  }
}

function runKeyfileExport() {
  void runKeyfileExportCeremony();
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

    // H6 — bringing this device in via the backup file is a TAKEOVER, not a
    // silent local-identity swap. INITIATE the re-pair so the account's OTHER
    // devices are alerted and can object during the grace window — exactly the
    // security flow iOS/Android run. The seed is now in the unlocked session.
    const session = getSession();
    if (!(session.umk instanceof Uint8Array)) {
      // Defense-in-depth: restore is supposed to have unlocked the session.
      // Without the seed we can't sign the re-pair — fail rather than silently
      // skip the takeover (the bug this fix closes).
      throw new Error("account key wasn't available after restore");
    }
    const { deriveIrkFromSeed, deriveIrkVersioned, signWithIrkVersioned, bytesToHex } = keystore;
    const { runKeyfileImportTakeover, SecondFactorRequiredError } = await import(
      "../lib/keyfileImportTakeover.js"
    );
    const { addProfile } = await import("../lib/profiles.js");
    let takeover;
    try {
      // ROTATE the IRK on import: old = the registered (v1) key, new = a fresh
      // rotated device key. The re-pair handler rejects old==new, so inject the
      // versioned derivers (mirrors Android + loginTakeover).
      takeover = await runKeyfileImportTakeover({
        username,
        seed: session.umk,
        deriveIrkFromSeed,
        deriveIrkVersioned,
        signWithIrkVersioned,
        bytesToHex,
        addProfile: (profile) => addProfile(profile),
      });
    } catch (e) {
      if (e instanceof SecondFactorRequiredError) {
        // The account has a second factor enrolled (#52). The import sheet
        // can't collect it; route the user to the sign-in flow which can —
        // same guidance iOS/Android show.
        toast(e.message, "warn");
        return;
      }
      throw e;
    }

    toast(`Bringing this device into ${username}`, "ok");
    await runImportGraceCountdown(takeover);
  } catch (e) {
    toast(importErrorMessage(e), "err");
  }
}

/**
 * H6 — the grace-period countdown after a keyfile-import takeover is initiated.
 * Mirrors iOS `KeyfileImportSheet.graceCountdownView`: a non-dismissible card
 * with a live "this device takes over in N — your other devices are being
 * alerted and can object until then" line + a "Finish now" button that arms
 * once the grace has elapsed (then completes the re-pair + opens the account).
 *
 * Reuses loginTakeover.js's pure `graceTimeline` (label + ready flag) +
 * `finishTakeover` (the CAS-swap completion) so the countdown logic stays the
 * shared, unit-tested core.
 */
async function runImportGraceCountdown(takeover) {
  const { graceTimeline, finishTakeover } = await import("../lib/loginTakeover.js");
  const { dispatchInitialView } = await import("../lib/deepLink.js");

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
  overlay.innerHTML = `
    <div class="modal-card" role="document">
      <h3 class="modal-title">Bringing this device in</h3>
      <p class="modal-message" data-grace-line></p>
      <div class="row-2 mt-3">
        <button data-grace-finish disabled>Finish now</button>
      </div>
    </div>
  `;
  host.appendChild(overlay);
  document.body.classList.add("modal-open");

  const lineEl = overlay.querySelector("[data-grace-line]");
  const finishBtn = overlay.querySelector("[data-grace-finish]");
  let tickHandle = null;
  let finishing = false;

  const close = () => {
    if (tickHandle) clearInterval(tickHandle);
    overlay.remove();
    document.body.classList.remove("modal-open");
  };

  const paint = () => {
    const vm = graceTimeline(takeover.rePair);
    lineEl.textContent = vm.label;
    finishBtn.disabled = !vm.actionEnabled || finishing;
  };

  finishBtn.addEventListener("click", async () => {
    if (finishing) return;
    finishing = true;
    finishBtn.disabled = true;
    finishBtn.textContent = "Finishing…";
    try {
      const result = await finishTakeover(takeover, {
        // The re-pair ROTATED to takeover.newIrkVersion; once the swap
        // completes server-side, persist that version locally so subsequent
        // signing (push, orders, …) uses the rotated device key — mirrors
        // Android's setPendingIrkRotationVersion + finalize.
        finalizeV2Irk: async () => {
          if (takeover?.newIrkVersion) {
            try {
              const { setCurrentIrkVersion } = await import("../keystore.js");
              setCurrentIrkVersion(takeover.newIrkVersion);
            } catch { /* best-effort — the swap already succeeded server-side */ }
          }
        },
        openAccount: async () => {
          close();
          await dispatchInitialView();
        },
      });
      if (result.outcome === "objected") {
        toast(result.message, "err");
        close();
      } else if (result.outcome === "expired") {
        toast(result.message, "err");
        close();
      } else if (result.outcome === "too-early") {
        // The button shouldn't be reachable before the deadline; re-arm.
        finishing = false;
        finishBtn.textContent = "Finish now";
        paint();
      }
    } catch (e) {
      toast(humanError(e), "err");
      finishing = false;
      finishBtn.textContent = "Finish now";
      paint();
    }
  });

  paint();
  tickHandle = setInterval(paint, 1000);
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
