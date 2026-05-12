import { bytesToHex } from "../keystore.js";
import { tickRenewals } from "../lib/leases.js";
import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { loadProviders } from "../providers.js";

registerView("view-home");

// 30-minute cadence for the silent lease renewer. The renewer also
// fires opportunistically on every home-view enter, so this interval
// is a safety net for users who leave the webapp open all day.
const RENEWAL_TICK_MS = 30 * 60 * 1000;
let renewalTimer = null;
let renewalLastServerList = null; // dedupe: only kick a tick when servers change

const FLAGSHIP_PROMO_LABEL_PREFIX = "Flagship promo";

function isPromoEntry(e) {
  return e?.label?.startsWith(FLAGSHIP_PROMO_LABEL_PREFIX);
}

export async function renderHome() {
  const session = getSession();
  setSubtitle(session.username ? `signed in as ${session.username}` : "signed in");
  $("home-username").textContent = session.username || "(not set)";
  $("home-irkpub").textContent = session.irk
    ? bytesToHex(session.irk.publicKey).slice(0, 16) + "…" + bytesToHex(session.irk.publicKey).slice(-4)
    : "—";

  const sid = localStorage.getItem("flagship.sessionId");
  const sessionStatusEl = $("session-status");
  const list = $("servers-list");
  list.innerHTML = "";
  if (!sid) {
    sessionStatusEl.textContent = "unpaired";
    sessionStatusEl.classList.remove("ok");
    list.innerHTML =
      '<div class="card"><p class="note">No paired session yet. Tap "Pair to a server" to start.</p></div>';
    return;
  }
  try {
    const r = await fetch(`/api/me/servers?sessionId=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.json();
    sessionStatusEl.textContent = "paired";
    sessionStatusEl.classList.add("ok");
    if (!body.servers.length) {
      list.innerHTML =
        '<div class="card"><p class="note">No servers registered yet.</p></div>';
      return;
    }
    for (const s of body.servers) {
      const card = document.createElement("div");
      card.className = "card";
      const status = s.revoked
        ? `<span class="pill err">revoked: ${escapeHtml(s.revoked.reason)}</span>`
        : '<span class="pill ok">active</span>';
      card.innerHTML = `<div class="row"><span class="value">${escapeHtml(s.serverId)}</span>${status}</div>`;
      list.appendChild(card);
    }
    // Silent auto-renewal of long-lived leases. Fires on every home
    // enter (cheap — no-ops when no leases are close to expiry) and
    // refreshes the timer so the cadence resets each time the user
    // re-engages with the webapp.
    const liveServerIds = body.servers
      .filter((s) => !s.revoked)
      .map((s) => s.serverId);
    scheduleRenewals(liveServerIds);
  } catch (e) {
    sessionStatusEl.textContent = "error";
    list.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(String(e))}</p></div>`;
  }
}

export async function renderActiveProviderChip() {
  const session = getSession();
  const chip = $("home-active-provider");
  if (!chip || !session.umk) return;
  const stored = await loadProviders(session.umk);
  const e = stored.entries.find((x) => x.id === stored.activeId);
  if (!e) {
    chip.innerHTML = `
      <div class="row">
        <div>
          <div class="weight-600">No active provider</div>
          <div class="muted-sm">claim free credits or add your own key</div>
        </div>
        <button class="secondary" id="chip-settings">settings</button>
      </div>
    `;
  } else {
    const promo = isPromoEntry(e);
    chip.innerHTML = `
      <div class="row">
        <div>
          <div class="weight-600">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="muted-sm">${promo ? "Flagship-issued key — flagshipserver.com cannot read prompts" : "key on this device — flagshipserver.com cannot read prompts"}</div>
        </div>
        <button class="secondary" id="chip-settings">manage</button>
      </div>
    `;
  }
  $("chip-settings")?.addEventListener("click", async () => {
    show("view-settings");
    const { renderProviders } = await import("./settings.js");
    await renderProviders();
  });
}

export async function enterHome() {
  show("view-home");
  await renderHome();
  await renderActiveProviderChip();
}

export function initHomeView({ onPair, onSettings }) {
  $("pair-with-server")?.addEventListener("click", onPair);
  $("open-settings")?.addEventListener("click", onSettings);
}

/**
 * Kick off the renewer for the user's known servers and (re)arm a
 * 30-min interval. The interval is deliberately a no-op until the
 * lease enters its 1-day pre-expiry window, so it's cheap to run
 * frequently. We dedupe by stringified server list so we don't
 * re-schedule on every render.
 */
function scheduleRenewals(serverFqdns) {
  const key = serverFqdns.slice().sort().join("|");
  if (key === renewalLastServerList && renewalTimer) {
    // Already running for the same server set — fire once now (cheap)
    // so app-open semantics hold, but don't reset the interval.
    void tickRenewals(serverFqdns).catch(() => {});
    return;
  }
  renewalLastServerList = key;
  if (renewalTimer) clearInterval(renewalTimer);
  void tickRenewals(serverFqdns).catch(() => {});
  if (serverFqdns.length === 0) {
    renewalTimer = null;
    return;
  }
  renewalTimer = setInterval(() => {
    void tickRenewals(serverFqdns).catch(() => {});
  }, RENEWAL_TICK_MS);
}

/** Stop the renewer (called on lock so a new account doesn't inherit timers). */
export function stopRenewals() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
  renewalLastServerList = null;
}
