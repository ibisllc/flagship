// Home → "+ Add/Import a server". Three doors: create a brand-new server (the
// existing create flow), co-manage a server someone else runs (their share
// link), or import a backup file onto a server of the account (Backup/clone
// server). Importing never changes the server's name: to clone under a new
// name, add the new server first, then import onto it.

import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { boxClient, sessionTokenForPod } from "../lib/api.js";
import { accountPods, isPodOnline, loadAccountPods, podFqdn } from "../lib/appPlacement.js";
import { podShortName } from "../lib/podSwitcher.js";
import {
  ARCHIVE_FILE_EXTENSION,
  describeRestoreApp,
  formatBytes,
  importBackup,
  readArchiveHeader,
  waitForRestore,
} from "../lib/serverArchive.js";

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

/** Servers this device can import onto: online, with a session. */
export function importTargets(pods, { hasSession = (f) => !!sessionTokenForPod(f), now = Date.now() } = {}) {
  return accountPods(pods)
    .filter((p) => isPodOnline(p, now) && hasSession(podFqdn(p)))
    .map((p) => ({ fqdn: podFqdn(p), label: podShortName(podFqdn(p)) || podFqdn(p) }));
}

export async function openImportBackup() {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const pods = await loadAccountPods(session.username);
  const targets = importTargets(pods);
  const { dlg, close } = openDialog(
    "Import a backup",
    `
    <h3 class="modal-title">Import a backup</h3>
    <input type="file" class="full-width" data-imp-file accept="${ARCHIVE_FILE_EXTENSION},application/octet-stream" />
    <div class="hidden" data-imp-details>
      <p class="note" data-imp-summary></p>
      <label class="caption mt-2">Import onto</label>
      <select class="full-width" data-imp-target>
        ${targets.map((t) => `<option value="${escapeHtml(t.fqdn)}">${escapeHtml(t.label)}</option>`).join("")}
      </select>
      <p class="note small mt-2">Apps already on that server are left alone. Apps are installed under that server's own name.</p>
    </div>
    <p class="note small err-text ${targets.length ? "hidden" : ""}" data-imp-none>
      No server of yours is online right now. Add the new server first, wait for it to come online, then import.
    </p>
    <progress class="full-width hidden" data-imp-bar max="100" value="0"></progress>
    <p class="note" data-imp-status></p>
    <ul class="hidden" data-imp-apps style="list-style:none;padding-left:0"></ul>
    <p class="modal-error err-text hidden" data-imp-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-imp-close>Close</button>
      <button class="hidden" data-imp-go>Import</button>
    </div>
  `,
  );
  const q = (s) => dlg.querySelector(s);
  const fileEl = q("[data-imp-file]");
  const detailsEl = q("[data-imp-details]");
  const summaryEl = q("[data-imp-summary]");
  const targetEl = q("[data-imp-target]");
  const barEl = q("[data-imp-bar]");
  const statusEl = q("[data-imp-status]");
  const appsEl = q("[data-imp-apps]");
  const errEl = q("[data-imp-error]");
  const goBtn = q("[data-imp-go]");
  q("[data-imp-close]").addEventListener("click", close);

  const fail = (e) => {
    errEl.textContent = humanError(e);
    errEl.classList.remove("hidden");
  };

  fileEl.addEventListener("change", async () => {
    errEl.classList.add("hidden");
    goBtn.classList.add("hidden");
    detailsEl.classList.add("hidden");
    const file = fileEl.files?.[0];
    if (!file) return;
    try {
      const h = await readArchiveHeader(file);
      const names = h.apps.map((a) => a.name).join(", ") || "no apps";
      summaryEl.textContent = `From ${h.sourceServer || "a server"}: ${names} (${formatBytes(file.size)}).`;
      detailsEl.classList.remove("hidden");
      if (targets.length) goBtn.classList.remove("hidden");
    } catch (e) {
      fail(e);
    }
  });

  goBtn.addEventListener("click", async () => {
    const file = fileEl.files?.[0];
    if (!file || !targetEl.value) return;
    goBtn.disabled = true;
    fileEl.disabled = true;
    targetEl.disabled = true;
    errEl.classList.add("hidden");
    barEl.classList.remove("hidden");
    const client = boxClient(targetEl.value);
    try {
      statusEl.textContent = "Sending the backup to the server…";
      await importBackup({
        client,
        file,
        umk: session.umk,
        onBytes: (n, total) => {
          barEl.value = Math.round((n / total) * 100);
        },
      });
      statusEl.textContent = "Restoring the apps…";
      barEl.removeAttribute("value");
      const done = await waitForRestore({
        client,
        onProgress: (s) => {
          appsEl.classList.remove("hidden");
          appsEl.innerHTML = s.apps.map((a) => `<li>${escapeHtml(describeRestoreApp(a))}</li>`).join("");
        },
      });
      barEl.classList.add("hidden");
      appsEl.classList.remove("hidden");
      appsEl.innerHTML = done.apps.map((a) => `<li>${escapeHtml(describeRestoreApp(a))}</li>`).join("");
      statusEl.textContent = "Import finished.";
      goBtn.classList.add("hidden");
      toast("Backup imported", "ok");
    } catch (e) {
      barEl.classList.add("hidden");
      statusEl.textContent = "The import didn't finish.";
      fail(e);
      goBtn.disabled = false;
      fileEl.disabled = false;
      targetEl.disabled = false;
    }
  });
}
