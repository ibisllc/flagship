import { bytesToHex, signWithIrk } from "../keystore.js";
import {
  notificationPermission,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushSupported,
} from "../lib/push.js";
import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername, lockSession } from "../lib/state.js";
import { escapeHtml, sha256Bytes } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { loadProviders, addProvider, removeProvider, setActive } from "../providers.js";
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
import { enterAccountDelete } from "./account-delete.js";

registerView("view-settings");

const FLAGSHIP_PROMO_LABEL_PREFIX = "Flagship promo";

function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

function isPromoEntry(e) {
  return e?.label?.startsWith(FLAGSHIP_PROMO_LABEL_PREFIX);
}

/** Attach an HTTP status to an Error so humanError() can branch on it. */
function withStatusLocal(err, status) {
  err.status = status;
  return err;
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
  let enrolled = false;
  try {
    enrolled = await hasCloudRecovery(getSession().username);
  } catch {
    enrolled = false;
  }
  sessionRecoveryEnrolled = enrolled;
  for (const id of ["settings-signout", "settings-reset"]) {
    $(id)?.classList.toggle("gated", !enrolled);
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
  const hasPromoEntry = stored.entries.some(isPromoEntry);

  if (!hasPromoEntry) {
    const cta = document.createElement("div");
    cta.className = "card";
    cta.innerHTML = `
      <div class="weight-600">Flagship free credits</div>
      <div class="note mt-2">
        500k tokens / 100k per day on our hosted coding model. Verify a phone number to claim once.
        Once issued, the key lives on this device — flagshipserver.com cannot read your prompts.
      </div>
      <button id="promo-claim-go" class="full-width mt-3">Get free credits</button>
    `;
    list.appendChild(cta);
  }

  if (hasPromoEntry) void refreshPromoBalance();

  for (const e of stored.entries) {
    const isActive = stored.activeId === e.id;
    const card = document.createElement("div");
    card.className = `card mt-2 provider-entry${isActive ? " is-active" : ""}`;
    const promoBadge = isPromoEntry(e) ? '<span class="pill ok">free credits</span>' : "";
    card.innerHTML = `
      <div class="row row-top">
        <div>
          <div class="weight-600">${escapeHtml(e.label)} ${promoBadge} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="value text-xs mt-1">${escapeHtml(maskKey(e.apiKey))}</div>
          ${e.defaultModel ? `<div class="faint-sm">default: ${escapeHtml(e.defaultModel)}</div>` : ""}
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
  $("promo-claim-go")?.addEventListener("click", () => {
    $("promo-issuance-form")?.classList.remove("hidden");
    $("promo-step-otp")?.classList.add("hidden");
    $("promo-step-phone")?.classList.remove("hidden");
  });
}

// Credit-balance display for the free-credits (flagship) provider. Reads
// the already-built GET /api/llm-promo/status/:user (tier + daily/lifetime
// usage). Best-effort: a fetch failure just hides the card. When the
// lifetime cap is spent, surface the "switch to your own key" prompt.
async function refreshPromoBalance() {
  const el = $("promo-balance");
  if (!el) return;
  let username;
  try {
    username = await ensureUsername();
  } catch {
    el.classList.add("hidden");
    return;
  }
  let status;
  try {
    const r = await fetch(`/api/llm-promo/status/${encodeURIComponent(username)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    status = await r.json();
  } catch {
    el.classList.add("hidden");
    return;
  }
  const daily = status.daily ?? { used: 0, cap: 0 };
  const lifetime = status.lifetime ?? { used: 0, cap: -1 };
  const lifetimeSpent = lifetime.cap !== -1 && lifetime.used >= lifetime.cap;
  const lifetimeText =
    lifetime.cap === -1
      ? "unlimited"
      : `${Math.max(0, lifetime.cap - lifetime.used)} of ${lifetime.cap} left`;
  el.className = "card mt-2";
  el.innerHTML = `
    <div class="row row-top">
      <div class="weight-600">Free credits</div>
      <span class="pill">${escapeHtml(status.tier ?? "free")}</span>
    </div>
    <div class="note mt-2">
      Today: ${daily.used ?? 0} of ${daily.cap ?? 0} · Lifetime: ${escapeHtml(lifetimeText)}
    </div>
    ${
      lifetimeSpent
        ? `<div class="note mt-2 warn">You've used all your free credits. Add your own provider key to keep building.</div>
           <button id="promo-switch-byok" class="full-width mt-2">Add your own key</button>`
        : ""
    }
  `;
  if (lifetimeSpent) {
    $("promo-switch-byok")?.addEventListener("click", () => handleAddProvider());
  }
}

let promoIssuanceCtx = null;

async function startPromoIssuance() {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  const username = await ensureUsername().catch((e) => {
    toast(e.message, "err");
    return null;
  });
  if (!username) return;
  const phone = $("promo-phone").value.trim();
  if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
    return toast("Phone number must be E.164 (e.g. +15555550100)", "err");
  }
  const identityHash = await sha256Bytes(new TextEncoder().encode(phone));
  const issuedAt = Date.now();
  const canonical = new TextEncoder().encode(
    `flagship/llm-promo-issue-start/v1|${username}|phone-otp|${bytesToHex(identityHash)}|${issuedAt}`,
  );
  const sig = await signWithIrk(session.umk, canonical);
  try {
    const r = await fetch("/api/llm-promo/issue/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          userId: username,
          method: "phone-otp",
          identityHash: bytesToHex(identityHash),
          issuedAt,
        },
        signature: bytesToHex(sig),
        identity: phone,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("promo issue/start failed", r.status, body);
      throw withStatusLocal(new Error(`promo issue/start ${r.status}`), r.status);
    }
    const body = await r.json();
    promoIssuanceCtx = { ticket: body.ticket, username };
    $("promo-step-phone")?.classList.add("hidden");
    $("promo-step-otp")?.classList.remove("hidden");
    toast("We sent you a code");
  } catch (e) {
    console.error("promo issue/start error", e);
    toast(humanError(e), "err");
  }
}

async function completePromoIssuance() {
  const session = getSession();
  if (!session.umk || !promoIssuanceCtx) return;
  const otp = $("promo-otp").value.trim();
  if (!/^[0-9]{6}$/.test(otp)) return toast("OTP must be 6 digits", "err");
  const otpHash = await sha256Bytes(new TextEncoder().encode(otp));
  const issuedAt = Date.now();
  const canonical = new TextEncoder().encode(
    `flagship/llm-promo-issue-complete/v1|${promoIssuanceCtx.username}|${promoIssuanceCtx.ticket}|${bytesToHex(otpHash)}|${issuedAt}`,
  );
  const sig = await signWithIrk(session.umk, canonical);
  try {
    const r = await fetch("/api/llm-promo/issue/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          userId: promoIssuanceCtx.username,
          ticket: promoIssuanceCtx.ticket,
          otpHash: bytesToHex(otpHash),
          issuedAt,
        },
        signature: bytesToHex(sig),
        otp,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error("promo issue/complete failed", r.status, body);
      throw withStatusLocal(new Error(`promo issue/complete ${r.status}`), r.status);
    }
    const { key } = await r.json();
    await addProvider(session.umk, {
      // The in-house inference posture: an OpenAI-compatible RunPod/vLLM
      // endpoint reached with a scoped .com token. `source: "promo"` is
      // sealed with the credential so the box pins its SSRF guard to the
      // blessed host (a leaked token can't be redirected elsewhere).
      provider: "flagship",
      label: `Flagship promo (${key.keyId})`,
      apiKey: key.apiKey,
      baseUrl: key.baseUrl,
      defaultModel: key.model,
      source: "promo",
    });
    promoIssuanceCtx = null;
    $("promo-issuance-form")?.classList.add("hidden");
    $("promo-otp").value = "";
    $("promo-phone").value = "";
    await renderProviders();
    await renderActiveProviderChip();
    toast("Free credits ready — selected as active provider");
  } catch (e) {
    console.error("promo issue/complete error", e);
    toast(humanError(e), "err");
  }
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
  if (!label) return toast("Label required", "err");
  if (!apiKey) return toast("Api key required", "err");
  try {
    await addProvider(session.umk, {
      provider,
      label,
      apiKey,
      baseUrl: baseUrl || undefined,
      defaultModel: defaultModel || undefined,
    });
  } catch (e) {
    return toast(e.message, "err");
  }
  $("np-label").value = "";
  $("np-key").value = "";
  $("np-base").value = "";
  $("np-model").value = "";
  $("add-provider-form").classList.add("hidden");
  await renderProviders();
  toast("Provider saved");
}

async function refreshPushStatus() {
  const pill = $("push-status");
  const enableBtn = $("push-enable");
  const disableBtn = $("push-disable");
  if (!pill || !enableBtn || !disableBtn) return;
  if (!webPushSupported()) {
    pill.textContent = "unsupported";
    enableBtn.disabled = true;
    disableBtn.style.display = "none";
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
  pill.textContent = active ? "on" : perm === "denied" ? "blocked" : "off";
  enableBtn.style.display = active ? "none" : "";
  disableBtn.style.display = active ? "" : "none";
  enableBtn.disabled = perm === "denied";
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
      btn.textContent = "Enable browser notifications";
    }
    void refreshPushStatus();
  }
}

async function runDisablePush() {
  const btn = $("push-disable");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Disabling…";
  }
  try {
    await unsubscribeFromWebPush();
    toast("Notifications disabled", "ok");
  } catch (e) {
    toast(`Disable failed: ${e.message ?? e}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Disable";
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
  $("push-enable")?.addEventListener("click", runEnablePush);
  $("push-disable")?.addEventListener("click", runDisablePush);
  // Refresh once on init; repeated renders are kicked from the
  // chip-settings click handler in home.js (it dispatches into
  // renderProviders, which we extend below).
  void refreshPushStatus();
  $("add-provider-go")?.addEventListener("click", handleAddProvider);
  $("np-save")?.addEventListener("click", handleSaveProvider);
  $("np-cancel")?.addEventListener("click", () =>
    $("add-provider-form").classList.add("hidden"),
  );
  $("promo-start-go")?.addEventListener("click", startPromoIssuance);
  $("promo-complete-go")?.addEventListener("click", completePromoIssuance);
  $("promo-cancel")?.addEventListener("click", () => {
    promoIssuanceCtx = null;
    $("promo-issuance-form")?.classList.add("hidden");
    $("promo-otp").value = "";
    $("promo-phone").value = "";
  });
}
