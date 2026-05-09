import { bytesToHex, signWithIrk } from "../keystore.js";
import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername } from "../lib/state.js";
import { escapeHtml, sha256Bytes } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { loadProviders, addProvider, removeProvider, setActive } from "../providers.js";
import { renderActiveProviderChip } from "./home.js";
import { handleReset } from "./unlock.js";

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

export async function renderProviders() {
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
      <div style="font-weight: 600;">Flagship free credits</div>
      <div style="color: var(--fg-mute); font-size: 0.85rem; margin-top: 0.25rem;">
        500k tokens / 100k per day on our hosted coding model. Verify a phone number to claim once.
        Once issued, the key lives on this device — flagshipserver.com cannot read your prompts.
      </div>
      <button id="promo-claim-go" style="margin-top: 0.7rem; width: 100%;">Get free credits</button>
    `;
    list.appendChild(cta);
  }

  for (const e of stored.entries) {
    const isActive = stored.activeId === e.id;
    const card = document.createElement("div");
    card.className = "card";
    card.style.borderLeft = `3px solid ${isActive ? "var(--accent)" : "transparent"}`;
    card.style.marginTop = "0.6rem";
    const promoBadge = isPromoEntry(e) ? '<span class="pill ok">free credits</span>' : "";
    card.innerHTML = `
      <div class="row" style="align-items: flex-start;">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} ${promoBadge} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="value" style="font-size: 0.78rem; margin-top: 0.25rem;">${escapeHtml(maskKey(e.apiKey))}</div>
          ${e.defaultModel ? `<div style="color: var(--fg-mute); font-size: 0.78rem;">default: ${escapeHtml(e.defaultModel)}</div>` : ""}
        </div>
        <div style="display:flex; gap: 0.4rem;">
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
      if (!confirm("Remove this provider?")) return;
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
      throw new Error(`status ${r.status}: ${body}`);
    }
    const body = await r.json();
    promoIssuanceCtx = { ticket: body.ticket, username };
    $("promo-step-phone")?.classList.add("hidden");
    $("promo-step-otp")?.classList.remove("hidden");
    toast("we sent you a code");
  } catch (e) {
    toast(`could not start: ${e.message}`, "err");
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
      throw new Error(`status ${r.status}: ${body}`);
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
    toast(`could not complete: ${e.message}`, "err");
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

export function initSettingsView() {
  $("settings-back")?.addEventListener("click", async () => {
    show("view-home");
    await renderActiveProviderChip();
  });
  $("settings-reset")?.addEventListener("click", handleReset);
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
