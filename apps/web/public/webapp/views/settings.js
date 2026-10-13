import {
  notificationPermission,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushSupported,
} from "../lib/push.js";
import { applyPushSetting, pushNotificationsEnabled } from "../lib/pushSetting.js";
import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername, lockSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { loadProviders, addProvider, removeProvider, setActive, setRelay } from "../providers.js";
import { relayCaption } from "../lib/aiRelay.js";
import { CARD_NOTE, UNAVAILABLE_MESSAGE, USED_UP_MESSAGE, creditsLine, fetchFreeAiStatus } from "../lib/freeAi.js";
import { renderActiveProviderChip, stopRenewals } from "./home.js";
import { handleReset } from "./unlock.js";
import { enterRecovery } from "./recovery.js";
import { resetDevice } from "../keystore.js";
import { setSubtitle } from "../lib/router.js";
import { remove as profileRemove } from "../lib/profilesStore.js";
import { hasCloudRecovery } from "../lib/recovery.js";
import { hasPin } from "../lib/pinLock.js";
import { lockToPin, startSetPin } from "./pinLock.js";
import {
  signOut as signOutTier,
  signOutConfirmCopy,
} from "../lib/sessionTiers.js";
import { resolveAccount } from "../lib/accountResolve.js";
import { accountDeletePolicy } from "../lib/accountDeletion.js";
import { enterAccountDelete, removeDemoFromBrowser } from "./account-delete.js";
import { getActiveProfile } from "../lib/profiles.js";
import { isDemoProfile } from "../lib/demoAccount.js";

registerView("view-settings");

function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

export { refreshPushStatus };

// Module-level cache of the recovery-enrollment state, consulted by the
// gated session buttons' click handlers. Fail-closed: false until a
// successful probe proves recovery is enrolled.
let sessionRecoveryEnrolled = false;

/** Grey out the recovery-gated session buttons ("Lock with passkey" +
 *  "Remove this device") until cloud recovery is enrolled. The buttons
 *  stay tappable while greyed — a tap surfaces a toast (see the click
 *  wiring in initSettingsView) instead of running the destructive path.
 *  Best-effort + async; defaults to the safe (not-enrolled ⇒ greyed)
 *  framing on any failure. */
async function refreshSessionGates() {
  // A demo holds no account key, so there is nothing for recovery to
  // protect: its session buttons just remove it from this browser.
  const demo = isDemoProfile(getActiveProfile());
  let enrolled = false;
  if (!demo) {
    try {
      enrolled = await hasCloudRecovery(getSession().username);
    } catch {
      enrolled = false;
    }
  }
  sessionRecoveryEnrolled = enrolled;
  for (const id of ["settings-signout", "settings-reset"]) {
    $(id)?.classList.toggle("gated", !enrolled && !demo);
  }
  // "Change PIN" only appears once a PIN is set (tier-1 PIN lock).
  let pinSet = false;
  try {
    pinSet = await hasPin();
  } catch {
    pinSet = false;
  }
  $("settings-pin-change")?.classList.toggle("hidden", !pinSet);
}

export async function renderProviders() {
  void refreshPushStatus();
  void refreshSessionGates();
  const session = getSession();
  const list = $("providers-list");
  list.innerHTML = "";
  if (!session.umk) {
    list.innerHTML = '<div class="card placeholder">unlock first</div>';
    return;
  }
  const stored = await loadProviders(session.umk);
  void renderFreeAiCard();

  for (const e of stored.entries) {
    const isActive = stored.activeId === e.id;
    const card = document.createElement("div");
    card.className = `card mt-2 provider-entry${isActive ? " is-active" : ""}`;
    card.innerHTML = `
      <div class="row row-top">
        <div>
          <div class="weight-600">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="value text-xs mt-1">${escapeHtml(maskKey(e.apiKey))}</div>
          ${e.defaultModel ? `<div class="faint-sm">default: ${escapeHtml(e.defaultModel)}</div>` : ""}
          <label class="inline-check mt-1">
            <input type="checkbox" role="switch" data-action="relay" data-id="${escapeHtml(e.id)}"${e.relay !== false ? " checked" : ""} />
            <span class="faint-sm">${escapeHtml(relayCaption(e.relay !== false))}</span>
          </label>
        </div>
        <div class="btn-row-sm">
          <button class="${isActive ? "" : "secondary"}" data-action="set-active" data-id="${escapeHtml(e.id)}">${isActive ? "active" : "use"}</button>
          <button class="secondary" data-action="remove" data-id="${escapeHtml(e.id)}">remove</button>
        </div>
      </div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('[data-action="set-active"]').forEach((b) => {
    b.addEventListener("click", async () => {
      try {
        await setActive(getSession().umk, b.getAttribute("data-id"));
        await renderProviders();
        await renderActiveProviderChip();
        toast("Active provider updated");
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
  list.querySelectorAll('[data-action="relay"]').forEach((input) => {
    input.addEventListener("change", async () => {
      try {
        await setRelay(getSession().umk, input.getAttribute("data-id"), input.checked);
      } catch (e) {
        toast(e.message, "err");
      }
      await renderProviders();
    });
  });
  list.querySelectorAll('[data-action="remove"]').forEach((b) => {
    b.addEventListener("click", async () => {
      const { inlineConfirm } = await import("../lib/modal.js");
      const ok = await inlineConfirm({
        title: "Remove this provider?",
        message: "The API key for this provider will be deleted from this device.",
        okLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        await removeProvider(getSession().umk, b.getAttribute("data-id"));
        await renderProviders();
        await renderActiveProviderChip();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
}

/** The settings view's free AI card body for a status read (null = hide). Exported for tests. */
export function freeAiCardHtml(status) {
  if (!status) return null;
  const spent = status.available && (status.credits?.remainingTokens ?? 0) <= 0;
  const line = !status.available ? UNAVAILABLE_MESSAGE : spent ? USED_UP_MESSAGE : creditsLine(status.credits);
  return `
    <div class="weight-600">Free AI credits</div>
    <div class="note mt-2${spent ? " warn" : ""}" id="free-ai-line">${escapeHtml(line)}</div>
    ${status.available && !spent ? `<div class="faint-sm mt-1">${escapeHtml(CARD_NOTE)}</div>` : ""}
    ${!status.available || spent ? '<button id="free-ai-add-key" class="full-width mt-2">Add your own key</button>' : ""}
  `;
}

// The free AI credits card: what's left, and the way to your own key when
// they're used up or unavailable. Hidden when the status can't be read.
async function renderFreeAiCard() {
  const el = $("free-ai-card");
  if (!el) return;
  const html = freeAiCardHtml(await fetchFreeAiStatus());
  if (!html) {
    el.classList.add("hidden");
    return;
  }
  el.className = "card mt-2";
  el.innerHTML = html;
  $("free-ai-add-key")?.addEventListener("click", () => handleAddProvider());
}

async function handleAddProvider() {
  $("add-provider-form").classList.remove("hidden");
}

async function handleSaveProvider() {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  const provider = $("np-provider").value;
  const label = $("np-label").value.trim();
  const apiKey = $("np-key").value;
  const baseUrl = $("np-base").value.trim();
  const defaultModel = $("np-model").value.trim();
  const relay = $("np-relay") ? $("np-relay").checked : true;
  if (!label) return toast("Label required", "err");
  if (!apiKey) return toast("Api key required", "err");
  try {
    await addProvider(session.umk, {
      provider,
      label,
      apiKey,
      baseUrl: baseUrl || undefined,
      defaultModel: defaultModel || undefined,
      relay,
    });
  } catch (e) {
    return toast(e.message, "err");
  }
  $("np-label").value = "";
  $("np-key").value = "";
  $("np-base").value = "";
  $("np-model").value = "";
  if ($("np-relay")) $("np-relay").checked = true;
  $("add-provider-form").classList.add("hidden");
  await renderProviders();
  toast("Provider saved");
}

async function refreshPushStatus() {
  const pill = $("push-status");
  const enableBtn = $("push-enable");
  const sw = $("push-switch");
  if (!pill || !enableBtn) return;
  const on = pushNotificationsEnabled();
  if (sw) sw.checked = on;
  if (!webPushSupported()) {
    pill.textContent = on ? "unsupported" : "off";
    enableBtn.style.display = "none";
    return;
  }
  const perm = notificationPermission();
  let active = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    active = !!sub && perm === "granted";
  } catch {
    active = false;
  }
  pill.textContent = !on ? "off" : active ? "on" : perm === "denied" ? "blocked" : "not allowed yet";
  // On, but this browser isn't subscribed (never allowed, or allowed before
  // the switch existed): offer the permission prompt, which needs a tap.
  enableBtn.style.display = on && !active && perm !== "denied" ? "" : "none";
}

/** The switch: off revokes this browser's push registration and tells every
 *  box to stop sending alerts; on registers again and tells them to send. */
async function runPushSwitch() {
  const sw = $("push-switch");
  if (!sw) return;
  const enabled = sw.checked;
  sw.disabled = true;
  try {
    if (enabled) await ensureUsername();
    const r = await applyPushSetting(enabled, {
      subscribe: subscribeToWebPush,
      unsubscribe: unsubscribeFromWebPush,
    });
    if (r.pushError) {
      toast(
        enabled
          ? `Your servers will send alerts again, but this browser couldn't turn on notifications: ${r.pushError.message ?? r.pushError}`
          : `This browser couldn't drop its notifications: ${r.pushError.message ?? r.pushError}`,
        "err",
      );
    } else if (r.failed.length > 0) {
      toast(`Saved. ${r.failed.length} server(s) couldn't be reached and will be updated next time.`, "ok");
    } else {
      toast(enabled ? "Push notifications on" : "Push notifications off", "ok");
    }
  } catch (e) {
    toast(humanError(e), "err");
  } finally {
    sw.disabled = false;
    void refreshPushStatus();
  }
}

async function runEnablePush() {
  const btn = $("push-enable");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Requesting…";
  }
  try {
    await ensureUsername();
    await subscribeToWebPush();
    toast("Notifications enabled", "ok");
  } catch (e) {
    toast(`Enable failed: ${e.message ?? e}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Allow browser notifications";
    }
    void refreshPushStatus();
  }
}

/** Tier 2 — SIGN OUT. Erase this device's local key material WITHOUT a
 *  server-side revoke, gated on cloud-recovery enrollment. With recovery
 *  enrolled the same key comes back via passkey (instant re-pair); without
 *  it the wipe would orphan the only copy of the key, so #52 BLOCKS it:
 *  the confirm carries no destructive proceed — its primary action routes
 *  into recovery enrollment instead, and signOutTier itself re-refuses
 *  the wipe (fail-closed) even if this UI gate is bypassed. */
async function handleSignOut() {
  const username = getSession().username;
  // Best-effort recovery probe (network). On any failure we fall back to
  // NOT-enrolled — fail-closed: the sign-out is blocked rather than
  // risking a wipe of the only key (Tier-1 Lock stays available offline).
  let enrolled = false;
  try {
    enrolled = await hasCloudRecovery(username);
  } catch {
    enrolled = false;
  }
  const { inlineConfirm } = await import("../lib/modal.js");
  const copy = signOutConfirmCopy(enrolled);
  const ok = await inlineConfirm({
    title: copy.title,
    message: copy.message,
    okLabel: copy.okLabel,
    danger: copy.danger,
  });
  if (!ok) return;
  if (copy.blocked) {
    // #52 — no recovery: the OK is "Set up recovery", never a wipe.
    enterRecovery();
    return;
  }
  const res = await signOutTier({
    hasCloudRecovery: enrolled,
    resetDevice,
    lockSession,
    profileRemove,
    stopRenewals,
    show,
    setSubtitle,
  });
  if (res?.blocked) return;
  toast("Signed out");
}

/** A recovery-gated session button (Tier-2 sign-out / Tier-3 remove) was
 *  tapped while greyed (no cloud recovery enrolled). Decide between the two
 *  no-recovery outcomes:
 *    - LAST device  → this removal is account DEATH; route into the full
 *                     deletion ceremony (typed-username + confirm) instead of
 *                     silently blocking.
 *    - other device → the key survives elsewhere; nudge the user to set up
 *                     recovery (the existing guidance), no ceremony.
 *  Best-effort + fail-closed: any resolve failure (network / unknown count)
 *  treats it as the last device, so a no-recovery wipe never bypasses the
 *  ceremony. */
async function handleNoRecoveryGatedTap() {
  const username = getSession().username;
  let resolution = null;
  try {
    resolution = await resolveAccount(username);
  } catch {
    resolution = null;
  }
  const policy = accountDeletePolicy({
    hasCloudRecovery: false,
    isDemoAccount: resolution?.kind === "demo",
  });
  if (policy === "ceremony") {
    enterAccountDelete();
    return;
  }
  // "normal" (another device exists) or "exempt" (demo) — the destructive
  // wipe still needs recovery to be safe here, so keep the guidance nudge.
  toast("Set up account recovery to use this.", "warn");
}

export function initSettingsView() {
  $("settings-back")?.addEventListener("click", async () => {
    show("view-home");
    await renderActiveProviderChip();
  });
  // Tier 1 — LOCK WITH PIN. First time (no PIN set) walks through setup
  // (new + confirm); afterwards it locks straight to the PIN screen.
  $("settings-pin-lock")?.addEventListener("click", async () => {
    let pinSet = false;
    try {
      pinSet = await hasPin();
    } catch {
      pinSet = false;
    }
    if (pinSet) lockToPin();
    else startSetPin({ mode: "set" });
  });
  // "Change PIN" requires the current PIN, then a new one (handled in the
  // set/change view). Visible only when a PIN is already set.
  $("settings-pin-change")?.addEventListener("click", () => startSetPin({ mode: "change" }));
  // "Lock with passkey" (tier 2) is recovery-gated: greyed until cloud
  // recovery is enrolled, and a tap-while-greyed surfaces a toast instead
  // of running the key wipe.
  $("settings-signout")?.addEventListener("click", () => {
    if (isDemoProfile(getActiveProfile())) {
      removeDemoFromBrowser().catch((e) => {
        console.error("demo removal failed", e);
        toast(humanError(e), "err");
      });
      return;
    }
    if (!sessionRecoveryEnrolled) {
      // No recovery: a last-device sign-out is account death → ceremony.
      handleNoRecoveryGatedTap().catch((e) => {
        console.error("no-recovery sign-out gate failed", e);
        toast(humanError(e), "err");
      });
      return;
    }
    handleSignOut().catch((e) => {
      console.error("sign-out failed", e);
      toast(humanError(e), "err");
    });
  });
  // Tier 3 — REMOVE THIS DEVICE (danger zone). Same recovery gate: removing
  // this device wipes the only local copy of the key, so it stays greyed +
  // toasts until recovery is enrolled.
  $("settings-reset")?.addEventListener("click", () => {
    if (isDemoProfile(getActiveProfile())) {
      removeDemoFromBrowser().catch((e) => {
        console.error("demo removal failed", e);
        toast(humanError(e), "err");
      });
      return;
    }
    if (!sessionRecoveryEnrolled) {
      // No recovery: removing the last device is account death → ceremony.
      handleNoRecoveryGatedTap().catch((e) => {
        console.error("no-recovery remove gate failed", e);
        toast(humanError(e), "err");
      });
      return;
    }
    handleReset();
  });
  $("push-switch")?.addEventListener("change", () => void runPushSwitch());
  $("push-enable")?.addEventListener("click", runEnablePush);
  // Refresh once on init; repeated renders are kicked from the
  // chip-settings click handler in home.js (it dispatches into
  // renderProviders, which we extend below).
  void refreshPushStatus();
  $("add-provider-go")?.addEventListener("click", handleAddProvider);
  $("np-save")?.addEventListener("click", handleSaveProvider);
  $("np-cancel")?.addEventListener("click", () =>
    $("add-provider-form").classList.add("hidden"),
  );
}
