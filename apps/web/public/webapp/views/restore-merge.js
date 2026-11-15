// Restore apps from a backup into this server (docs/restore-into-server.md §7): the backup is opened
// with this account's key in the browser, a signed stage order lets the box check it, the box's
// preview is shown in three groups with the accepted defaults preselected, and a second signed order
// carries exactly the plan shown. Then progress, the result, and the earlier copies with Undo.
// Admin devices only. Mirrors the iOS RestoreMergeScreen.

import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { boxErrorText } from "../lib/humanError.js";
import { inlineConfirm } from "../lib/modal.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { parseBackupFile, openWithAccountKey, splitBundle, BACKUP_BUNDLE_EXTENSION } from "../lib/serverBackupFormat.js";
import {
  ACTION_ORDER,
  RESTORE_ADMIN_ONLY,
  actionName,
  canRestore,
  cancelMerge,
  choose,
  commitMerge,
  comparisonText,
  consequenceText,
  defaultChoices,
  groupOf,
  mergeStatus,
  notesFor,
  planLines,
  refusalText,
  sendMergeData,
  sendPlan,
  sendUndo,
  stageRestore,
  stepText,
  validCopySlug,
  waitForPreview,
} from "../lib/restoreMerge.js";
import { tr, dateLocale } from "../lib/i18n.js";

export { BACKUP_BUNDLE_EXTENSION };

const fmtDate = (t) => new Date(t).toLocaleString(dateLocale(), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (t) => new Date(t).toLocaleDateString(dateLocale(), { month: "short", day: "numeric", year: "numeric" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signer() {
  const session = getSession();
  return (bytes) => sensitiveSigner()(session.umk, bytes);
}

// ---- earlier copies (undo points) ----

/** The kept copies a restore left: each with its end date, Undo and Delete now (both signed, both confirmed). */
export function undoListHtml(points, admin) {
  if (!points?.length) return "";
  const rows = points
    .map(
      (p) => `
      <li class="list-row" data-rm-undo-row="${escapeHtml(p.serviceId)}">
        <div>${escapeHtml(p.name)}</div>
        <div class="faint-sm">${escapeHtml(tr("Kept until {0}", fmtDay(p.expiresAt)))}</div>
        <div class="row-2 mt-1">
          <button class="secondary" data-rm-undo="${escapeHtml(p.restoreId)}/${escapeHtml(p.serviceId)}"${admin ? "" : " disabled"}>${tr("Undo")}</button>
          <button class="danger" data-rm-discard="${escapeHtml(p.restoreId)}/${escapeHtml(p.serviceId)}"${admin ? "" : " disabled"}>${tr("Delete now")}</button>
        </div>
      </li>`,
    )
    .join("");
  return `
    <h3 class="mt-3">${tr("Earlier copies kept by a restore")}</h3>
    <ul class="list" data-rm-undo-list>${rows}</ul>
    ${admin ? "" : `<p class="note small" data-rm-undo-admin-only>${escapeHtml(RESTORE_ADMIN_ONLY)}</p>`}`;
}

/**
 * Wire the Undo / Delete now buttons under `root`. Each asks first (Undo loses later changes,
 * Delete can't be undone), then signs the order with the admin root.
 */
export function wireUndoList(root, { client, serverDomain, points, onChanged, onError }) {
  root.addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const btn = t?.closest("[data-rm-undo],[data-rm-discard]");
    if (!btn || btn.disabled || !canSignAdminOrders()) return;
    const discard = btn.hasAttribute("data-rm-discard");
    const key = btn.getAttribute(discard ? "data-rm-discard" : "data-rm-undo");
    const point = points().find((p) => `${p.restoreId}/${p.serviceId}` === key);
    if (!point) return;
    const ok = await inlineConfirm(
      discard
        ? { title: tr("Delete the earlier copy?"), message: tr("The copy of {0} from before the restore is deleted. This can't be undone.", point.name), okLabel: tr("Delete"), danger: true }
        : { title: tr("Put the earlier copy back?"), message: tr("Changes to {0} since {1} are lost.", point.name, fmtDate(point.keptAt)), okLabel: tr("Undo"), danger: true },
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      await sendUndo({ client, serverDomain, point, discard, sign: signer() });
      await onChanged?.();
    } catch (e) {
      btn.disabled = false;
      onError?.(boxErrorText(e));
    }
  });
}

// ---- the restore dialog ----

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

function appRowHtml(a, choice) {
  const chosen = choice?.action ?? a.recommended;
  const options = ACTION_ORDER.filter((x) => a.allowed.includes(x) || a.disallowed?.[x] !== undefined)
    .map((x) => {
      const allowed = a.allowed.includes(x);
      const line = allowed ? consequenceText(x, a) : refusalText(a.disallowed[x]);
      return `
        <label class="boot-unlock-option" data-rm-option="${escapeHtml(x)}">
          <input type="radio" name="rm-act-${escapeHtml(a.archivedServiceId)}" value="${escapeHtml(x)}"${x === chosen ? " checked" : ""}${allowed ? "" : " disabled"} data-rm-action="${escapeHtml(a.archivedServiceId)}" />
          <span class="boot-unlock-title">${escapeHtml(actionName(x))}${x === a.recommended ? ` <span class="faint-sm" data-rm-suggested>${tr("Suggested")}</span>` : ""}</span>
          <span class="boot-unlock-desc faint-sm">${escapeHtml(line)}</span>
        </label>`;
    })
    .join("");
  const notes = notesFor(a, chosen)
    .map((n) => `<p class="note small" data-rm-note>${escapeHtml(n)}</p>`)
    .join("");
  const copy =
    chosen === "copy"
      ? `
        <label class="caption mt-2" for="rm-copy-${escapeHtml(a.archivedServiceId)}">${tr("Name of the new app")}</label>
        <input id="rm-copy-${escapeHtml(a.archivedServiceId)}" class="full-width" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(choice?.copyName ?? "")}" data-rm-copy-name="${escapeHtml(a.archivedServiceId)}" />
        <p class="note small err-text${validCopySlug(choice?.copyName) ? " hidden" : ""}" data-rm-copy-error="${escapeHtml(a.archivedServiceId)}">${tr("Lowercase letters, digits and single hyphens.")}</p>`
      : "";
  return `
    <details class="list-row" data-rm-app="${escapeHtml(a.archivedServiceId)}">
      <summary>
        <strong>${escapeHtml(a.name)}</strong>
        <span class="faint-sm" data-rm-chosen>${escapeHtml(actionName(chosen))}</span>
        <div class="faint-sm" data-rm-compare>${escapeHtml(comparisonText(a))}</div>
      </summary>
      <div class="boot-unlock-options mt-2">${options}</div>
      ${copy}
      ${notes}
    </details>`;
}

/**
 * Server page → Backups → a saved backup's "Restore into this server…" (`source: {kind: "saved", archiveId}`)
 * or "Restore apps from a backup file…" (`source: {kind: "file", file}`).
 */
export async function openRestoreMerge({ client, serverDomain, source, onClose }) {
  const session = getSession();
  const { dlg, close } = openDialog(
    tr("Restore apps from a backup"),
    `
    <h3 class="modal-title">${tr("Restore apps from a backup")}</h3>
    <progress class="full-width hidden" data-rm-bar max="100" value="0"></progress>
    <p class="note" data-rm-status></p>
    <p class="note small hidden" data-rm-backup-at></p>
    <div class="hidden" data-rm-choose>
      <div data-rm-groups></div>
      <button class="full-width mt-3" data-rm-restore disabled>${tr("Restore")}</button>
      <p class="note small" data-rm-hint>${tr("Choose at least one app to restore.")}</p>
    </div>
    <ul class="list hidden" data-rm-run></ul>
    <div data-rm-undo-host></div>
    <p class="modal-error err-text hidden" data-rm-error role="alert"></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-rm-close>${tr("Cancel")}</button>
    </div>
  `,
  );
  const q = (s) => dlg.querySelector(s);
  const show = (el, on = true) => el?.classList.toggle("hidden", !on);
  const ui = {
    bar: q("[data-rm-bar]"),
    status: q("[data-rm-status]"),
    backupAt: q("[data-rm-backup-at]"),
    choose: q("[data-rm-choose]"),
    groups: q("[data-rm-groups]"),
    restore: q("[data-rm-restore]"),
    hint: q("[data-rm-hint]"),
    run: q("[data-rm-run]"),
    undoHost: q("[data-rm-undo-host]"),
    error: q("[data-rm-error]"),
    closeBtn: q("[data-rm-close]"),
  };
  // idle | opening | sending | checking | choosing | restoring | done | failed
  let phase = "opening";
  let closed = false;
  let preview = null;
  let choices = {};
  let run = null;
  let undo = [];
  let archiveId = "";
  let dataSha = "";
  let staged = false;
  const isCancelled = () => closed;

  const setStatus = (text) => {
    ui.status.textContent = text;
  };
  const fail = (e) => {
    if (e?.code === "cancelled") return;
    ui.error.textContent = boxErrorText(e);
    show(ui.error);
  };
  const failPhase = (e) => {
    if (e?.code === "cancelled") return;
    phase = "failed";
    show(ui.bar, false);
    setStatus("");
    show(ui.choose, false);
    ui.error.textContent = boxErrorText(e);
    show(ui.error);
    ui.error.setAttribute("data-rm-failed", "");
  };
  const finish = () => {
    closed = true;
    close();
    onClose?.();
  };
  ui.closeBtn.addEventListener("click", async () => {
    // Closing before the plan drops what was staged (it changes no app); a run carries on without the page.
    if (staged && phase !== "done" && phase !== "restoring") await cancelMerge({ client }).catch(() => {});
    finish();
  });
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    ui.closeBtn.click();
  });

  const renderUndo = () => {
    ui.undoHost.innerHTML = undoListHtml(undo, canSignAdminOrders());
  };
  wireUndoList(ui.undoHost, {
    client,
    serverDomain,
    points: () => undo,
    onChanged: async () => {
      undo = (await mergeStatus({ client })).undo;
      renderUndo();
    },
    onError: (text) => fail({ userMessage: text }),
  });

  const renderChoices = () => {
    const apps = preview?.apps ?? [];
    const groups = [
      ["new", tr("New on this server")],
      ["already", tr("Already on this server")],
      ["different", tr("A different app with the same name")],
    ];
    const open = new Set([...ui.groups.querySelectorAll("details[open]")].map((d) => d.getAttribute("data-rm-app")));
    ui.groups.innerHTML = groups
      .map(([g, title]) => {
        const list = apps.filter((a) => groupOf(a) === g);
        if (!list.length) return "";
        return `<h3 class="mt-3" data-rm-group="${g}">${escapeHtml(title)}</h3><div class="card">${list.map((a) => appRowHtml(a, choices[a.archivedServiceId])).join("")}</div>`;
      })
      .join("");
    for (const id of open) ui.groups.querySelector(`details[data-rm-app="${CSS.escape(id)}"]`)?.setAttribute("open", "");
    const ok = canSignAdminOrders() && canRestore(choices);
    ui.restore.disabled = !ok;
    show(ui.hint, !ok);
  };

  ui.groups.addEventListener("change", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const id = t?.getAttribute("data-rm-action");
    if (!id) return;
    const app = preview.apps.find((a) => a.archivedServiceId === id);
    if (app) choices = choose(choices, app, t.value);
    renderChoices();
  });
  ui.groups.addEventListener("input", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const id = t?.getAttribute("data-rm-copy-name");
    if (!id || !choices[id]) return;
    choices = { ...choices, [id]: { ...choices[id], copyName: String(t.value).toLowerCase() } };
    show(ui.groups.querySelector(`[data-rm-copy-error="${CSS.escape(id)}"]`), !validCopySlug(choices[id].copyName));
    const ok = canSignAdminOrders() && canRestore(choices);
    ui.restore.disabled = !ok;
    show(ui.hint, !ok);
  });

  const renderRun = () => {
    show(ui.run, !!run);
    ui.run.innerHTML = (run?.apps ?? [])
      .map((a) => {
        const name = preview?.apps.find((p) => p.archivedServiceId === a.archivedServiceId)?.name ?? a.targetServiceId;
        const warn = a.step === "failed" || a.step === "refused-changed";
        return `<li class="list-row" data-rm-run-app="${escapeHtml(a.archivedServiceId)}"><span>${escapeHtml(name)}</span> <span class="faint-sm${warn ? " err-text" : ""}">${escapeHtml(stepText(a.step))}</span></li>`;
      })
      .join("");
  };

  ui.restore.addEventListener("click", async () => {
    if (ui.restore.disabled || phase !== "choosing") return;
    show(ui.error, false);
    ui.restore.disabled = true;
    try {
      const lines = planLines(preview, choices, serverDomain);
      await sendPlan({ client, serverDomain, restoreId: preview.restoreId, archiveId, sha256: dataSha, lines, sign: signer() });
    } catch (e) {
      fail(e);
      ui.restore.disabled = !canRestore(choices);
      return;
    }
    phase = "restoring";
    show(ui.choose, false);
    setStatus(tr("Restoring…"));
    ui.closeBtn.textContent = tr("Close");
    try {
      for (;;) {
        if (closed) return;
        const v = await mergeStatus({ client });
        run = v.run;
        undo = v.undo;
        renderRun();
        renderUndo();
        if (v.run?.state === "done") break;
        await sleep(1500);
      }
      phase = "done";
      setStatus(tr("Done"));
      ui.closeBtn.textContent = tr("Done");
    } catch (e) {
      fail(e);
    }
  });

  if (!canSignAdminOrders(session)) {
    failPhase({ userMessage: RESTORE_ADMIN_ONLY });
    return { dlg, close: finish };
  }
  if (!session?.umk) {
    failPhase({ userMessage: tr("Unlock the webapp first") });
    return { dlg, close: finish };
  }

  void (async () => {
    try {
      setStatus(tr("Opening the backup…"));
      let file;
      let data = null;
      if (source.kind === "saved") {
        const raw = await client.fetch(`/api/screens/server-archive/backups/${source.archiveId}/backup-file`);
        file = parseBackupFile(typeof raw === "string" ? raw : JSON.stringify(raw));
      } else {
        const split = await splitBundle(source.file);
        file = parseBackupFile(split.backupText);
        data = split.data;
      }
      const kek = await deriveServerArchiveKeyFromSeed(session.umk, file.archiveId);
      const opened = await openWithAccountKey(file, kek);
      if (!opened) throw Object.assign(new Error("not-this-account"), { userMessage: tr("This backup wasn't made by this account, so it can't be opened here.") });
      if (data && data.size !== opened.body.data.bytes) throw Object.assign(new Error("short"), { userMessage: tr("This backup is cut short: it ends before its data.") });
      archiveId = file.archiveId;
      dataSha = opened.body.data.sha256;
      if (closed) return;
      const started = await stageRestore({
        client,
        serverDomain,
        archiveId,
        bytes: opened.body.data.bytes,
        sha256: dataSha,
        source: data ? "upload" : "saved",
        sign: signer(),
      });
      staged = true;
      if (data) {
        phase = "sending";
        show(ui.bar);
        setStatus(tr("Sending the backup to {0}", serverDomain));
        await sendMergeData({
          client,
          blob: data,
          from: started.received,
          isCancelled,
          onBytes: (n, total) => {
            ui.bar.value = total ? Math.round((n / total) * 100) : 100;
          },
        });
        show(ui.bar, false);
      }
      phase = "checking";
      setStatus(tr("Checking the backup on {0}", serverDomain));
      await commitMerge({ client, contentKey: opened.contentKey });
      const v = await waitForPreview({ client, isCancelled });
      preview = v.preview;
      undo = v.undo;
      choices = defaultChoices(preview);
      phase = "choosing";
      setStatus("");
      if (preview.backup?.createdAt) {
        ui.backupAt.textContent = tr("Backup of {0}", fmtDate(preview.backup.createdAt));
        show(ui.backupAt);
      }
      show(ui.choose);
      renderChoices();
      renderUndo();
    } catch (e) {
      failPhase(e);
    }
  })();
  return { dlg, close: finish };
}
