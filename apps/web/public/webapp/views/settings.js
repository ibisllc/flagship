import { bytesToHex, signWithIrk } from "../keystore.js";
import {
  notificationPermission,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushSupported,
} from "../lib/push.js";
import { $, registerView, show } from "../lib/router.js";
import { getCertValidityDays, setCertValidityDays } from "../lib/certValidity.js";
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
import {
  lock as lockTier,
  signOut as signOutTier,
  signOutConfirmCopy,
} from "../lib/sessionTiers.js";

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

/** Reflect the cloud-recovery gate in the static sign-out note so the
 *  severity is visible before the user even clicks. Best-effort + async;
 *  defaults to the safe (not-enrolled) framing on any failure. */
async function refreshSignOutNote() {
  const note = $("settings-signout-note");
  if (!note) return;
  let enrolled = false;
  try {
    enrolled = await hasCloudRecovery(getSession().username);
  } catch {
    enrolled = false;
  }
  // UX-C — don't strand the user behind a disabled control. When recovery
  // isn't set up, swap the Sign-out button for a one-tap "Set up cloud
  // recovery" CTA that routes straight into enrollment; keep the
  // explanation so the severity is still clear.
  const signOutBtn = $("settings-signout");
  const recoveryCta = $("settings-signout-recovery");
  note.textContent = enrolled
    ? "Erases this device's account key so nothing's left at rest while you're signed out. Sign back in with your recovery passkey to restore it — your account and servers stay put."
    : "Sign out is disabled until you set up cloud recovery — this device holds the only copy of your account key, and erasing it would permanently lose access. Set up recovery and you'll be able to sign out safely.";
  if (signOutBtn) signOutBtn.classList.toggle("hidden", !enrolled);
  if (recoveryCta) recoveryCta.classList.toggle("hidden", enrolled);
}

export async function renderProviders() {
  void refreshPushStatus();
  void refreshSignOutNote();
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
        toast("active provider updated");
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

let promoIssuanceCtx = null;

async function startPromoIssuance() {
  const session = getSession();
  if (!session.umk) return toast("unlock first", "err");
  const username = await ensureUsername().catch((e) => {
    toast(e.message, "err");
    return null;
  });
  if (!username) return;
  const phone = $("promo-phone").value.trim();
  if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
    return toast("phone number must be E.164 (e.g. +15555550100)", "err");
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
    toast("we sent you a code");
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
      provider: "openai",
      label: `Flagship promo (${key.keyId})`,
      apiKey: key.apiKey,
      baseUrl: key.baseUrl,
      defaultModel: key.model,
    });
    promoIssuanceCtx = null;
    $("promo-issuance-form")?.classList.add("hidden");
    $("promo-otp").value = "";
    $("promo-phone").value = "";
    await renderProviders();
    await renderActiveProviderChip();
    toast("free credits ready — selected as active provider");
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
  if (!session.umk) return toast("unlock first", "err");
  const provider = $("np-provider").value;
  const label = $("np-label").value.trim();
  const apiKey = $("np-key").value;
  const baseUrl = $("np-base").value.trim();
  const defaultModel = $("np-model").value.trim();
  if (!label) return toast("label required", "err");
  if (!apiKey) return toast("api key required", "err");
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
  toast("provider saved");
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
    toast("notifications enabled", "ok");
  } catch (e) {
    toast(`enable failed: ${e.message ?? e}`, "err");
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
    toast("notifications disabled", "ok");
  } catch (e) {
    toast(`disable failed: ${e.message ?? e}`, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Disable";
    }
    void refreshPushStatus();
  }
}

/** Tier 1 — LOCK. Drop the in-memory session and re-gate behind the
 *  passphrase unlock screen. Removes nothing from storage. */
function handleLock() {
  lockTier({ lockSession, show, setSubtitle, stopRenewals });
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
  toast("signed out");
}

export function initSettingsView() {
  $("settings-back")?.addEventListener("click", async () => {
    show("view-home");
    await renderActiveProviderChip();
  });
  $("settings-lock")?.addEventListener("click", handleLock);
  $("settings-signout")?.addEventListener("click", () =>
    handleSignOut().catch((e) => {
      console.error("sign-out failed", e);
      toast(humanError(e), "err");
    }),
  );
  // UX-C — the direct route into recovery enrollment, shown in place of
  // Sign out whenever cloud recovery isn't set up yet.
  $("settings-signout-recovery")?.addEventListener("click", () => enterRecovery());
  // Tier 3 — REMOVE THIS DEVICE (danger zone). Unchanged local-reset path.
  $("settings-reset")?.addEventListener("click", handleReset);
  // Account-wide certificate-validity window — reflect the stored value and
  // persist on change. Mirrors the iOS CertValidityScreen.
  const certValidityEl = $("cert-validity-select");
  if (certValidityEl) {
    certValidityEl.value = String(getCertValidityDays());
    certValidityEl.addEventListener("change", () => {
      const v = setCertValidityDays(parseInt(certValidityEl.value, 10));
      certValidityEl.value = String(v);
    });
  }
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
