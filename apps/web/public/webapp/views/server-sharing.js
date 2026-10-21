// The owner's "Shared with" and "Activity" cards on a server's page
// (docs/share-a-server.md §8, §9). Who has access comes from the box; links
// still being opened or confirmed come from `.com`, sealed to this account.

import { $ } from "../lib/router.js";
import { controlApex } from "../lib/apex.js";
import { findPod } from "../lib/deleteServer.js";
import { liveSync } from "../lib/liveSync.js";
import { getSession } from "../lib/state.js";
import { isCompanionProfile } from "../lib/companionGuard.js";
import { toast } from "../lib/toast.js";
import { inlineConfirm } from "../lib/modal.js";
import { formatWhen } from "../lib/dateFormat.js";
import { escapeHtml } from "../lib/util.js";
import { formatShareSas } from "../lib/serverShare.js";
import {
  DATA_LINE,
  DATA_TITLE,
  LEVEL_LINE,
  LEVEL_TEXT,
  UNLOCK_LINE,
  UNLOCK_TITLE,
  UNLOCK_WARNING,
  activityLine,
  cancelShareOffer,
  changeShare,
  confirmShare,
  createShareOffer,
  fetchActivity,
  loadOwnerShares,
  ownerShareLink,
  revokeShare,
  shareErrorText,
} from "../lib/serverShares.js";
import { accountReadFetch } from "../lib/accountRead.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { SHARE_ADMIN_ONLY, canSignAdminOrders } from "../lib/addServerGate.js";

import { tr } from "../lib/i18n.js";
const hasDisk = (body) => body?.diskEncryption !== "none";
const serverNameOf = (fqdn) => String(fqdn ?? "").split(".")[0] || String(fqdn ?? "");

export function serverSharingHtml(body) {
  const fqdn = escapeHtml(body.serverFqdn);
  return `
      <h2 class="mt-4">${tr("Shared with")}</h2>
      <div class="card" id="shared-with-card" data-server-fqdn="${fqdn}">
        <div id="shared-with-list"><p class="faint-sm">${tr("Loading…")}</p></div>
        ${isCompanionProfile()
          ? ""
          : canSignAdminOrders()
            ? `<button id="share-server-btn" class="full-width mt-2">${tr("Share this server")}</button>`
            : `<p class="note small mt-2" data-share-admin-only>${escapeHtml(SHARE_ADMIN_ONLY)}</p>`}
      </div>
      <h2 class="mt-4">${tr("Activity")}</h2>
      <div class="card" id="server-activity-card" data-server-fqdn="${fqdn}">
        <div id="server-activity-list"><p class="faint-sm">${tr("Loading…")}</p></div>
      </div>`;
}

let sharingFor = "";

export function wireServerSharing(body) {
  const fqdn = String(body?.serverFqdn ?? "").toLowerCase();
  sharingFor = fqdn;
  if (!$("shared-with-card") || !fqdn) return;
  $("share-server-btn")?.addEventListener("click", () => {
    openShareSheet(body).catch((e) => {
      console.error("share sheet failed", e);
      toast(shareErrorText(e), "err");
    });
  });
  void refreshShares(body);
  void refreshActivity(fqdn);
}

const current = (fqdn) => sharingFor === fqdn && !$("view-server-detail")?.classList.contains("hidden");

function optSwitch(shareId, key, on, title, disabled) {
  return `<label class="share-opt">
            <input type="checkbox" role="switch" data-share-opt="${key}" data-share-id="${escapeHtml(shareId)}"${on ? " checked" : ""}${disabled ? " disabled" : ""} />
            <span>${escapeHtml(title)}</span>
          </label>`;
}

function activeRow(s, { canEdit, disk }) {
  const seen = s.lastSeenAt ? tr("Last here {0}", formatWhen(s.lastSeenAt)) : tr("Hasn't signed in yet");
  const missingCopy = s.unlockAtBoot && s.unlockDeposited === false
    ? `<p class="warn-text text-sm mt-1">${tr("Their copy of the disk key didn't reach them. Turn start-up approval off and on to send it again.")}</p>`
    : "";
  return `
        <div class="share-row" data-share-row="${escapeHtml(s.shareId)}">
          <div class="share-row-head">
            <span class="share-row-name">${escapeHtml(s.label)}</span>
            ${canEdit
              ? `<select class="share-level" data-share-level data-share-id="${escapeHtml(s.shareId)}" aria-label="${tr("What {0} can do", escapeHtml(s.label))}">
                  <option value="view"${s.level === "view" ? " selected" : ""}>${LEVEL_TEXT.view}</option>
                  <option value="manage"${s.level === "manage" ? " selected" : ""}>${LEVEL_TEXT.manage}</option>
                </select>`
              : `<span class="pill">${escapeHtml(LEVEL_TEXT[s.level] ?? s.level)}</span>`}
          </div>
          ${disk ? optSwitch(s.shareId, "unlockAtBoot", s.unlockAtBoot, UNLOCK_TITLE, !canEdit) : ""}
          ${optSwitch(s.shareId, "seeAppData", s.seeAppData, DATA_TITLE, !canEdit)}
          ${missingCopy}
          <div class="row mt-1">
            <span class="faint-sm">${escapeHtml(seen)}</span>
            ${canEdit ? `<button class="secondary danger btn-xs" data-share-remove="${escapeHtml(s.shareId)}">${tr("Remove")}</button>` : ""}
          </div>
        </div>`;
}

function awaitingRow(a, canEdit) {
  if (a.broken) {
    return `
        <div class="share-row" data-share-row="${escapeHtml(a.shareId)}">
          <p class="warn-text text-sm">${tr("Someone opened the link for <strong>{0}</strong>, but their answer didn't check out. Cancel this link and send a new one.", escapeHtml(a.label))}</p>
          ${canEdit ? `<button class="secondary btn-xs mt-1" data-share-cancel="${escapeHtml(a.shareId)}">${tr("Cancel link")}</button>` : ""}
        </div>`;
  }
  return `
        <div class="share-row share-row--confirm" data-share-row="${escapeHtml(a.shareId)}">
          <p class="text-sm">${tr("<strong>{0}</strong> accepted. Does their phone show this code?", escapeHtml(a.label))}</p>
          <p class="share-sas mono" data-share-sas>${escapeHtml(formatShareSas(a.sas))}</p>
          ${canEdit
            ? `<div class="row-2 mt-1">
                <button class="secondary" data-share-cancel="${escapeHtml(a.shareId)}">${tr("No, cancel")}</button>
                <button data-share-confirm="${escapeHtml(a.shareId)}">${tr("Yes, confirm")}</button>
              </div>`
            : ""}
        </div>`;
}

function offeredRow(o, canEdit) {
  const text = o.expired
    ? `${tr("The link for <strong>{0}</strong> expired.", escapeHtml(o.label))}`
    : `${tr("Waiting for <strong>{0}</strong> to open the link.", escapeHtml(o.label))}`;
  return `
        <div class="share-row" data-share-row="${escapeHtml(o.shareId)}">
          <p class="text-sm">${text}</p>
          ${canEdit
            ? `<div class="row-2 mt-1">
                ${o.expired ? "" : `<button class="secondary" data-share-copy="${escapeHtml(o.shareId)}">${tr("Copy link")}</button>`}
                <button class="secondary" data-share-cancel="${escapeHtml(o.shareId)}">${o.expired ? "Remove" : "Cancel"}</button>
              </div>`
            : ""}
        </div>`;
}

function endedLine(e) {
  const who = escapeHtml(e.label || "Someone");
  return `<p class="faint-sm">${e.reason === "left" ? `${who} left` : tr("You removed {0}", who)} · ${escapeHtml(formatWhen(e.endedAt))}</p>`;
}

/** The card's list. Pure so tests and screenshots can render it. */
export function sharesListHtml(state, { canEdit = true, disk = true } = {}) {
  const rows = [
    ...state.awaiting.map((a) => awaitingRow(a, canEdit)),
    ...state.active.map((s) => activeRow(s, { canEdit, disk })),
    ...state.offered.map((o) => offeredRow(o, canEdit)),
  ];
  const notes = [];
  if (state.boxError) notes.push(`<p class="warn-text text-sm">${tr("Couldn't reach this server, so people with access aren't listed.")}</p>`);
  if (state.comError && canEdit) notes.push(`<p class="warn-text text-sm">${tr("Couldn't load links you've sent.")}</p>`);
  const body = rows.length
    ? rows.join("")
    : state.boxError ? "" : `<p class="note">${tr("Not shared with anyone. Share it to let another Flagship account see or manage it with their own account.")}</p>`;
  return `${notes.join("")}${body}${state.ended?.length ? `<div class="mt-2">${state.ended.map(endedLine).join("")}</div>` : ""}`;
}

async function refreshShares(body) {
  const fqdn = String(body.serverFqdn).toLowerCase();
  const slot = $("shared-with-list");
  if (!slot) return;
  // Every change here signs under the admin root (lib/adminRoot.js).
  const canEdit = !isCompanionProfile() && !!getSession()?.umk && canSignAdminOrders();
  let state;
  try {
    state = await loadOwnerShares(fqdn);
  } catch (e) {
    if (current(fqdn)) slot.innerHTML = `<p class="err-text">${escapeHtml(shareErrorText(e))}</p>`;
    return;
  }
  if (!current(fqdn) || !$("shared-with-list")) return;
  $("shared-with-list").innerHTML = sharesListHtml(state, { canEdit, disk: hasDisk(body) });
  wireRows(body, state);
  // Finish a Remove (or a Leave) that reached only the box, so `.com` drops
  // the start-up copy too.
  if (canEdit) for (const id of state.unfinished ?? []) void cancelShareOffer(fqdn, id).catch(() => {});
}

function wireRows(body, state) {
  const fqdn = String(body.serverFqdn).toLowerCase();
  const root = $("shared-with-list");
  if (!root) return;
  const byId = (list, id) => list.find((x) => x.shareId === id);
  const reload = () => refreshShares(body).then(() => refreshActivity(fqdn));
  const busy = async (el, fn) => {
    el.disabled = true;
    try {
      await fn();
    } catch (e) {
      console.error("share action failed", e);
      toast(shareErrorText(e), "err");
    } finally {
      el.disabled = false;
    }
    await reload();
  };

  root.querySelectorAll("[data-share-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = byId(state.awaiting, btn.getAttribute("data-share-confirm"));
      if (!a) return;
      void busy(btn, async () => {
        const unlocked = await freshShareUnlock({
          title: tr("Give {0} access?", a.label),
          message: tr("{0} will {1} {2}.", a.label, a.level === "manage" ? "manage" : "see", serverNameOf(fqdn)),
          okLabel: tr("Give access"),
        });
        if (!unlocked) return;
        const r = await confirmShare(fqdn, a);
        toast(`${a.label} can now ${a.level === "manage" ? "manage" : "see"} this server`, "ok");
        if (r.unlockError) toast(tr("Start-up approval isn't set up yet: {0}", shareErrorText(r.unlockError)), "err");
      });
    });
  });
  root.querySelectorAll("[data-share-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-share-cancel");
      const row = byId(state.awaiting, id) ?? byId(state.offered, id);
      const ok = await inlineConfirm({
        title: tr("Cancel this link?"),
        message: tr("The link you sent {0} stops working. You can send a new one.", row?.label ?? "them"),
        okLabel: tr("Cancel link"),
        cancelLabel: tr("Keep it"),
        danger: true,
      });
      if (ok) void busy(btn, () => cancelShareOffer(fqdn, id));
    });
  });
  root.querySelectorAll("[data-share-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const o = byId(state.offered, btn.getAttribute("data-share-copy"));
      if (o) void copyLink(ownerShareLink(o));
    });
  });
  root.querySelectorAll("[data-share-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const s = byId(state.active, btn.getAttribute("data-share-remove"));
      if (!s) return;
      const ok = await inlineConfirm({
        title: tr("Remove {0}?", s.label),
        message: tr("{0} loses access to {1} right away.{2}", s.label, serverNameOf(fqdn), s.unlockAtBoot ? tr(" Their copy of the disk key is deleted, but a copy they already used can't be taken back.") : ""),
        okLabel: tr("Remove"),
        danger: true,
      });
      if (ok) void busy(btn, () => revokeShare(fqdn, s.shareId).then(() => toast(tr("Removed {0}", s.label), "ok")));
    });
  });
  root.querySelectorAll("[data-share-level]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const s = byId(state.active, sel.getAttribute("data-share-id"));
      if (!s) return;
      const level = sel.value;
      void busy(sel, async () => {
        if (level === "manage") {
          const unlocked = await freshShareUnlock({
            title: tr("Let {0} manage {1}?", s.label, serverNameOf(fqdn)),
            message: LEVEL_LINE.manage,
            okLabel: tr("Allow"),
          });
          if (!unlocked) {
            sel.value = s.level;
            return;
          }
        }
        await changeShare(fqdn, s, { level });
      });
    });
  });
  root.querySelectorAll("[data-share-opt]").forEach((box) => {
    box.addEventListener("change", async () => {
      const s = byId(state.active, box.getAttribute("data-share-id"));
      if (!s) return;
      const key = box.getAttribute("data-share-opt");
      const on = box.checked;
      if (on) {
        const unlocked = await freshShareUnlock(
          key === "unlockAtBoot"
            ? {
                title: tr("Let {0} approve start-up?", s.label),
                message: tr("{0} They can unlock {1} when it starts. {2}", UNLOCK_LINE, serverNameOf(fqdn), UNLOCK_WARNING),
                okLabel: tr("Allow"),
              }
            : { title: tr("Let {0} see app data?", s.label), message: DATA_LINE, okLabel: tr("Allow") },
        );
        if (!unlocked) {
          box.checked = false;
          return;
        }
      }
      void busy(box, () => changeShare(fqdn, s, { [key]: on }));
    });
  });
}

async function refreshActivity(fqdn) {
  const slot = $("server-activity-list");
  if (!slot) return;
  let entries;
  try {
    entries = await fetchActivity(fqdn);
  } catch {
    if (current(fqdn)) slot.innerHTML = `<p class="faint-sm">${tr("Couldn't load activity from this server.")}</p>`;
    return;
  }
  if (!current(fqdn) || !$("server-activity-list")) return;
  $("server-activity-list").innerHTML = activityHtml(entries);
}

export function activityHtml(entries) {
  if (!entries.length) return `<p class="note">${tr("Nothing yet. Changes made on this server show up here.")}</p>`;
  return entries
    .map(
      (e) => `
        <div class="row activity-row">
          <span class="value text-sm">${escapeHtml(activityLine(e))}</span>
          <span class="faint-sm">${escapeHtml(formatWhen(e.ts))}</span>
        </div>`,
    )
    .join("");
}

async function stkFor(fqdn, username) {
  const fromSnap = findPod(liveSync.get?.()?.pods, fqdn);
  if (fromSnap?.identityPubKey) return String(fromSnap.identityPubKey);
  if (!username) return "";
  try {
    const r = await accountReadFetch(`${controlApex()}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" });
    const b = r.ok ? await r.json() : {};
    return String(findPod(b.pods, fqdn)?.identityPubKey ?? "");
  } catch {
    return "";
  }
}

async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast(tr("Link copied"), "ok");
  } catch {
    toast(tr("Couldn't copy. Select the link and copy it yourself."), "err");
  }
}

async function shareLink(link, label) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: tr("A Flagship server for {0}", label), url: link });
    } catch {
      /* cancelled */
    }
  } else {
    await copyLink(link);
  }
}

/** The "Share this server" sheet: name → level → opt-ins → link, QR, Share. */
export async function openShareSheet(body) {
  const session = getSession();
  if (!session?.umk) {
    toast(tr("Unlock the webapp first"), "err");
    return;
  }
  const fqdn = String(body.serverFqdn).toLowerCase();
  const name = serverNameOf(fqdn);
  const disk = hasDisk(body);
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card share-sheet";
  dlg.setAttribute("aria-label", tr("Share this server"));
  dlg.innerHTML = `
    <h3 class="modal-title">${tr("Share {0}", escapeHtml(name))}</h3>
    <div data-share-stage="form">
      <p class="modal-message">${tr("Another Flagship account gets access with their own account. They never get yours.")}</p>
      <label for="share-label">${tr("Their name")}</label>
      <input id="share-label" type="text" class="full-width" maxlength="64" autocomplete="off" placeholder="${tr("Sam")}" data-share-label />
      <p class="faint-sm">${tr("Only you and this server see it.")}</p>
      <label class="mt-3">${tr("What they can do")}</label>
      <label class="share-choice"><input type="radio" name="share-level" value="view" checked />
        <span class="share-choice-text"><strong>${LEVEL_TEXT.view}</strong><span class="faint-sm">${escapeHtml(LEVEL_LINE.view)}</span></span></label>
      <label class="share-choice"><input type="radio" name="share-level" value="manage" />
        <span class="share-choice-text"><strong>${LEVEL_TEXT.manage}</strong><span class="faint-sm">${escapeHtml(LEVEL_LINE.manage)}</span></span></label>
      <label class="mt-3">${tr("Also")}</label>
      ${disk ? `<label class="share-choice"><input type="checkbox" data-share-unlock />
        <span class="share-choice-text"><strong>${escapeHtml(UNLOCK_TITLE)}</strong><span class="faint-sm">${escapeHtml(UNLOCK_LINE)}</span><span class="faint-sm" data-share-unlock-warning>${escapeHtml(UNLOCK_WARNING)}</span></span></label>` : ""}
      <label class="share-choice"><input type="checkbox" data-share-data />
        <span class="share-choice-text"><strong>${escapeHtml(DATA_TITLE)}</strong><span class="faint-sm">${escapeHtml(DATA_LINE)}</span></span></label>
      <p class="modal-error err-text hidden" data-share-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-share-close>${tr("Cancel")}</button>
        <button data-share-create disabled>${tr("Create link")}</button>
      </div>
    </div>
    <div data-share-stage="link" class="hidden">
      <p class="modal-message" data-share-sent></p>
      <div class="share-qr" data-share-qr></div>
      <input class="full-width mono text-xs" readonly data-share-link aria-label="${tr("Share link")}" />
      <div class="row-2 mt-2">
        <button class="secondary" data-share-copy-link>${tr("Copy link")}</button>
        <button data-share-send>${tr("Share")}</button>
      </div>
      <button class="secondary full-width mt-2" data-share-done>${tr("Done")}</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal?.();
  const q = (sel) => dlg.querySelector(sel);
  const close = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  let created = null;
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (created) void refreshShares(body);
  });
  q("[data-share-close]").addEventListener("click", close);
  q("[data-share-done]").addEventListener("click", close);
  const labelEl = q("[data-share-label]");
  const go = q("[data-share-create]");
  labelEl.addEventListener("input", () => {
    go.disabled = labelEl.value.trim().length === 0;
  });
  go.addEventListener("click", async () => {
    const err = q("[data-share-error]");
    err.classList.add("hidden");
    const label = labelEl.value;
    const level = dlg.querySelector('input[name="share-level"]:checked')?.value === "manage" ? "manage" : "view";
    const unlocked = await confirmFreshUnlock(
      {
        title: tr("Share {0} with {1}?", name, label.trim()),
        message: tr("They'll {0} it with their own account.", level === "manage" ? "manage" : "see"),
        okLabel: tr("Create link"),
      },
      { prompt: sheetPrompt(dlg) },
    );
    if (!unlocked.ok) {
      if (!unlocked.cancelled) {
        err.textContent = unlocked.error;
        err.classList.remove("hidden");
      }
      return;
    }
    go.disabled = true;
    go.textContent = tr("Signing…");
    try {
      created = await createShareOffer({
        serverDomain: fqdn,
        serverName: name,
        stkPubHex: await stkFor(fqdn, session.username),
        label,
        level,
        unlockAtBoot: !!q("[data-share-unlock]")?.checked,
        seeAppData: !!q("[data-share-data]")?.checked,
      });
      showLink(dlg, created);
    } catch (e) {
      err.textContent = shareErrorText(e);
      err.classList.remove("hidden");
      go.disabled = false;
      go.textContent = tr("Create link");
    }
  });
  return dlg;
}

/** One fresh unlock before an admin-root-signed share grant (owner rule: one
 *  biometric per invite). Turning things off and withdrawing use the session. */
async function freshShareUnlock(opts) {
  const r = await confirmFreshUnlock(opts);
  if (r.ok) return true;
  if (!r.cancelled) toast(r.error, "err");
  return false;
}

/** The share sheet's own passphrase step, in place of lib/modal.js's prompt
 *  (an overlay would sit under the open <dialog>). Same contract: resolves
 *  the typed passphrase, or null on Cancel. */
function sheetPrompt(dlg) {
  return ({ title, message, okLabel = "Confirm" }) =>
    new Promise((resolve) => {
      const form = dlg.querySelector('[data-share-stage="form"]');
      const stage = document.createElement("div");
      stage.setAttribute("data-share-stage", "unlock");
      stage.innerHTML = `
        <p class="modal-title" data-share-unlock-title>${escapeHtml(title)}</p>
        <p class="modal-message" data-share-unlock-message>${escapeHtml(message)}</p>
        <input type="password" class="full-width" autocomplete="current-password" placeholder="${tr("Passphrase")}" aria-label="${tr("Passphrase")}" data-share-passphrase />
        <div class="row-2 mt-3">
          <button class="secondary" data-share-unlock-cancel>${tr("Cancel")}</button>
          <button data-share-unlock-ok>${escapeHtml(okLabel)}</button>
        </div>`;
      form.classList.add("hidden");
      form.after(stage);
      const input = stage.querySelector("[data-share-passphrase]");
      const done = (v) => {
        stage.remove();
        form.classList.remove("hidden");
        resolve(v);
      };
      stage.querySelector("[data-share-unlock-ok]").addEventListener("click", () => done(input.value));
      stage.querySelector("[data-share-unlock-cancel]").addEventListener("click", () => done(null));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          done(input.value);
        }
      });
      input.focus();
    });
}

function showLink(dlg, created) {
  const q = (sel) => dlg.querySelector(sel);
  q('[data-share-stage="form"]').classList.add("hidden");
  q('[data-share-stage="link"]').classList.remove("hidden");
  q("[data-share-sent]").textContent =
    tr("{0}When they open it, their phone shows a 6-digit code: check it with them here before they get access.", tr("Send this link to {0}. It works once and expires in 7 days. ", created.label));
  q("[data-share-link]").value = created.link;
  q("[data-share-copy-link]").addEventListener("click", () => void copyLink(created.link));
  q("[data-share-send]").addEventListener("click", () => void shareLink(created.link, created.label));
  void (async () => {
    try {
      const m = await import("/qrEncoder.js");
      q("[data-share-qr]").innerHTML = m.renderQrSvg(created.link, { size: 200, foreground: "#0f172a", background: "#ffffff" });
    } catch {
      q("[data-share-qr]").innerHTML = "";
    }
  })();
}
