// P2.4 — Marketplace browse + install. Calls /api/screens/marketplace-browse
// (P1.4) for the listings and the daemon's /api/apps for install.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { installFromMarketplace } from "../lib/installApp.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-marketplace");

export async function renderMarketplace() {
  const root = $("marketplace-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch("/api/screens/marketplace-browse");
    if (!body.listings?.length) {
      root.innerHTML = '<div class="card placeholder">no listings yet</div>';
      return;
    }
    root.innerHTML = body.listings.map((l) => {
      const safeKey = `${escapeHtml(l.creator)}/${escapeHtml(l.slug)}`;
      const installedBadge = l.alreadyInstalled
        ? '<span class="pill ok">installed</span>'
        : "";
      const llmBadge = l.requiresLlmKey
        ? '<span class="pill">needs LLM key</span>'
        : "";
      return `
        <div class="card" data-key="${safeKey}">
          <div class="row" style="align-items:flex-start;">
            <div>
              <div style="font-weight:600;">${escapeHtml(l.title)} ${installedBadge} ${llmBadge}</div>
              <div style="color:var(--fg-mute); font-size:0.82rem;">${escapeHtml(l.summary)}</div>
              <div class="value" style="font-size:0.78rem; margin-top:0.2rem;">${escapeHtml(l.creator)}/${escapeHtml(l.slug)}</div>
              <div style="color:var(--fg-mute); font-size:0.78rem;">${l.installCount} installs</div>
            </div>
            ${l.alreadyInstalled
              ? '<button class="secondary" disabled>installed</button>'
              : `<button data-action="install" data-creator="${escapeHtml(l.creator)}" data-slug="${escapeHtml(l.slug)}">install</button>`}
          </div>
        </div>
      `;
    }).join("");
    root.querySelectorAll('[data-action="install"]').forEach((b) => {
      b.addEventListener("click", () =>
        runInstall(
          b.getAttribute("data-creator"),
          b.getAttribute("data-slug"),
          b,
        ),
      );
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function runInstall(creator, slug, btn) {
  if (!confirm(`Install ${creator}/${slug}?`)) return;
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    await installFromMarketplace({ creator, slug });
    toast(`installed ${creator}/${slug}`);
    await renderMarketplace();
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.textContent = "install";
  }
}

export function initMarketplaceView() {
  $("marketplace-back")?.addEventListener("click", () => show("view-home"));
  $("marketplace-refresh")?.addEventListener("click", () => {
    renderMarketplace().catch((e) => toast(String(e), "err"));
  });
}

export async function enterMarketplace() {
  show("view-marketplace");
  await renderMarketplace();
}
