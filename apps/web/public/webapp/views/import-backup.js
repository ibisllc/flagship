// Home → "+ Add/Import a server". Three doors: create a brand-new server (the
// existing create flow), co-manage a server someone else runs (their share
// link), or import a backup: pick its two files, pick a name, burn or host the
// new server as usual, and this page sends it the backup once it is up
// (docs/server-backup-and-clone.md, "Restore a backup").

import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { boxClient } from "../lib/api.js";
import { serverFqdn } from "../lib/apex.js";
import { loadAccountPods, podFqdn } from "../lib/appPlacement.js";
import { podShortName } from "../lib/podSwitcher.js";
import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { depositSwkIfNeeded } from "../lib/swkDeposit.js";
import { depositCgkIfNeeded } from "../lib/cgkDeposit.js";
import { depositPairingIfNeeded } from "../lib/pairingDeposit.js";
import {
  commitRestore,
  describeRestoreApp,
  formatBytes,
  restoreStatus,
  uploadDataFile,
  waitForRestore,
} from "../lib/serverArchive.js";
import {
  BACKUP_DATA_EXTENSION,
  BACKUP_FILE_EXTENSION,
  checkDataFile,
  classifyPicked,
  openWithAccountKey,
  openWithPasscode,
  parseBackupFile,
} from "../lib/serverBackupFormat.js";
import { createServerForRestore, isValidServerName } from "./create-server.js";

export const ADD_IMPORT_LABEL = "+ Add/Import a server";

function openDialog(label, html) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", label);
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.showModal();
  const close = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  return { dlg, close };
}

/** The chooser Home's button opens. */
export function openAddOrImport({ onAdd, onCoManage }) {
  const { dlg, close } = openDialog(
    "Add or import a server",
    `
    <h3 class="modal-title">Add/Import a server</h3>
    <button class="full-width" data-choice-add>Create a new server</button>
    <button class="secondary full-width mt-2" data-choice-co-manage>Co-manage a running server</button>
    <button class="secondary full-width mt-2" data-choice-import>Import a backup</button>
    <div class="row-2 mt-3"><button class="secondary" data-choice-cancel>Cancel</button></div>
  `,
  );
  dlg.querySelector("[data-choice-cancel]").addEventListener("click", close);
  dlg.querySelector("[data-choice-add]").addEventListener("click", () => {
    close();
    onAdd();
  });
  dlg.querySelector("[data-choice-co-manage]").addEventListener("click", () => {
    close();
    onCoManage();
  });
  dlg.querySelector("[data-choice-import]").addEventListener("click", () => {
    close();
    openImportBackup().catch((e) => {
      if (e?.code !== "cancelled") toast(humanError(e), "err");
    });
  });
}


// ---------------------------------------------------------------------------
// Import a backup (docs/server-backup-and-clone.md, "Restore a backup")
// ---------------------------------------------------------------------------

export const IMPORT_INTRO =
  "Pick the backup's two files (the .flagship-backup and its .flagship-data) from wherever you keep them. " +
  "You choose a name; everything else comes from the backup. You then host or burn the new server as usual, " +
  "and this page sends it the backup as soon as it comes online.";

/** Every name the account already uses: its servers (revoked ones still hold
 *  their name) and the servers still being created. */
export function takenServerNames(pods, pending = []) {
  const out = new Set();
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  for (const p of list) {
    const label = podFqdn(p).split(".")[0];
    if (label) out.add(label);
  }
  for (const o of pending ?? []) {
    const label = String(o?.serverName || String(o?.fqdn ?? "").split(".")[0] || "").toLowerCase();
    if (label) out.add(label);
  }
  return out;
}

/** The name the form starts with: the saved server's, unless the account uses it. */
export function restoreNameFor(savedName, taken) {
  const n = String(savedName ?? "").trim().toLowerCase();
  return n && isValidServerName(n) && !taken.has(n) ? n : "";
}

/** Why `name` can't be used for the new server, or null. */
export function restoreNameProblem(name, taken) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return "Pick a name for the new server.";
  if (!isValidServerName(n)) return "Lowercase letters, digits and hyphens (not at the start or end), up to 63.";
  if (taken.has(n)) return `You already have a server called "${n}".`;
  return null;
}

/** The account's server that is waiting for this backup, if any. */
export function serverWaitingFor(pods, archiveId) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  const p = list.find((x) => x?.awaitingBackup?.archiveId === archiveId && x?.revokedAt == null);
  return p ? podFqdn(p) : null;
}

/** "unlocks on its own" / "asks your phone at every boot", disk on/off. */
export function savedSettingsLine(server) {
  const unlock = server.bootUnlockMode === "approve" ? "asks your phone at every start" : "unlocks on its own after the first start";
  const disk = server.diskEncryption === "none" ? "disk not encrypted" : "disk encrypted";
  return `Copied from the backup: ${unlock}, ${disk}.`;
}

async function loadInventory(username) {
  const { fetchPodInventory } = await import("./home.js");
  const inv = await fetchPodInventory(username);
  return { pods: [...inv.statusByDomain.values()], pending: inv.pending ?? [] };
}

/**
 * Home → Add/Import a server → Import a backup, or a waiting server's "Send
 * the backup" (`targetFqdn`). One dialog that walks the whole restore.
 */
export async function openImportBackup({ targetFqdn = null } = {}) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const { dlg, close } = openDialog(
    "Import a backup",
    `
    <h3 class="modal-title">Import a backup</h3>
    <p class="note" data-imp-intro>${escapeHtml(targetFqdn ? `${podShortName(targetFqdn) || targetFqdn} is waiting for its backup. Pick the backup's two files and this page sends it.` : IMPORT_INTRO)}</p>
    <div data-imp-pick>
      <input type="file" class="full-width" data-imp-file multiple accept="${BACKUP_FILE_EXTENSION},${BACKUP_DATA_EXTENSION},application/json,application/octet-stream" />
      <p class="note small" data-imp-files></p>
    </div>
    <div class="hidden" data-imp-pass>
      <label class="caption mt-2" for="imp-passcode">This backup was made on another account, or with a passcode only. Enter its passcode:</label>
      <input id="imp-passcode" type="password" class="full-width" autocomplete="off" autocapitalize="off" spellcheck="false" data-imp-passcode />
      <button class="full-width mt-2" data-imp-unlock>Open the backup</button>
    </div>
    <p class="note hidden" data-imp-summary></p>
    <div class="hidden" data-imp-name>
      <label class="caption mt-2" for="imp-server-name">Name of the new server</label>
      <input id="imp-server-name" class="full-width" autocomplete="off" autocapitalize="off" spellcheck="false" data-imp-server-name />
      <p class="note small err-text hidden" data-imp-name-error></p>
      <p class="note small" data-imp-address></p>
      <p class="note small" data-imp-settings></p>
      <button class="full-width mt-2" data-imp-create>Create the server</button>
    </div>
    <div class="hidden" data-imp-waiting-choice>
      <button class="full-width mt-2" data-imp-send-existing></button>
      <button class="secondary full-width mt-2" data-imp-new-instead>Create a new server instead</button>
    </div>
    <progress class="full-width hidden" data-imp-bar max="100" value="0"></progress>
    <p class="note" data-imp-status></p>
    <ul class="hidden" data-imp-apps style="list-style:none;padding-left:0"></ul>
    <p class="modal-error err-text hidden" data-imp-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-imp-close>Close</button>
    </div>
  `,
  );
  const q = (s) => dlg.querySelector(s);
  const show = (el, on = true) => el.classList.toggle("hidden", !on);
  const ui = {
    fileEl: q("[data-imp-file]"),
    filesEl: q("[data-imp-files]"),
    pickEl: q("[data-imp-pick]"),
    passEl: q("[data-imp-pass]"),
    passInput: q("[data-imp-passcode]"),
    unlockBtn: q("[data-imp-unlock]"),
    summaryEl: q("[data-imp-summary]"),
    nameEl: q("[data-imp-name]"),
    nameInput: q("[data-imp-server-name]"),
    nameErr: q("[data-imp-name-error]"),
    addressEl: q("[data-imp-address]"),
    settingsEl: q("[data-imp-settings]"),
    createBtn: q("[data-imp-create]"),
    choiceEl: q("[data-imp-waiting-choice]"),
    sendExistingBtn: q("[data-imp-send-existing]"),
    newInsteadBtn: q("[data-imp-new-instead]"),
    barEl: q("[data-imp-bar]"),
    statusEl: q("[data-imp-status]"),
    appsEl: q("[data-imp-apps]"),
    errEl: q("[data-imp-error]"),
  };
  let closed = false;
  const isCancelled = () => closed;
  q("[data-imp-close]").addEventListener("click", () => {
    closed = true;
    close();
  });
  dlg.addEventListener("close", () => {
    closed = true;
  });
  const fail = (e) => {
    if (e?.code === "cancelled") return;
    ui.errEl.textContent = humanError(e);
    show(ui.errEl);
  };
  const clearError = () => show(ui.errEl, false);
  const status = (text) => {
    ui.statusEl.textContent = text;
  };
  const bar = (n, total) => {
    show(ui.barEl, total != null);
    if (total) ui.barEl.value = Math.round((n / total) * 100);
    else ui.barEl.removeAttribute("value");
  };

  const state = { backupFile: null, dataFile: null, parsed: null, opened: null, checked: false };

  const describeFiles = () => {
    const b = state.backupFile ? `Backup file: ${state.backupFile.name}` : "Backup file: not picked yet";
    const want = state.opened?.body?.data?.fileName;
    const d = state.dataFile
      ? `Data file: ${state.dataFile.name} (${formatBytes(state.dataFile.size)})`
      : `Data file: not picked yet${want ? ` (${want})` : ""}`;
    ui.filesEl.textContent = `${b}. ${d}.`;
  };
  describeFiles();

  async function openBackup() {
    if (!state.parsed || state.opened) return;
    const kek = await deriveServerArchiveKeyFromSeed(session.umk, state.parsed.archiveId);
    state.opened = await openWithAccountKey(state.parsed, kek);
    if (!state.opened) {
      show(ui.passEl);
      ui.passInput.focus();
      status("");
      return;
    }
    await afterOpen();
  }

  async function afterOpen() {
    show(ui.passEl, false);
    const { body } = state.opened;
    const names = body.apps.map((a) => a.name).join(", ") || "no apps";
    ui.summaryEl.textContent =
      `From ${body.server.domain}, saved ${new Date(body.createdAt).toLocaleString()}: ${names}.` +
      (body.left.length ? ` Not in this backup: ${body.left.map((a) => a.name).join(", ")}.` : "");
    show(ui.summaryEl);
    describeFiles();
    await checkData();
  }

  async function checkData() {
    if (!state.opened || !state.dataFile || state.checked) {
      if (state.opened && !state.dataFile) status(`Now pick its data file, ${state.opened.body.data.fileName}.`);
      return;
    }
    status("Checking the data file…");
    bar(0, state.dataFile.size);
    await checkDataFile(state.dataFile, state.opened.body.data, { onProgress: (n, t) => bar(n, t), isCancelled });
    state.checked = true;
    bar(0, null);
    show(ui.barEl, false);
    show(ui.pickEl, false);
    status("The backup checks out.");
    await chooseTarget();
  }

  async function chooseTarget() {
    const inv = await loadInventory(session.username).catch(() => ({ pods: [], pending: [] }));
    const waitingFqdn = targetFqdn || serverWaitingFor(inv.pods, state.parsed.archiveId);
    if (waitingFqdn) {
      ui.sendExistingBtn.textContent = `Send it to ${podShortName(waitingFqdn) || waitingFqdn} (waiting for this backup)`;
      show(ui.choiceEl);
      ui.sendExistingBtn.onclick = () => {
        show(ui.choiceEl, false);
        void sendTo(waitingFqdn);
      };
      ui.newInsteadBtn.onclick = () => {
        show(ui.choiceEl, false);
        showNameStep(inv);
      };
      return;
    }
    showNameStep(inv);
  }

  function showNameStep(inv) {
    const taken = takenServerNames(inv.pods, inv.pending);
    const saved = state.opened.body.server;
    ui.nameInput.value = restoreNameFor(saved.name, taken);
    ui.settingsEl.textContent = savedSettingsLine(saved);
    const update = () => {
      const problem = ui.nameInput.value ? restoreNameProblem(ui.nameInput.value, taken) : null;
      ui.nameErr.textContent = problem ?? "";
      show(ui.nameErr, !!problem);
      const n = ui.nameInput.value.trim().toLowerCase();
      ui.addressEl.textContent = n && !problem ? `Its address: ${serverFqdn(n, session.username)}` : "";
      ui.createBtn.disabled = !n || !!problem;
    };
    ui.nameInput.addEventListener("input", update);
    update();
    if (!ui.nameInput.value && saved.name) {
      ui.nameErr.textContent = `You already have a server called "${saved.name}": pick another name.`;
      show(ui.nameErr);
    }
    show(ui.nameEl);
    status("");
    ui.createBtn.onclick = async () => {
      clearError();
      const name = ui.nameInput.value.trim().toLowerCase();
      if (restoreNameProblem(name, taken)) return update();
      ui.createBtn.disabled = true;
      ui.nameInput.disabled = true;
      try {
        status("Creating the server…");
        const { serverDomain } = await createServerForRestore({
          serverName: name,
          bootUnlockMode: saved.bootUnlockMode,
          diskEncryption: saved.diskEncryption,
          restore: { archiveId: state.parsed.archiveId, bytes: state.opened.body.data.bytes, sha256: state.opened.body.data.sha256 },
        });
        show(ui.nameEl, false);
        ui.summaryEl.innerHTML =
          `${escapeHtml(`The recipe for ${serverDomain} is downloaded. Open it in Flagship Studio to host the server on this computer, or to write a USB stick for another one.`)} ` +
          `<a href="https://flagshipserver.com/studio" target="_blank" rel="noopener">Get Flagship Studio</a>.`;
        await sendTo(serverDomain);
      } catch (e) {
        ui.createBtn.disabled = false;
        ui.nameInput.disabled = false;
        status("");
        fail(e);
      }
    };
  }

  /** Wait for the server to come online and pair, then send it the backup. */
  async function sendTo(fqdn) {
    const name = podShortName(fqdn) || fqdn;
    const client = boxClient(fqdn);
    try {
      for (;;) {
        if (closed) return;
        await helpTheNewServer(fqdn);
        if (client.hasSession()) {
          const st = await restoreStatus({ client }).catch(() => null);
          if (st?.waiting?.archiveId === state.parsed.archiveId) {
            if (st.restore && ["checking", "restoring"].includes(st.restore.state)) break;
            status(`Sending the backup to ${name}…`);
            await uploadDataFile({
              client,
              blob: state.dataFile,
              archiveId: state.parsed.archiveId,
              onBytes: (n, t) => bar(n, t),
              isCancelled,
            });
            await commitRestore({ client, contentKey: state.opened.contentKey });
            break;
          }
          if (st && !st.waiting && st.restore?.state === "done") break;
          if (st?.waiting && st.waiting.archiveId !== state.parsed.archiveId) {
            throw new Error(`${name} is waiting for a different backup.`);
          }
        }
        status(
          `Waiting for ${name} to come online and pair with this browser. Keep this page open; ` +
            "if you close it, the server keeps waiting and you can send the backup later.",
        );
        await sleep(5000);
      }
      status("Restoring the apps…");
      bar(0, null);
      const done = await waitForRestore({
        client,
        isCancelled,
        onProgress: (r) => {
          show(ui.appsEl);
          ui.appsEl.innerHTML = (r.apps ?? []).map((a) => `<li>${escapeHtml(describeRestoreApp(a))}</li>`).join("");
        },
      });
      show(ui.barEl, false);
      show(ui.appsEl);
      ui.appsEl.innerHTML = done.apps.map((a) => `<li>${escapeHtml(describeRestoreApp(a))}</li>`).join("");
      status(`${name} is restored.`);
      toast("Backup restored", "ok");
    } catch (e) {
      show(ui.barEl, false);
      if (e?.code === "cancelled") return;
      status(`${name} keeps waiting for its backup: pick the backup again to send it, or delete the server from Home.`);
      fail(e);
    }
  }

  ui.fileEl.addEventListener("change", async () => {
    clearError();
    try {
      for (const f of Array.from(ui.fileEl.files ?? [])) {
        const kind = await classifyPicked(f);
        if (kind === "backup") {
          state.backupFile = f;
          state.parsed = parseBackupFile(await f.text());
          state.opened = null;
          state.checked = false;
        } else if (kind === "data") {
          state.dataFile = f;
          state.checked = false;
        } else {
          throw new Error(`${f.name} isn't a Flagship backup file or data file.`);
        }
      }
      ui.fileEl.value = "";
      describeFiles();
      if (state.parsed && !state.opened) await openBackup();
      else await checkData();
      if (!state.parsed) status("Now pick the backup file (.flagship-backup).");
    } catch (e) {
      bar(0, null);
      show(ui.barEl, false);
      fail(e);
    }
  });

  ui.unlockBtn.addEventListener("click", async () => {
    clearError();
    ui.unlockBtn.disabled = true;
    status("Opening the backup…");
    try {
      state.opened = await openWithPasscode(state.parsed, ui.passInput.value);
      ui.passInput.value = "";
      await afterOpen();
    } catch (e) {
      status("");
      fail(e);
    } finally {
      ui.unlockBtn.disabled = false;
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What Home's refresh does for a new server, done here too so the restore
 *  doesn't depend on Home being open: hand it its keys and this browser's
 *  pairing (each a no-op once done). */
async function helpTheNewServer(fqdn) {
  const session = getSession();
  const pods = await loadAccountPods(session.username).catch(() => []);
  const pod = pods.find((p) => podFqdn(p) === fqdn.toLowerCase());
  if (!pod?.identityPubKey || pod.revokedAt != null) return;
  const args = { serverDomain: fqdn, identityPubKeyHex: String(pod.identityPubKey) };
  await Promise.allSettled([depositSwkIfNeeded(args), depositCgkIfNeeded(args), depositPairingIfNeeded(args)]);
}
