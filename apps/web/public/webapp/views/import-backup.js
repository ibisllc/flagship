// Home → "+ Add/Import a server". Three doors: create a brand-new server (the
// existing create flow), co-manage a server someone else runs (their share
// link), or import a backup: pick its .flagship file, pick a name, burn or host the
// new server as usual, and this page sends it the backup once it is up
// (docs/server-backup-and-clone.md, "Restore a backup").

import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { userError } from "../lib/humanError.js";
import { boxClient } from "../lib/api.js";
import { serverFqdn } from "../lib/apex.js";
import { loadAccountPods, podFqdn, accountPods, isPodOnline } from "../lib/appPlacement.js";
import { podShortName } from "../lib/podSwitcher.js";
import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { depositSwkIfNeeded } from "../lib/swkDeposit.js";
import { depositCgkIfNeeded } from "../lib/cgkDeposit.js";
import { depositPairingIfNeeded } from "../lib/pairingDeposit.js";
import {
  archiveErrorText,
  commitRestore,
  describeRestoreApp,
  restoreSummary,
  formatBytes,
  restoreStatus,
  uploadDataFile,
  waitForRestore,
} from "../lib/serverArchive.js";
import {
  BACKUP_BUNDLE_EXTENSION,
  checkDataFile,
  splitBundle,
  openWithAccountKey,
  openWithPasscode,
  parseBackupFile,
} from "../lib/serverBackupFormat.js";
import { createServerForRestore, isValidServerName } from "./create-server.js";
import { canAddServers, refuseAddServer } from "../lib/addServerGate.js";
import { describePeerRoot, startPeerRestore, waitForPeerData, rootLines } from "../lib/peerBackup.js";

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
    <button class="secondary full-width mt-2" data-choice-peers>Restore from other servers</button>
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
      if (e?.code !== "cancelled") toast(archiveErrorText(e), "err");
    });
  });
  dlg.querySelector("[data-choice-peers]").addEventListener("click", () => {
    close();
    openRestoreFromPeers().catch((e) => {
      if (e?.code !== "cancelled") toast(archiveErrorText(e), "err");
    });
  });
}


// ---------------------------------------------------------------------------
// Import a backup (docs/server-backup-and-clone.md, "Restore a backup")
// ---------------------------------------------------------------------------

export const IMPORT_INTRO =
  "Pick the backup (its .flagship file) from wherever you keep it. " +
  "You choose a name; everything else comes from the backup. Then set up the new server as usual, " +
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
  // Importing a backup adds a server to the account: admin devices only.
  if (!canAddServers(session)) return refuseAddServer();
  const { dlg, close } = openDialog(
    "Import a backup",
    `
    <h3 class="modal-title">Import a backup</h3>
    <p class="note" data-imp-intro>${escapeHtml(targetFqdn ? `${podShortName(targetFqdn) || targetFqdn} is waiting for its backup. Pick the backup's .flagship file and this page sends it.` : IMPORT_INTRO)}</p>
    <div data-imp-pick>
      <input type="file" class="full-width" data-imp-file accept="${BACKUP_BUNDLE_EXTENSION},application/octet-stream" />
      <p class="note small" data-imp-files></p>
    </div>
    <div class="hidden" data-imp-pass>
      <label class="caption mt-2" for="imp-passcode">This backup was made on another account. Enter its passcode to open it.</label>
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
    ui.errEl.textContent = archiveErrorText(e);
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
    ui.filesEl.textContent = state.backupFile ? `${state.backupFile.name} (${formatBytes(state.backupFile.size)})` : "";
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
    if (!state.opened || !state.dataFile || state.checked) return;
    status("Checking the backup…");
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
            throw userError(`${name} is waiting for a different backup.`);
          }
        }
        status(
          `Waiting for ${name} to come online… Set it up with the recipe if you haven't yet. Keep this page open: ` +
            `the backup goes as soon as the server is up. If you leave, ${name} keeps waiting and shows on Home with Send the backup.`,
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
      status(`${name}: ${restoreSummary(done.apps)}`);
      toast("Backup restored", "ok");
    } catch (e) {
      show(ui.barEl, false);
      if (e?.code === "cancelled") return;
      status("The server keeps waiting for its backup. Pick the backup again from Home to send it, or delete the server there.");
      fail(e);
    }
  }

  ui.fileEl.addEventListener("change", async () => {
    clearError();
    try {
      const f = ui.fileEl.files?.[0];
      if (!f) return;
      // One .flagship file: its header and metadata part are read now; the
      // data part stays a lazy slice of the picked file, streamed by the check
      // and the upload (never held in memory).
      const { backupText, data } = await splitBundle(f);
      state.backupFile = f;
      state.parsed = parseBackupFile(backupText);
      state.dataFile = data;
      state.opened = null;
      state.checked = false;
      ui.fileEl.value = "";
      describeFiles();
      await openBackup();
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

export const PEERS_INTRO =
  "Your lost server's latest backup is kept in pieces on other Flagship servers. Pick the lost server, this page gets the pieces back, and you name the new server.";

/** A running server of the account this browser can talk to (it reads the lost server's record), or null. */
export function helperServer(pods, lost, hasSession = (fqdn) => boxClient(fqdn).hasSession()) {
  const gone = String(lost ?? "").toLowerCase();
  const p = accountPods(pods).find((x) => podFqdn(x) !== gone && isPodOnline(x) && hasSession(podFqdn(x)));
  return p ? podFqdn(p) : null;
}

/** Datalist options for the lost server: the account's servers, revoked and offline first. */
export function lostServerChoices(pods) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  const seen = new Set();
  const rows = [];
  for (const p of list) {
    const fqdn = podFqdn(p);
    if (!fqdn || seen.has(fqdn)) continue;
    seen.add(fqdn);
    rows.push({ fqdn, gone: p.revokedAt != null || !isPodOnline(p) });
  }
  return rows.sort((a, b) => Number(b.gone) - Number(a.gone) || a.fqdn.localeCompare(b.fqdn));
}

/**
 * Add/Import a server → Restore from other servers: the lost server's backup
 * comes back from the pieces other accounts' servers keep (docs/peer-backup.md
 * §9). Nothing is read from the lost server.
 */
export async function openRestoreFromPeers() {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  if (!canAddServers(session)) return refuseAddServer();
  const { dlg, close } = openDialog(
    "Restore from other servers",
    `
    <h3 class="modal-title">Restore from other servers</h3>
    <p class="note">${escapeHtml(PEERS_INTRO)}</p>
    <div data-pr-pick>
      <label class="caption mt-2" for="pr-lost">The lost server</label>
      <input id="pr-lost" class="full-width" list="pr-lost-list" autocomplete="off" autocapitalize="off" spellcheck="false" data-pr-lost />
      <datalist id="pr-lost-list" data-pr-list></datalist>
      <button class="full-width mt-2" data-pr-find>Find its backup</button>
    </div>
    <p class="note hidden" data-pr-summary></p>
    <div class="hidden" data-pr-name>
      <label class="caption mt-2" for="pr-server-name">Name of the new server</label>
      <input id="pr-server-name" class="full-width" autocomplete="off" autocapitalize="off" spellcheck="false" data-pr-server-name />
      <p class="note small err-text hidden" data-pr-name-error></p>
      <p class="note small" data-pr-address></p>
      <p class="note small" data-pr-settings></p>
      <button class="full-width mt-2" data-pr-create>Create the server</button>
    </div>
    <div class="hidden" data-pr-waiting-choice>
      <button class="full-width mt-2" data-pr-send-existing></button>
      <button class="secondary full-width mt-2" data-pr-new-instead>Create a new server instead</button>
    </div>
    <progress class="full-width hidden" data-pr-bar max="100" value="0"></progress>
    <p class="note" data-pr-status></p>
    <ul class="hidden" data-pr-apps style="list-style:none;padding-left:0"></ul>
    <p class="modal-error err-text hidden" data-pr-error></p>
    <div class="row-2 mt-3"><button class="secondary" data-pr-close>Close</button></div>
  `,
  );
  const q = (s) => dlg.querySelector(s);
  const show = (el, on = true) => el.classList.toggle("hidden", !on);
  const el = {
    pick: q("[data-pr-pick]"), lost: q("[data-pr-lost]"), list: q("[data-pr-list]"), find: q("[data-pr-find]"),
    summary: q("[data-pr-summary]"), name: q("[data-pr-name]"), nameInput: q("[data-pr-server-name]"),
    nameErr: q("[data-pr-name-error]"), address: q("[data-pr-address]"), settings: q("[data-pr-settings]"),
    create: q("[data-pr-create]"), choice: q("[data-pr-waiting-choice]"), sendExisting: q("[data-pr-send-existing]"),
    newInstead: q("[data-pr-new-instead]"), bar: q("[data-pr-bar]"), status: q("[data-pr-status]"),
    apps: q("[data-pr-apps]"), err: q("[data-pr-error]"),
  };
  let closed = false;
  const isCancelled = () => closed;
  q("[data-pr-close]").addEventListener("click", () => {
    closed = true;
    close();
  });
  dlg.addEventListener("close", () => {
    closed = true;
  });
  const status = (t) => {
    el.status.textContent = t;
  };
  const bar = (n, total) => {
    show(el.bar, total != null);
    if (total) el.bar.value = Math.round((n / total) * 100);
    else el.bar.removeAttribute("value");
  };
  const fail = (e) => {
    if (e?.code === "cancelled") return;
    el.err.textContent = archiveErrorText(e);
    show(el.err);
  };
  const state = { lost: "", root: null, opened: null, pods: [] };

  const pods = await loadAccountPods(session.username).catch(() => []);
  state.pods = pods;
  el.list.innerHTML = lostServerChoices(pods).map((c) => `<option value="${escapeHtml(c.fqdn)}"></option>`).join("");
  const first = lostServerChoices(pods).find((c) => c.gone);
  if (first) el.lost.value = first.fqdn;

  el.find.addEventListener("click", async () => {
    show(el.err, false);
    const lost = el.lost.value.trim().toLowerCase();
    if (!lost) return fail(userError("Pick the lost server."));
    el.find.disabled = true;
    status("Looking for the backup…");
    try {
      const helper = helperServer(pods, lost);
      state.lost = lost;
      state.root = await describePeerRoot({ client: helper ? boxClient(helper) : null, umkSeed: session.umk, serverId: lost });
      const file = parseBackupFile(state.root.archive.backupFile);
      const kek = await deriveServerArchiveKeyFromSeed(session.umk, file.archiveId);
      state.opened = await openWithAccountKey(file, kek);
      if (!state.opened) throw userError("This backup can't be opened with this account's key.");
      const a = state.root.archive;
      const d = state.opened.body.data;
      if (file.archiveId !== a.archiveId || d.bytes !== a.bytes || d.sha256 !== a.sha256) {
        throw userError("The backup record doesn't match its file. Nothing was restored.");
      }
      const body = state.opened.body;
      el.summary.textContent =
        rootLines(state.root).join(" ") + ` Apps: ${body.apps.map((x) => x.name).join(", ") || "none"}.`;
      show(el.summary);
      show(el.pick, false);
      status("");
      await chooseTarget(a);
    } catch (e) {
      status("");
      fail(e);
    } finally {
      el.find.disabled = false;
    }
  });

  async function chooseTarget(archive) {
    const inv = await loadInventory(session.username).catch(() => ({ pods: [], pending: [] }));
    const waiting = serverWaitingFor(inv.pods, archive.archiveId);
    if (waiting) {
      el.sendExisting.textContent = `Get it onto ${podShortName(waiting) || waiting} (waiting for this backup)`;
      show(el.choice);
      el.sendExisting.onclick = () => {
        show(el.choice, false);
        void fetchInto(waiting);
      };
      el.newInstead.onclick = () => {
        show(el.choice, false);
        showNameStep(inv);
      };
      return;
    }
    showNameStep(inv);
  }

  function showNameStep(inv) {
    const taken = takenServerNames(inv.pods, inv.pending);
    const saved = state.opened.body.server;
    el.nameInput.value = restoreNameFor(saved.name, taken);
    el.settings.textContent = savedSettingsLine(saved);
    const update = () => {
      const problem = el.nameInput.value ? restoreNameProblem(el.nameInput.value, taken) : null;
      el.nameErr.textContent = problem ?? "";
      show(el.nameErr, !!problem);
      const n = el.nameInput.value.trim().toLowerCase();
      el.address.textContent = n && !problem ? `Its address: ${serverFqdn(n, session.username)}` : "";
      el.create.disabled = !n || !!problem;
    };
    el.nameInput.addEventListener("input", update);
    update();
    show(el.name);
    el.create.onclick = async () => {
      show(el.err, false);
      const name = el.nameInput.value.trim().toLowerCase();
      if (restoreNameProblem(name, taken)) return update();
      el.create.disabled = true;
      el.nameInput.disabled = true;
      try {
        status("Creating the server…");
        const a = state.root.archive;
        const { serverDomain } = await createServerForRestore({
          serverName: name,
          bootUnlockMode: saved.bootUnlockMode,
          diskEncryption: saved.diskEncryption,
          restore: { archiveId: a.archiveId, bytes: a.bytes, sha256: a.sha256 },
        });
        show(el.name, false);
        el.summary.innerHTML =
          `${escapeHtml(`The recipe for ${serverDomain} is downloaded. Open it in Flagship Studio to host the server on this computer, or to write a USB stick for another one.`)} ` +
          `<a href="https://flagshipserver.com/studio" target="_blank" rel="noopener">Get Flagship Studio</a>.`;
        await fetchInto(serverDomain);
      } catch (e) {
        el.create.disabled = false;
        el.nameInput.disabled = false;
        status("");
        fail(e);
      }
    };
  }

  /** Wait for the new server to come online, then have it fetch the pieces. */
  async function fetchInto(fqdn) {
    const name = podShortName(fqdn) || fqdn;
    const client = boxClient(fqdn);
    const a = state.root.archive;
    try {
      for (;;) {
        if (closed) return;
        await helpTheNewServer(fqdn);
        if (client.hasSession()) {
          const st = await restoreStatus({ client }).catch(() => null);
          if (st?.waiting?.archiveId === a.archiveId) {
            if (st.restore && ["checking", "restoring"].includes(st.restore.state)) break;
            status(`${name} is getting the backup from other servers…`);
            bar(0, null);
            await startPeerRestore({ client, umkSeed: session.umk, serverId: state.lost });
            await waitForPeerData({
              client,
              isCancelled,
              onProgress: (r) => bar(r.received ?? 0, r.bytes || null),
            });
            await commitRestore({ client, contentKey: state.opened.contentKey });
            break;
          }
          if (st && !st.waiting && st.restore?.state === "done") break;
          if (st?.waiting && st.waiting.archiveId !== a.archiveId) throw userError(`${name} is waiting for a different backup.`);
        }
        status(
          `Waiting for ${name} to come online… Set it up with the recipe if you haven't yet. Keep this page open: ` +
            `it gets the backup as soon as the server is up. If you leave, ${name} keeps waiting and shows on Home.`,
        );
        await sleep(5000);
      }
      status("Restoring the apps…");
      bar(0, null);
      const done = await waitForRestore({
        client,
        isCancelled,
        onProgress: (r) => {
          show(el.apps);
          el.apps.innerHTML = (r.apps ?? []).map((x) => `<li>${escapeHtml(describeRestoreApp(x))}</li>`).join("");
        },
      });
      show(el.bar, false);
      show(el.apps);
      el.apps.innerHTML = done.apps.map((x) => `<li>${escapeHtml(describeRestoreApp(x))}</li>`).join("");
      status(`${name}: ${restoreSummary(done.apps)}`);
      toast("Backup restored", "ok");
    } catch (e) {
      show(el.bar, false);
      if (e?.code === "cancelled") return;
      status("The server keeps waiting for its backup. Start again from Add/Import a server, or delete the server on Home.");
      fail(e);
    }
  }
}

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
