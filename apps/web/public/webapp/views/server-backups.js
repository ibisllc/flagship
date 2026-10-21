// The server page's Backups section (docs/server-backup-and-clone.md): the
// backup policy with its size limit, the scheduled backups (last / next run,
// the schedule, the saved list with Download and Delete) and Back up now into
// the list. The passcode Backup/clone and Migrate stay one-off buttons below.

import { $ } from "../lib/router.js";
import { boxClient } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { SERVER_ADMIN_ONLY, canSignAdminOrders } from "../lib/addServerGate.js";
import { boxErrorText } from "../lib/humanError.js";
import { toast } from "../lib/toast.js";
import { inlineConfirm } from "../lib/modal.js";
import { escapeHtml } from "../lib/util.js";
import { formatBytes } from "../lib/serverArchive.js";
import { serverStorageNotes } from "../lib/appStorage.js";
import {
  DEFAULT_WEB_RESERVE_GB,
  POLICY_LABEL,
  POLICY_TEXT,
  WEB_RESERVE_NOTE,
  fetchPolicy,
  formatGb,
  peerLines,
  policiesOffered,
  policyLine,
  setPolicy,
  usageFraction,
  usageLine,
} from "../lib/backupPolicy.js";
import {
  DELETE_CONFIRM,
  SAVED_FILES_NOTE,
  deleteSaved,
  depositKeys,
  downloadSaved,
  localToUtc,
  putSchedule,
  rowText,
  runNow,
  savedView,
  scheduleLine,
  shouldDepositKeys,
  statusLines,
  utcToLocal,
} from "../lib/savedBackups.js";

import { tr, dateLocale } from "../lib/i18n.js";
import { weekdayName } from "../lib/savedBackups.js";
const GB = 1024 ** 3;
const fmtTime = (t) => new Date(t).toLocaleString(dateLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function backupsSectionHtml(body) {
  const admin = canSignAdminOrders();
  const policies = ["phone", "peer", "none"]
    .map(
      (p) => `
        <label class="boot-unlock-option${policiesOffered(null).includes(p) ? "" : " hidden"}" data-bk-policy-option="${p}">
          <input type="radio" name="bk-policy" value="${p}" />
          <span class="boot-unlock-title">${escapeHtml(POLICY_LABEL[p])}</span>
          <span class="boot-unlock-desc faint-sm">${escapeHtml(POLICY_TEXT[p])}</span>
        </label>`,
    )
    .join("");
  return `
      <h2 class="mt-4">${tr("Backups")}</h2>
      <div class="card" id="backups-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note small hidden" id="bk-unavailable"></p>
        <div class="row">
          <span class="label">${tr("Backup policy")}</span>
          <span class="value" id="bk-policy-value">…</span>
        </div>
        <progress id="bk-usage-bar" class="full-width hidden" max="1" value="0"></progress>
        <p class="note small" id="bk-usage-line"></p>
        <p class="note small err hidden" id="bk-over" role="alert"></p>
        ${serverStorageNotes(body.storage).map((t) => `<p class="note small err" data-bk-storage>${escapeHtml(t)}</p>`).join("")}
        <div class="note small hidden" id="bk-peer"></div>
        <button id="bk-policy-change" class="secondary full-width mt-2"${admin ? "" : " disabled"}>${tr("Change backup policy")}</button>
        <div id="bk-policy-editor" class="hidden mt-2">
          <div class="boot-unlock-options">${policies}</div>
          <div id="bk-reserve-row" class="mt-2">
            <label class="caption" for="bk-reserve-gb">${tr("Space kept on that device (GB)")}</label>
            <input id="bk-reserve-gb" type="number" min="1" max="4096" step="1" value="${DEFAULT_WEB_RESERVE_GB}" class="full-width" />
            <p class="faint-sm">${escapeHtml(WEB_RESERVE_NOTE)}</p>
          </div>
          <p class="note small err hidden" id="bk-policy-error" role="alert"></p>
          <div class="row-2 mt-2">
            <button class="secondary" id="bk-policy-cancel">${tr("Cancel")}</button>
            <button id="bk-policy-save">${tr("Save")}</button>
          </div>
        </div>

        <p class="mt-3" id="bk-status">…</p>
        <p class="note small err hidden" id="bk-failed" role="alert"></p>
        <p class="note small" id="bk-next"></p>
        <div class="row" id="bk-schedule-row">
          <span class="value" id="bk-schedule-line"></span>
        </div>
        <button id="bk-schedule-change" class="secondary full-width mt-2"${admin ? "" : " disabled"}>${tr("Change schedule")}</button>
        <div id="bk-schedule-editor" class="hidden mt-2">
          <label class="caption" for="bk-frequency">${tr("How often")}</label>
          <select id="bk-frequency" class="full-width">
            <option value="daily">${tr("Daily")}</option>
            <option value="weekly">${tr("Weekly")}</option>
            <option value="off">${tr("Off")}</option>
          </select>
          <div id="bk-weekday-row" class="hidden">
            <label class="caption" for="bk-weekday">${tr("Day")}</label>
            <select id="bk-weekday" class="full-width">
              ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<option value="${i}">${weekdayName(i)}</option>`).join("")}
            </select>
          </div>
          <label class="caption" for="bk-time">${tr("Time")}</label>
          <input id="bk-time" type="time" class="full-width" value="03:00" />
          <label class="caption" for="bk-keep-daily">${tr("Keep daily backups")}</label>
          <input id="bk-keep-daily" type="number" min="0" max="60" step="1" value="7" class="full-width" />
          <label class="caption" for="bk-keep-weekly">${tr("Keep weekly backups")}</label>
          <input id="bk-keep-weekly" type="number" min="0" max="52" step="1" value="4" class="full-width" />
          <p class="note small err hidden" id="bk-schedule-error" role="alert"></p>
          <div class="row-2 mt-2">
            <button class="secondary" id="bk-schedule-cancel">${tr("Cancel")}</button>
            <button id="bk-schedule-save">${tr("Save")}</button>
          </div>
        </div>
        <button id="bk-approve-keys" class="full-width mt-2 hidden">${tr("Approve backups for this server")}</button>
        <button id="bk-run-now" class="full-width mt-2"${admin ? "" : " disabled"}>${tr("Back up now")}</button>
        <ul class="list mt-2" id="bk-list"></ul>
        <p class="faint-sm mt-2">${escapeHtml(SAVED_FILES_NOTE)}</p>
        ${admin ? "" : `<p class="note small mt-1" data-backups-admin-only>${escapeHtml(SERVER_ADMIN_ONLY)}</p>`}
      </div>`;
}

function show(el, on) {
  el?.classList.toggle("hidden", !on);
}

/** Wire the section: load both views, keep the pool topped up, poll while a backup runs. */
export function wireBackupsSection(body, deps = {}) {
  const fqdn = body.serverFqdn;
  const client = deps.client ?? boxClient(fqdn);
  const admin = canSignAdminOrders();
  let policyView = null;
  let saved = null;
  let pollTimer = null;
  let depositing = false;

  const renderPolicy = () => {
    const v = policyView;
    $("bk-policy-value").textContent = v ? policyLine(v) : "…";
    const frac = usageFraction(v);
    const bar = $("bk-usage-bar");
    if (bar) {
      show(bar, frac !== null);
      if (frac !== null) bar.value = frac;
    }
    $("bk-usage-line").textContent = v ? usageLine(v) : "";
    const over = $("bk-over");
    over.textContent = v?.cap?.overLimit ? v.cap.overReason || "" : "";
    show(over, !!v?.cap?.overLimit);
    const peer = $("bk-peer");
    const lines = peerLines(v?.peer, { formatTime: fmtTime });
    peer.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
    show(peer, lines.length > 0);
    $("bk-policy-change").textContent = v?.policy?.policy === "unset" ? tr("Choose a backup policy") : tr("Change backup policy");
  };

  const renderSaved = () => {
    const v = saved;
    if (!v) return;
    const lines = statusLines(v, { formatBytes, formatTime: fmtTime });
    $("bk-status").textContent = lines.status;
    $("bk-failed").textContent = lines.failed;
    show($("bk-failed"), !!lines.failed);
    $("bk-next").textContent = lines.next;
    const active = v.scheduleActive !== false;
    $("bk-schedule-line").textContent = active ? scheduleLine(v.schedule) : "";
    show($("bk-schedule-row"), active);
    show($("bk-schedule-change"), active);
    show($("bk-approve-keys"), admin && Number(v.keysWanted) > 0 && Number(v.keysLeft) === 0);
    $("bk-run-now").disabled = !admin || !!v.running;
    const list = $("bk-list");
    list.innerHTML = (v.backups ?? [])
      .map((b) => {
        const t = rowText(b, { formatBytes, formatTime: fmtTime });
        return `<li class="list-row" data-bk-id="${escapeHtml(b.archiveId)}">
          <div>${escapeHtml(t.main)}</div>
          ${t.left ? `<div class="faint-sm">${escapeHtml(t.left)}</div>` : ""}
          <div class="row-2 mt-1">
            <button class="secondary" data-bk-download="${escapeHtml(b.archiveId)}">${tr("Download")}</button>
            <button class="danger" data-bk-delete="${escapeHtml(b.archiveId)}"${admin ? "" : " disabled"}>${tr("Delete")}</button>
          </div>
        </li>`;
      })
      .join("");
  };

  const fail = (e, where = null) => {
    const text = boxErrorText(e);
    if (where) {
      where.textContent = text;
      show(where, true);
    } else toast(text, "err");
  };

  async function topUp() {
    const session = getSession();
    if (depositing || !saved || !shouldDepositKeys(saved, admin) || !session?.umk) return;
    depositing = true;
    try {
      saved = await depositKeys({
        client,
        serverDomain: fqdn,
        umk: session.umk,
        count: saved.keysWanted,
        sign: (bytes) => sensitiveSigner()(session.umk, bytes),
      });
      renderSaved();
    } finally {
      depositing = false;
    }
  }

  async function load() {
    try {
      [policyView, saved] = await Promise.all([fetchPolicy({ client }), savedView({ client })]);
    } catch (e) {
      const u = $("bk-unavailable");
      u.textContent = e?.status === 404 ? tr("This server needs an update to show its backups.") : boxErrorText(e);
      show(u, true);
      return;
    }
    renderPolicy();
    renderSaved();
    // An admin device keeps the server's keys topped up without asking (the webapp is already unlocked).
    await topUp().catch((e) => fail(e));
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!saved?.running) return;
    pollTimer = setTimeout(async () => {
      if (!document.body.contains($("backups-card"))) return;
      try {
        saved = await savedView({ client });
        renderSaved();
      } catch {
        /* the next load shows it */
      }
      schedulePoll();
    }, 2000);
  }

  // ---- policy editor ----
  const syncReserveRow = () => {
    const p = document.querySelector('input[name="bk-policy"]:checked')?.value;
    show($("bk-reserve-row"), p === "phone");
  };
  $("bk-policy-change")?.addEventListener("click", () => {
    if (!admin) return;
    const p = policyView?.policy?.policy;
    const want = p && p !== "unset" ? p : "phone";
    for (const el of document.querySelectorAll('input[name="bk-policy"]')) el.checked = el.value === want;
    // Peer is offered only to a server that is already on it.
    for (const opt of document.querySelectorAll("[data-bk-policy-option]")) opt.classList.toggle("hidden", !policiesOffered(p).includes(opt.dataset.bkPolicyOption));
    if (policyView?.policy?.phoneReserveBytes) $("bk-reserve-gb").value = String(Math.round(policyView.policy.phoneReserveBytes / GB));
    show($("bk-policy-error"), false);
    syncReserveRow();
    show($("bk-policy-editor"), true);
  });
  for (const el of document.querySelectorAll('input[name="bk-policy"]')) el.addEventListener("change", syncReserveRow);
  $("bk-policy-cancel")?.addEventListener("click", () => show($("bk-policy-editor"), false));
  $("bk-policy-save")?.addEventListener("click", async () => {
    const session = getSession();
    const policy = document.querySelector('input[name="bk-policy"]:checked')?.value;
    if (!policy || !session?.umk) return;
    const btn = $("bk-policy-save");
    btn.disabled = true;
    try {
      policyView = await setPolicy({
        client,
        serverDomain: fqdn,
        policy,
        reserveGb: Number($("bk-reserve-gb").value),
        sign: (bytes) => sensitiveSigner()(session.umk, bytes),
      });
      renderPolicy();
      show($("bk-policy-editor"), false);
      saved = await savedView({ client }).catch(() => saved);
      renderSaved();
      toast(tr("Backup policy: {0}", POLICY_LABEL[policy]), "ok");
    } catch (e) {
      fail(e, $("bk-policy-error"));
    } finally {
      btn.disabled = false;
    }
  });

  // ---- schedule editor ----
  const syncWeekday = () => show($("bk-weekday-row"), $("bk-frequency").value === "weekly");
  $("bk-frequency")?.addEventListener("change", syncWeekday);
  $("bk-schedule-change")?.addEventListener("click", () => {
    if (!admin || !saved) return;
    const s = saved.schedule;
    const l = utcToLocal(s);
    $("bk-frequency").value = s.frequency;
    $("bk-weekday").value = String(l.weekday);
    $("bk-time").value = `${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
    $("bk-keep-daily").value = String(s.keepDaily);
    $("bk-keep-weekly").value = String(s.keepWeekly);
    show($("bk-schedule-error"), false);
    syncWeekday();
    show($("bk-schedule-editor"), true);
  });
  $("bk-schedule-cancel")?.addEventListener("click", () => show($("bk-schedule-editor"), false));
  $("bk-schedule-save")?.addEventListener("click", async () => {
    const [hour, minute] = String($("bk-time").value || "03:00").split(":").map(Number);
    const frequency = $("bk-frequency").value;
    const utc = localToUtc({ hour, minute, weekday: Number($("bk-weekday").value), frequency });
    const schedule = {
      frequency,
      minuteOfDayUtc: utc.minuteOfDayUtc,
      weekdayUtc: utc.weekdayUtc,
      keepDaily: Number($("bk-keep-daily").value),
      keepWeekly: Number($("bk-keep-weekly").value),
    };
    try {
      saved = await putSchedule({ client, schedule });
      renderSaved();
      show($("bk-schedule-editor"), false);
    } catch (e) {
      fail(e, $("bk-schedule-error"));
    }
  });

  // ---- keys, run, list ----
  $("bk-approve-keys")?.addEventListener("click", () => topUp().catch((e) => fail(e)));
  $("bk-run-now")?.addEventListener("click", async () => {
    if (!admin) return;
    try {
      await runNow({ client });
    } catch (e) {
      if (e?.body?.code === "no-keys" && admin) {
        await topUp();
        await runNow({ client }).catch((e2) => fail(e2));
      } else {
        fail(e);
        return;
      }
    }
    saved = await savedView({ client }).catch(() => saved);
    renderSaved();
    schedulePoll();
  });
  $("bk-list")?.addEventListener("click", async (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const dl = target?.closest("[data-bk-download]");
    const del = target?.closest("[data-bk-delete]");
    const session = getSession();
    if (dl) {
      if (!session?.umk) return toast(tr("Unlock the webapp first"), "err");
      try {
        await downloadSaved({ client, serverDomain: fqdn, archiveId: dl.getAttribute("data-bk-download"), umk: session.umk, signWithIrk: sensitiveSigner() });
      } catch (e) {
        fail(e);
      }
    } else if (del && admin) {
      const ok = await inlineConfirm({ title: tr("Delete backup"), message: DELETE_CONFIRM, okLabel: tr("Delete"), danger: true });
      if (!ok) return;
      try {
        saved = await deleteSaved({ client, archiveId: del.getAttribute("data-bk-delete") });
        renderSaved();
      } catch (e) {
        fail(e);
      }
    }
  });

  void load();
  return { reload: load, formatGb };
}
