import { bytesToHex } from "../keystore.js";
import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { loadProviders } from "../providers.js";

registerView("view-home");

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
      '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No paired session yet. Tap "Pair to a server" to start.</p></div>';
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
        '<div class="card"><p style="margin:0;color:var(--fg-mute);font-size:0.9rem;">No servers registered yet.</p></div>';
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
  } catch (e) {
    sessionStatusEl.textContent = "error";
    list.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(String(e))}</p></div>`;
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
          <div style="font-weight: 600;">No active provider</div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">claim free credits or add your own key</div>
        </div>
        <button class="secondary" id="chip-settings">settings</button>
      </div>
    `;
  } else {
    const promo = isPromoEntry(e);
    chip.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight: 600;">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div style="color: var(--fg-mute); font-size: 0.82rem;">${promo ? "Flagship-issued key — flagshipserver.com cannot read prompts" : "key on this device — flagshipserver.com cannot read prompts"}</div>
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
