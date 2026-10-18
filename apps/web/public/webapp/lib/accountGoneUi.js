// The "This account was removed" screen (docs/account-gone.md).
//
// Shown over whatever view is on screen when `.com` says this browser's own
// account no longer exists (lib/accountGone.js). Like the update lock it is an
// overlay, not a view: it first runs the lock sweep so no menu, dialog or sheet
// stays open and operable behind it, then makes the page inert.
//
// It leads with "Save my servers' data", because the admin key on this device
// can still save a server's data even though `.com` no longer knows the
// account, and removing it ends that. Two ways out remove this browser's copy
// of the account: "Create a new account" (then the create flow) and, as a quiet
// text action, "Remove it from this browser" (then the welcome view). On a
// device that holds an admin root or any server key, both first ask in plain
// words (lib/adminKeyWarning.js): save first, or remove anyway.

import {
  clearAccountGone,
  goneAccountName,
  isAccountGone,
  onAccountGone,
  setOwnAccountNames,
} from "./accountGone.js";
import { clearAccountReadTokens } from "./accountRead.js";
import { dismissOverlays } from "./lockSweep.js";
import { getActiveProfile, loadProfiles, removeProfile } from "./profiles.js";
import { remove as profileRemove, removeProfileRecord } from "./profilesStore.js";
import { isUpdateLocked } from "./updateLock.js";
import {
  ADMIN_KEY_COPY,
  holdsRescueKey,
  removeWarning,
  saveDataFirst,
} from "./adminKeyWarning.js";
import { listPodTokenIds } from "./profilesStore.js";
import { toast } from "./toast.js";
import { getSession, lockSession } from "./state.js";
import {
  activeProfileId,
  hasAdminRoot,
  forgetDefaultProfileKeys,
  forgetProfileKeys,
  setActiveKeystoreProfile,
} from "../keystore.js";
import { setSubtitle, show } from "./router.js";

export const ACCOUNT_GONE_COPY = Object.freeze({
  title: "This account was removed",
  body: "This account no longer exists on Flagship. This can happen after a reset.",
  save: ADMIN_KEY_COPY.saveData,
  saveSoon: ADMIN_KEY_COPY.comingSoon,
  create: "Create a new account",
  remove: "Remove it from this browser",
  account: (name) => `Account: ${name}`,
  failed: "Couldn't remove it yet. Reload the page and try again.",
});

const SLOTS = ["sessionId", "sessionToken", "podBaseUrl", "username"];
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Forget this browser's copy of the gone account: every key it held (the
 * wrapped device key, any PIN wrap and held sessions, the sealed admin root,
 * and the bootstrap's default record once no profile is left), the profile
 * row and all its slots, the held read tokens, and the unlocked session.
 * Nothing here talks to the network. Returns whether another saved profile
 * remains.
 *
 * @param {object} [deps] injected for tests
 */
export async function removeGoneAccountFromBrowser(deps = {}) {
  const profile = (deps.getActiveProfile ?? getActiveProfile)();
  const name = String(profile?.cloudName ?? goneAccountName() ?? "");
  const profileId = (deps.activeProfileId ?? activeProfileId)();
  try { (deps.stopRenewals ?? (await defaultStopRenewals()))(); } catch { /* best-effort */ }
  await (deps.forgetProfileKeys ?? forgetProfileKeys)(profileId);
  for (const slot of SLOTS) {
    try { (deps.profileRemove ?? profileRemove)(slot); } catch { /* best-effort */ }
  }
  if (name) {
    try { (deps.removeProfileRecord ?? removeProfileRecord)(name); } catch { /* best-effort */ }
    try { (deps.forgetProfile ?? removeProfile)(name); } catch { /* best-effort local cleanup */ }
  }
  const othersRemain = (deps.loadProfiles ?? loadProfiles)().profiles.length > 0;
  if (!othersRemain) {
    await (deps.forgetDefaultProfileKeys ?? forgetDefaultProfileKeys)();
    (deps.setActiveKeystoreProfile ?? setActiveKeystoreProfile)(null);
  }
  (deps.clearAccountReadTokens ?? clearAccountReadTokens)();
  (deps.lockSession ?? lockSession)();
  (deps.clearAccountGone ?? clearAccountGone)();
  return othersRemain;
}

async function defaultStopRenewals() {
  const { stopRenewals } = await import("../views/home.js");
  return stopRenewals;
}

let el = null;
let shown = false;

function ensureEl() {
  if (el) return el;
  if (typeof document === "undefined") return null;
  el = document.createElement("div");
  el.id = "account-gone";
  el.className = "update-lock account-gone hidden";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "account-gone-title");
  el.setAttribute("aria-describedby", "account-gone-body");
  document.body.appendChild(el);
  return el;
}

const KEEP_LIVE = new Set(["account-gone", "update-lock", "toast", "flagship-modal-host"]);

function setPageInert(on) {
  for (const child of Array.from(document.body.children)) {
    if (KEEP_LIVE.has(child.id) || child.tagName === "SCRIPT") continue;
    if (on) child.setAttribute("inert", "");
    else if (!isUpdateLocked()) child.removeAttribute("inert");
  }
}

/** The rescue flow (docs/data-sovereignty.md), once a build has one: it calls
 *  `registerRescueFlow(async () => boolean)` at boot. Until then the primary
 *  button is shown disabled with "Coming soon". */
let rescueFlow = null;
export function registerRescueFlow(fn) {
  rescueFlow = typeof fn === "function" ? fn : null;
  if (shown) paint(goneAccountName());
}

function paint(name) {
  const canSave = !!rescueFlow;
  const confirm = removeWarning();
  el.innerHTML = `
    <div class="update-lock-card" data-testid="account-gone">
      <h2 id="account-gone-title" class="update-lock-title">${esc(ACCOUNT_GONE_COPY.title)}</h2>
      <p id="account-gone-body" class="update-lock-body" data-testid="account-gone-body">${esc(ACCOUNT_GONE_COPY.body)}</p>
      <p class="update-lock-meta" data-testid="account-gone-name">${esc(ACCOUNT_GONE_COPY.account(name))}</p>
      <p id="account-gone-error" class="err-text hidden" role="alert" data-testid="account-gone-error"></p>
      <div id="account-gone-actions" class="update-lock-actions">
        <button type="button" id="account-gone-save" class="full-width" data-testid="account-gone-save"${canSave ? "" : " disabled"}>${esc(ACCOUNT_GONE_COPY.save)}</button>
        ${canSave ? "" : `<p class="update-lock-meta" data-testid="account-gone-save-soon">${esc(ACCOUNT_GONE_COPY.saveSoon)}</p>`}
        <button type="button" id="account-gone-create" class="secondary full-width" data-testid="account-gone-create">${esc(ACCOUNT_GONE_COPY.create)}</button>
        <button type="button" id="account-gone-remove" class="ghost full-width" data-testid="account-gone-remove">${esc(ACCOUNT_GONE_COPY.remove)}</button>
      </div>
      <div id="account-gone-confirm" class="update-lock-actions hidden" role="group" aria-labelledby="account-gone-confirm-text" data-testid="account-gone-confirm">
        <p id="account-gone-confirm-text" class="update-lock-body" data-testid="account-gone-confirm-text">${esc(confirm.message)}</p>
        <button type="button" id="account-gone-confirm-save" class="full-width" data-testid="account-gone-confirm-save">${esc(ADMIN_KEY_COPY.saveFirst)}</button>
        <button type="button" id="account-gone-confirm-anyway" class="danger-outline full-width" data-testid="account-gone-confirm-anyway">${esc(ADMIN_KEY_COPY.removeAnyway)}</button>
      </div>
    </div>`;
  let afterConfirm = false;
  const confirmMode = (on, thenCreate = false) => {
    el.querySelector("#account-gone-actions")?.classList.toggle("hidden", on);
    el.querySelector("#account-gone-confirm")?.classList.toggle("hidden", !on);
    afterConfirm = thenCreate;
    if (on) el.querySelector("#account-gone-confirm-save")?.focus({ preventScroll: true });
  };
  el.querySelector("#account-gone-save")?.addEventListener("click", () => void runSave());
  el.querySelector("#account-gone-create")?.addEventListener("click", () => void requestLeave(true, confirmMode));
  el.querySelector("#account-gone-remove")?.addEventListener("click", () => void requestLeave(false, confirmMode));
  el.querySelector("#account-gone-confirm-save")?.addEventListener("click", async () => {
    await runSave();
    confirmMode(false);
  });
  el.querySelector("#account-gone-confirm-anyway")?.addEventListener("click", () => void leave(afterConfirm));
}

async function runSave() {
  await saveDataFirst({
    rescue: rescueFlow,
    session: getSession(),
    backupKey: async () => {
      const { runKeyfileExportCeremony } = await import("../views/recovery.js");
      return runKeyfileExportCeremony();
    },
    notify: (text) => toast(text),
  });
}

/** On a device that holds an admin root or any server key, ask first. */
async function requestLeave(thenCreate, confirmMode) {
  const holds = await holdsRescueKey({
    session: getSession(),
    hasAdminRootRecord: () => hasAdminRoot(),
    serverTokenCount: () => listPodTokenIds().length,
  });
  if (holds) confirmMode(true, thenCreate);
  else await leave(thenCreate);
}

function hide() {
  if (!shown) return;
  shown = false;
  el.classList.add("hidden");
  el.innerHTML = "";
  setPageInert(false);
}

async function leave(thenCreate) {
  const buttons = el?.querySelectorAll("button") ?? [];
  for (const b of buttons) b.disabled = true;
  try {
    const othersRemain = await removeGoneAccountFromBrowser();
    hide();
    setSubtitle("");
    if (othersRemain && !thenCreate) {
      location.reload();
      return;
    }
    show("view-bootstrap");
    if (thenCreate) document.getElementById("bootstrap-create")?.click();
  } catch (e) {
    console.error("removing the account from this browser failed", e);
    for (const b of buttons) b.disabled = false;
    const err = el?.querySelector("#account-gone-error");
    if (err) {
      err.textContent = ACCOUNT_GONE_COPY.failed;
      err.classList.remove("hidden");
    }
  }
}

function sync() {
  if (!ensureEl()) return;
  if (isAccountGone()) {
    if (!shown) {
      // Nothing of a menu, dialog or sheet may stay open and operable behind it.
      dismissOverlays();
      shown = true;
      paint(goneAccountName());
      el.classList.remove("hidden");
      setPageInert(true);
      queueMicrotask(() => el.querySelector("#account-gone-create")?.focus({ preventScroll: true }));
    }
  } else {
    hide();
  }
}

/** Which names are this browser's own account: the active profile and the unlocked session. */
function ownNames() {
  const profile = getActiveProfile();
  let sessionName = null;
  try { sessionName = getSession().username; } catch { /* locked */ }
  return [profile?.accountId, profile?.cloudName, sessionName].filter(Boolean);
}

/** Mount the screen and keep it in step with the account state. Idempotent. */
export function initAccountGoneUi() {
  if (typeof document === "undefined" || initAccountGoneUi._done) return;
  initAccountGoneUi._done = true;
  setOwnAccountNames(ownNames);
  onAccountGone(() => sync());
  sync();
}

/** Test seam. */
export function _resetAccountGoneUiForTests() {
  el?.remove();
  el = null;
  shown = false;
  initAccountGoneUi._done = false;
}
