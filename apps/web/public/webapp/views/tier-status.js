// P2.11 — tier dashboard. Calls /api/screens/tier-status (P1.16).

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { fetchSeparateListsSummary, separateListsWarning } from "../lib/listScope.js";

import { tr } from "../lib/i18n.js";
registerView("view-tier-status");

function pct(used, quota) {
  if (typeof used !== "number" || typeof quota !== "number" || quota === 0) return 0;
  return Math.min(100, Math.round((used / quota) * 100));
}

export async function renderTierStatus() {
  const root = $("tier-status-content");
  root.innerHTML = skeletonCards(2);
  try {
    const [body, lists] = await Promise.all([
      screensFetch("/api/screens/tier-status"),
      fetchSeparateListsSummary({ fetchJson: (path) => screensFetch(path) }),
    ]);
    // Pro ending sends apps with separate lists back to one list (feat/marketplace).
    const listsWarning = separateListsWarning(lists);
    const tierBadge = body.tier === "free"
      ? `<span class="pill">${tr("free")}</span>`
      : body.tier === "promo"
      ? `<span class="pill ok">${tr("promo")}</span>`
      : `<span class="pill ok">${tr("BYOK")}</span>`;
    const llmDay = body.llmCreditsRemainingDay;
    const llmTotal = body.llmCreditsRemainingTotal;
    const dispatchUsed = body.dispatcherUsageGBmonth;
    const dispatchQuota = body.dispatcherFreeQuotaGBmonth;
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">${tr("Tier")}</span><span>${tierBadge}</span></div>
      </div>
      ${listsWarning ? `<div class="card mt-3 warn" id="tier-status-separate-lists-warning" data-testid="tier-status-separate-lists-warning"><p class="note">${escapeHtml(listsWarning)}</p></div>` : ""}
      <h2 class="mt-4">${tr("LLM credits")}</h2>
      <div class="card">
        ${typeof llmDay === "number"
          ? `<div class="row"><span class="label">${tr("today remaining")}</span><span class="value">${llmDay.toLocaleString()}</span></div>`
          : `<div class="row"><span class="label">${tr("today")}</span><span class="value">${tr("— (BYOK or promo not in use)")}</span></div>`}
        ${typeof llmTotal === "number"
          ? `<div class="row"><span class="label">${tr("lifetime remaining")}</span><span class="value">${llmTotal.toLocaleString()}</span></div>`
          : ""}
      </div>
      <h2 class="mt-4">${tr("Dispatcher relay")}</h2>
      <div class="card">
        ${typeof dispatchUsed === "number"
          ? `
            <div class="row">
              <span class="label">${tr("this month")}</span>
              <span class="value">${tr("{0} GB / {1}", dispatchUsed.toFixed(2), typeof dispatchQuota === "number" ? tr("{0} GB free", dispatchQuota.toFixed(0)) : "—")}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${pct(dispatchUsed, dispatchQuota)}%"></div>
            </div>
          `
          : `<div class="row"><span class="label">${tr("usage")}</span><span class="value">—</span></div>`}
      </div>
      <h2 class="mt-4">${tr("Custom domains")}</h2>
      ${(body.customDomains ?? []).length === 0
        ? `<div class="card placeholder">${tr("none — your default subdomain is forever-free")}</div>`
        : (body.customDomains ?? []).map((d) => `
          <div class="card"><div class="value">${escapeHtml(d)}</div></div>
        `).join("")}
      <h2 class="mt-4">${tr("Reserved names")}</h2>
      ${(body.reservedNames ?? []).length === 0
        ? `<div class="card placeholder">${tr("none — your username is FCFS-free")}</div>`
        : (body.reservedNames ?? []).map((n) => `
          <div class="card"><div class="value">${escapeHtml(n)}</div></div>
        `).join("")}
    `;
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

export function initTierStatusView() {
  $("tier-status-back")?.addEventListener("click", () => show("view-home"));
  $("tier-status-refresh")?.addEventListener("click", () => {
    renderTierStatus().catch((e) => toast(String(e), "err"));
  });
}

export async function enterTierStatus() {
  show("view-tier-status");
  await renderTierStatus();
}
