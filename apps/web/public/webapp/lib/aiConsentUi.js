// The owner's consent to one AI run that spends their key or Flagship Inference credits (N12,
// packages/server-daemon/src/buildmodes/adaptConsent.ts). The box answers the run's first request
// with HTTP 428 {code:"ai-consent", estimate}; this shows the estimate as it is (a token range, the
// provider, who pays) and, only on Continue, signs `flagship/ai-repair-consent/v1` for the client to
// resend the same request with `consent`. Cancel sends nothing, so nothing runs.

import { aiConsentBody } from "./aiRepairConsent.js";
import { escapeHtml } from "./util.js";
import { fmtNum, tr } from "./i18n.js";

const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  flagship: tr("Flagship Inference"),
};

export function providerDisplayName(provider) {
  return PROVIDER_NAMES[provider] ?? String(provider ?? "");
}

const OPERATIONS = new Set(["adapt", "repair", "sync"]);

/** The box's estimate from a refused run (428, or 403 when the one sent no longer covers it), or null. */
export function consentEstimate(e) {
  if (!e || (e.status !== 428 && e.status !== 403)) return null;
  const b = e.body;
  if (!b || typeof b !== "object" || b.code !== "ai-consent") return null;
  const est = b.estimate;
  if (!est || typeof est !== "object") return null;
  if (typeof est.provider !== "string" || !est.provider) return null;
  if (est.source !== "byok" && est.source !== "promo") return null;
  if (!OPERATIONS.has(est.operation)) return null;
  if (!Number.isSafeInteger(est.lowTokens) || !Number.isSafeInteger(est.highTokens) || est.highTokens < 1) return null;
  return { provider: est.provider, source: est.source, operation: est.operation, lowTokens: est.lowTokens, highTokens: est.highTokens };
}

/** The sheet's sentences for an estimate. */
export function consentText(est) {
  const provider = providerDisplayName(est.provider);
  return {
    title: tr("This uses AI that costs money"),
    range: tr("This run can use up to about {0} tokens. The run stops there.", fmtNum(est.highTokens)),
    payer:
      est.source === "promo"
        ? tr("Flagship Inference runs it, and it is paid from your free Flagship Inference credits.")
        : tr("{0} runs it with your own API key, so {0} bills you for it.", provider),
    once: tr("You are agreeing to this one run only. Nothing starts until you continue."),
  };
}

/** Continue / Cancel. Resolves true only on Continue. `note` is the box's reason for asking again. */
export function showAiConsentSheet(est, { note = "" } = {}) {
  const t = consentText(est);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="modal-card" role="document">
    <h3 class="modal-title" data-ai-consent>${escapeHtml(t.title)}</h3>
    ${note ? `<p class="err-text" data-ai-consent-note>${escapeHtml(note)}</p>` : ""}
    <p class="modal-message" data-ai-consent-range>${escapeHtml(t.range)}</p>
    <p class="modal-message" data-ai-consent-payer>${escapeHtml(t.payer)}</p>
    <p class="note">${escapeHtml(t.once)}</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="cancel">${escapeHtml(tr("Cancel"))}</button>
      <button data-choice="continue">${escapeHtml(tr("Continue"))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(false);
      }
    };
    overlay.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => close(b.getAttribute("data-choice") === "continue")));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => overlay.querySelector('[data-choice="cancel"]')?.focus({ preventScroll: true }));
  });
}

/**
 * Run `send(consent)` (a request that may spend AI). On the box's 428 the owner sees the estimate;
 * Continue signs a consent for exactly it and sends once more. Resolves to send's result, or
 * `{cancelled: true}` when the owner said no. A second refusal (the estimate grew, the provider
 * changed) asks again with the box's reason, at most twice in all.
 */
export async function withAiConsent({ send, serverDomain, buildId, sign, ask = showAiConsentSheet, now = Date.now }) {
  let consent;
  let note = "";
  for (let round = 0; ; round++) {
    try {
      return await send(consent);
    } catch (e) {
      const est = consentEstimate(e);
      if (!est || round >= 2) throw e;
      if (round > 0) note = typeof e.body?.error === "string" ? e.body.error : "";
      if (!(await ask(est, { note }))) return { cancelled: true };
      consent = await aiConsentBody(
        { serverDomain, buildId, operation: est.operation, provider: est.provider, source: est.source, highTokens: est.highTokens, issuedAt: now() },
        sign,
      );
    }
  }
}
