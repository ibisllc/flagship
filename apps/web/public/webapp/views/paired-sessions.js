// P2.8 — paired-sessions list + revoke. Calls P1.12 / P1.13.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { DELEGATION_COPY, allowCompanionBuild, endCompanionDelegation, listCompanionDelegations } from "../lib/companionDelegation.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";

registerView("view-paired-sessions");

/**
 * Browser sessions are browsers docked through Remote (`kind: "remote"`).
 * The box also lists the session each of the account's own devices paired
 * itself with (`kind: "device"`): those are Trusted devices, so they stay
 * out. A box from before `kind` existed lists everything; there, at least
 * this device's own session is never shown as a browser.
 */
export function browserSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) =>
    s?.kind === "remote" || (s?.kind == null && !s?.current),
  );
}

/** What this browser may build now, and the way to let it build one more app (SEC-AUTH-002). */
async function renderDelegationSlot(slot, sessionId) {
  let list = [];
  try {
    list = (await listCompanionDelegations(sessionId, screensFetch)).delegations ?? [];
  } catch {
    return; // a box from before delegations: nothing to offer
  }
  const admin = canSignAdminOrders();
  slot.innerHTML = `
    ${list.map((d) => `<div class="muted-sm text-xs">May ${escapeHtml(d.ops.join(" and "))} ${escapeHtml(d.serviceRef)}${d.expiresAt ? ` until ${escapeHtml(formatWhen(d.expiresAt))}` : ""} <button type="button" class="secondary" data-end-delegation="${escapeHtml(d.serviceRef)}">${escapeHtml(DELEGATION_COPY.end)}</button></div>`).join("")}
    ${admin
      ? `<button type="button" class="secondary mt-1" data-open-delegation>${escapeHtml(DELEGATION_COPY.open)}</button>`
      : `<p class="note">${escapeHtml(DELEGATION_COPY.adminOnly)}</p>`}
    <div class="hidden mt-2" data-delegation-form></div>`;
  slot.querySelectorAll("[data-end-delegation]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await endCompanionDelegation(sessionId, b.getAttribute("data-end-delegation"), screensFetch);
        await renderDelegationSlot(slot, sessionId);
      } catch (e) {
        toast(humanError(e), "err");
      }
    }),
  );
  slot.querySelector("[data-open-delegation]")?.addEventListener("click", async () => {
    const form = slot.querySelector("[data-delegation-form]");
    let apps = [];
    try {
      apps = (await screensFetch("/api/screens/apps-list")).apps ?? [];
    } catch (e) {
      toast(humanError(e), "err");
      return;
    }
    form.classList.remove("hidden");
    form.innerHTML = `
      <div class="card-title">${escapeHtml(DELEGATION_COPY.title)}</div>
      <p class="note">${escapeHtml(DELEGATION_COPY.intro)}</p>
      <label>App</label>
      <select data-d-app>${apps.map((a) => `<option value="${escapeHtml(a.serviceId)}">${escapeHtml(a.slug ?? a.serviceId)}</option>`).join("")}</select>
      <label class="inline-check mt-1"><input type="checkbox" data-d-op value="build" checked /> ${escapeHtml(DELEGATION_COPY.build)}</label>
      <label class="inline-check"><input type="checkbox" data-d-op value="deploy" /> ${escapeHtml(DELEGATION_COPY.deploy)}</label>
      <label class="mt-1">For</label>
      <select data-d-for><option value="1800000">30 minutes</option><option value="3600000" selected>1 hour</option><option value="14400000">4 hours</option><option value="86400000">24 hours</option></select>
      <button type="button" class="full-width mt-2" data-d-go>${escapeHtml(DELEGATION_COPY.allow)}</button>`;
    form.querySelector("[data-d-go]").addEventListener("click", async (ev) => {
      const ops = [...form.querySelectorAll("[data-d-op]:checked")].map((c) => c.value);
      const serviceRef = form.querySelector("[data-d-app]").value;
      if (!ops.length || !serviceRef) return;
      ev.currentTarget.disabled = true;
      try {
        const session = getSession();
        await allowCompanionBuild(
          { sessionId, serviceRef, ops, durationMs: Number(form.querySelector("[data-d-for]").value), umk: session.umk, signWithIrk: sensitiveSigner() },
          screensFetch,
        );
        toast("That browser can now change the app.");
        await renderDelegationSlot(slot, sessionId);
      } catch (e) {
        ev.currentTarget.disabled = false;
        toast(humanError(e), "err");
      }
    });
  });
}

export async function renderPairedSessions() {
  const root = $("paired-sessions-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch("/api/screens/paired-sessions/list");
    const sessions = browserSessions(body.sessions);
    if (!sessions.length) {
      root.innerHTML = '<div class="card placeholder">No browser sessions. Browsers you open through Remote show here.</div>';
      return;
    }
    root.innerHTML = sessions.map((s) => `
      <div class="card">
        <div class="row row-top">
          <div>
            <div class="weight-600">Session ${escapeHtml(s.tokenPrefix)} ${s.current ? '<span class="pill ok">this device</span>' : ""}</div>
            <div class="value text-xs">${escapeHtml(s.tokenPrefix)}…</div>
            <div class="faint-sm">added ${escapeHtml(formatWhen(s.addedAt))}</div>
          </div>
          ${s.current
            ? '<button class="secondary" disabled>can\'t revoke self</button>'
            : `<button class="secondary" data-action="revoke" data-prefix="${escapeHtml(s.tokenPrefix)}">revoke</button>`}
        </div>
        ${s.current ? "" : `<div class="mt-2" data-delegation-slot="${escapeHtml(s.tokenPrefix)}"></div>`}
      </div>
    `).join("");
    root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
      b.addEventListener("click", () => revoke(b.getAttribute("data-prefix")));
    });
    root.querySelectorAll("[data-delegation-slot]").forEach((slot) => void renderDelegationSlot(slot, slot.getAttribute("data-delegation-slot")));
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function revoke(prefix) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Revoke session ${prefix}…?`,
    message: "The device using this session token will be signed out immediately.",
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await screensFetch(
      `/api/screens/paired-sessions/${encodeURIComponent(prefix)}`,
      { method: "DELETE" },
    );
    toast("Revoked");
    await renderPairedSessions();
  } catch (e) {
    toast(e.message, "err");
  }
}

export function initPairedSessionsView() {
  $("paired-sessions-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("paired-sessions-refresh")?.addEventListener("click", () => {
    renderPairedSessions().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterPairedSessions() {
  show("view-paired-sessions");
  await renderPairedSessions();
}
