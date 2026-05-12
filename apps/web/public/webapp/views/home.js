import { bytesToHex } from "../keystore.js";
import { decorateHomeGrid } from "../lib/icons.js";
import { tickRenewals } from "../lib/leases.js";
import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { loadProviders } from "../providers.js";

registerView("view-home", { tab: "home" });

// #36 — empty-state pennant illustration. Inline SVG so we don't add
// a network round-trip for a single decorative asset; sized to ~140px
// tall so it reads as "illustration", not "icon", on mobile.
const PENNANT_SVG = `
<svg viewBox="0 0 240 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="empty-pennant">
  <defs>
    <linearGradient id="pennant-flag" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.95" />
      <stop offset="1" stop-color="var(--accent-press)" stop-opacity="0.85" />
    </linearGradient>
  </defs>
  <line x1="60" y1="20" x2="60" y2="150" stroke="var(--ink-muted)" stroke-width="3" stroke-linecap="round" />
  <circle cx="60" cy="20" r="4" fill="var(--ink-muted)" />
  <path d="M60 32 L180 38 L150 64 L180 90 L60 96 Z" fill="url(#pennant-flag)"
        stroke="var(--accent-press)" stroke-width="1.5" stroke-linejoin="round" />
  <line x1="40" y1="150" x2="200" y2="150" stroke="var(--border)" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 6" />
</svg>
`;

/** Render the zero-state card when the user has no servers yet. */
function renderEmptyServersList(root, { reason } = {}) {
  const hint = reason === "unpaired"
    ? "Pair the webapp to your phone or pod first, or jump straight in and build a fresh server."
    : "Plug in a USB drive, paste a build code on a target machine, and you're a few taps from your own cloud.";
  root.innerHTML = `
    <div class="card empty-state">
      ${PENNANT_SVG}
      <h3 class="empty-headline">Your first server is one tap away</h3>
      <p class="note empty-message">${escapeHtml(hint)}</p>
      <button class="primary full-width" id="empty-create-server">Create a server</button>
      <a class="pill mt-2" href="https://flagshipserver.com/build/" target="_blank" rel="noopener">
        Open flagshipserver.com/build/ →
      </a>
    </div>
  `;
  $("empty-create-server")?.addEventListener("click", async () => {
    // Step 5 of the first-run wizard (#25) — opens build/ in a new tab
    // and surfaces the draft composer locally. If the wizard module
    // isn't loaded yet (e.g. user is mid-pair), fall back to the
    // create-server view directly.
    try {
      const { enterWizard } = await import("./wizard.js");
      await enterWizard({ step: "create-server" });
    } catch {
      const { enterCreateServer } = await import("./create-server.js");
      await enterCreateServer();
    }
  });
}

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
    // #36 — real empty state, not a "no paired session" stub. The user
    // hasn't paired AND probably doesn't have a server yet — the CTA
    // sends them straight into the wizard (step 5 creates the first
    // server), which is the same destination as the empty server list.
    renderEmptyServersList(list, { reason: "unpaired" });
    return;
  }
  try {
    const r = await fetch(`/api/me/servers?sessionId=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.json();
    sessionStatusEl.textContent = "paired";
    sessionStatusEl.classList.add("ok");
    if (!body.servers.length) {
      renderEmptyServersList(list, { reason: "no-servers" });
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
  decorateHomeGrid(document);
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
