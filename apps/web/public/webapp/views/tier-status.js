// P2.11 — tier dashboard. Calls /api/screens/tier-status (P1.16).

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-tier-status");

function pct(used, quota) {
  if (typeof used !== "number" || typeof quota !== "number" || quota === 0) return 0;
  return Math.min(100, Math.round((used / quota) * 100));
}

export async function renderTierStatus() {
  const root = $("tier-status-content");
  root.innerHTML = skeletonCards(2);
  try {
    const body = await screensFetch("/api/screens/tier-status");
    const tierBadge = body.tier === "free"
      ? '<span class="pill">free</span>'
      : body.tier === "promo"
      ? '<span class="pill ok">promo</span>'
      : '<span class="pill ok">BYOK</span>';
    const llmDay = body.llmCreditsRemainingDay;
    const llmTotal = body.llmCreditsRemainingTotal;
    const dispatchUsed = body.dispatcherUsageGBmonth;
    const dispatchQuota = body.dispatcherFreeQuotaGBmonth;
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">Tier</span><span>${tierBadge}</span></div>
      </div>
      <h2 class="mt-4">LLM credits</h2>
      <div class="card">
        ${typeof llmDay === "number"
          ? `<div class="row"><span class="label">today remaining</span><span class="value">${llmDay.toLocaleString()}</span></div>`
          : '<div class="row"><span class="label">today</span><span class="value">— (BYOK or promo not in use)</span></div>'}
        ${typeof llmTotal === "number"
          ? `<div class="row"><span class="label">lifetime remaining</span><span class="value">${llmTotal.toLocaleString()}</span></div>`
          : ""}
      </div>
      <h2 class="mt-4">Dispatcher relay</h2>
      <div class="card">
        ${typeof dispatchUsed === "number"
          ? `
            <div class="row">
              <span class="label">this month</span>
              <span class="value">${dispatchUsed.toFixed(2)} GB / ${typeof dispatchQuota === "number" ? `${dispatchQuota.toFixed(0)} GB free` : "—"}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${pct(dispatchUsed, dispatchQuota)}%"></div>
            </div>
          `
          : '<div class="row"><span class="label">usage</span><span class="value">—</span></div>'}
      </div>
      <h2 class="mt-4">Custom domains</h2>
      ${(body.customDomains ?? []).length === 0
        ? '<div class="card placeholder">none — your default subdomain is forever-free</div>'
        : (body.customDomains ?? []).map((d) => `
          <div class="card"><div class="value">${escapeHtml(d)}</div></div>
        `).join("")}
      <h2 class="mt-4">Reserved names</h2>
      ${(body.reservedNames ?? []).length === 0
        ? '<div class="card placeholder">none — your username is FCFS-free</div>'
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
