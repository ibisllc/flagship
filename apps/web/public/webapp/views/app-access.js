// A live app's access list (docs/ai-privacy-and-staging.md §3a): the hosts it
// may reach, one allow/deny rule per line. The editor parses as you type and
// shows each error by its line; Save stays off while there are errors (or
// nothing changed), then signs the list with the sensitive-order key and sends
// it. A companion session sees the list read-only. Opened with `{draft: true}`
// (Review on a suggested list), the editor starts from the box's draft; saving
// it is the normal signed POST, which clears the draft on the box.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { isCompanionProfile } from "../lib/companionGuard.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { podServerDomain } from "../lib/accessAlerts.js";
import {
  ACCESS_COMPANION_NOTE,
  ACCESS_DRAFT_EDITOR_NOTE,
  ACCESS_LIST_HELP,
  ACCESS_SAVE,
  accessEditorState,
  accessErrorMessage,
  fetchServiceAccess,
  ruleCountText,
  sendAccessList,
} from "../lib/appAccess.js";

registerView("view-app-access");

let current = null;

function errorsHtml(errors) {
  if (errors.length === 0) return "";
  return `<ul class="access-errors">${errors
    .map((e) => `<li class="err-text text-sm"><span class="mono">Line ${e.line}</span>: ${escapeHtml(e.message)}</li>`)
    .join("")}</ul>`;
}

function paintState(state) {
  const errs = $("app-access-errors");
  if (errs) errs.innerHTML = errorsHtml(state.errors);
  const count = $("app-access-count");
  if (count) count.textContent = state.errors.length > 0 ? "" : ruleCountText(state.rules);
  const save = $("app-access-save");
  if (save) save.disabled = !state.canSave;
}

export async function renderAppAccess(serviceId, appName, { draft = false } = {}) {
  current = { serviceId, appName: appName || serviceId, list: "", draft };
  const title = $("app-access-title");
  if (title) title.textContent = `${current.appName}: access list`;
  const root = $("app-access-content");
  root.innerHTML = skeletonCards(1);
  const companion = isCompanionProfile();
  let access;
  try {
    access = await fetchServiceAccess(serviceId, (path, init) => screensFetch(path, init));
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(
      e instanceof ScreensError ? accessErrorMessage(e) : humanError(e),
    )}</p></div>`;
    return;
  }
  if (!access) {
    root.innerHTML = `<div class="card"><p class="err-text">This server doesn't support access lists yet. Update it first.</p></div>`;
    return;
  }
  current.list = access.list;
  const fromDraft = draft && !!access.draft;
  const text = fromDraft ? access.draft.list : access.list;
  root.innerHTML = `
    <div class="card">
      ${fromDraft ? `<p class="note" data-access-draft-note>${escapeHtml(ACCESS_DRAFT_EDITOR_NOTE)}</p>` : ""}
      <p class="note">${escapeHtml(ACCESS_LIST_HELP)}</p>
      <textarea id="app-access-text" class="access-editor mt-2" rows="12" spellcheck="false" autocapitalize="off"
        autocomplete="off" aria-label="Access list"${companion ? " readonly" : ""}
        placeholder="allow api.example.com">${escapeHtml(text)}</textarea>
      <div id="app-access-errors" aria-live="polite"></div>
      <p class="muted-sm mt-1" id="app-access-count"></p>
      ${companion
        ? `<p class="faint-sm mt-2">${escapeHtml(ACCESS_COMPANION_NOTE)}</p>`
        : `<button id="app-access-save" class="full-width mt-2" disabled>${escapeHtml(ACCESS_SAVE)}</button>`}
    </div>`;
  const textarea = $("app-access-text");
  const update = () => paintState(accessEditorState(textarea.value, current.list, { companion }));
  textarea.addEventListener("input", update);
  update();
  $("app-access-save")?.addEventListener("click", (ev) => void save(ev.currentTarget, textarea));
}

async function save(btn, textarea) {
  if (!current) return;
  const session = getSession();
  if (!session.umk) return toast("Unlock the webapp first", "err");
  const ctx = current;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const access = await sendAccessList({
      serverDomain: podServerDomain(),
      serviceId: ctx.serviceId,
      list: textarea.value,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
      fetchJson: (path, init) => screensFetch(path, init),
    });
    if (current !== ctx) return;
    ctx.list = access.list;
    ctx.draft = false;
    textarea.value = access.list;
    document.querySelector("[data-access-draft-note]")?.remove();
    toast("Access list saved", "ok");
  } catch (e) {
    const boxErrors = e?.status === 400 && Array.isArray(e?.body?.errors) ? e.body.errors : null;
    if (boxErrors) {
      const errs = $("app-access-errors");
      if (errs) errs.innerHTML = errorsHtml(boxErrors);
    }
    toast(e instanceof ScreensError || e?.name === "AccessListError" ? accessErrorMessage(e) : humanError(e), "err");
  } finally {
    btn.textContent = ACCESS_SAVE;
    if (current === ctx) {
      const st = accessEditorState(textarea.value, ctx.list);
      btn.disabled = !st.canSave;
    }
  }
}

export function initAppAccessView() {
  $("app-access-back")?.addEventListener("click", async () => {
    if (current) {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(current.serviceId);
    } else {
      show("view-services-list");
    }
  });
  $("app-access-refresh")?.addEventListener("click", () => {
    if (current) {
      renderAppAccess(current.serviceId, current.appName, { draft: current.draft }).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      });
    }
  });
}

export async function enterAppAccess(serviceId, appName, opts = {}) {
  show("view-app-access");
  await renderAppAccess(serviceId, appName, opts);
}
