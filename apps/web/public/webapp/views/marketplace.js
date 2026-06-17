// P2.4 — Marketplace browse + install. Calls /api/screens/marketplace-browse
// (P1.4) for the listings and the daemon's /api/services for install.
//
// Task #28 — scan-grade pill (A/B/C/F) per listing with explanatory
// tooltip. Ungraded listings render an "ungraded" pill since the
// scanner service is still in flight (see CLAUDE.md "Current status &
// open work"). The `scan_grade` field on /api/marketplace/search
// listings is null today; the BFF passes it through verbatim.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { installFromMarketplace } from "../lib/installService.js";
import { llmKeyEnvVarFor } from "../lib/marketplaceLlmKey.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-marketplace");

/**
 * Render the A/B/C/F scan-grade as a pill with a tooltip explaining
 * what the grade means. Listings that haven't been scanned yet (the
 * field is `null` until the scanner service catches up) render an
 * "ungraded" pill.
 */
export function scanGradePill(grade) {
  const g = typeof grade === "string" ? grade.toUpperCase() : null;
  const map = {
    A: { cls: "ok", tip: "passed every scanner check — no CVEs, no SUID surprises, deterministic build" },
    B: { cls: "ok", tip: "passed scanner checks with minor advisories — safe to install" },
    C: { cls: "warn", tip: "scanner found medium-severity issues — review the report before installing" },
    D: { cls: "warn", tip: "scanner found high-severity issues — install at your own risk" },
    F: { cls: "err", tip: "scanner found critical issues — install discouraged" },
  };
  if (g && map[g]) {
    const { cls, tip } = map[g];
    return `<span class="pill ${cls}" title="${escapeHtml(tip)}">scan ${escapeHtml(g)}</span>`;
  }
  return '<span class="pill" title="not yet scanned — Flagship\'s scanner service is queueing this listing">ungraded</span>';
}

export async function renderMarketplace() {
  const root = $("marketplace-content");
  // The marketplace is meant to be browsable before you own a server —
  // it's a catalog, not something served by your pod. Until a central
  // catalog exists, show a friendly placeholder instead of a
  // "not paired to a server yet" error when there's no pod.
  if (!getPodBaseUrl()) {
    root.innerHTML = '<div class="card placeholder">The marketplace is coming soon.</div>';
    return;
  }
  root.innerHTML = skeletonCards(4);
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
      const gradeBadge = scanGradePill(l.scan_grade ?? l.scanGrade ?? null);
      return `
        <div class="card" data-key="${safeKey}">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(l.title)} ${installedBadge} ${gradeBadge} ${llmBadge}</div>
              <div class="muted-sm">${escapeHtml(l.summary)}</div>
              <div class="value text-xs">${escapeHtml(l.creator)}/${escapeHtml(l.slug)}</div>
              <div class="faint-sm">${l.installCount} installs</div>
            </div>
            ${l.alreadyInstalled
              ? '<button class="secondary" disabled>installed</button>'
              : `<button data-action="install" data-creator="${escapeHtml(l.creator)}" data-slug="${escapeHtml(l.slug)}">install</button>`}
          </div>
        </div>
      `;
    }).join("");
    const byKey = new Map(
      body.listings.map((l) => [`${l.creator}/${l.slug}`, l]),
    );
    root.querySelectorAll('[data-action="install"]').forEach((b) => {
      b.addEventListener("click", () => {
        const creator = b.getAttribute("data-creator");
        const slug = b.getAttribute("data-slug");
        runInstall(byKey.get(`${creator}/${slug}`) ?? { creator, slug }, b);
      });
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function runInstall(listing, btn) {
  const { creator, slug } = listing;
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Install ${creator}/${slug}?`,
    message: "The signed app envelope is verified against your IRK before the daemon starts the container.",
    okLabel: "Install",
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    await installFromMarketplace({ creator, slug });
    toast(`installed ${creator}/${slug}`);
    // An app that needs an LLM key would otherwise install broken with no
    // visible next step: send the owner straight to "Configure environment"
    // with the expected env-var name prefilled so they can paste the key.
    // The value is set on the box (sealed env store); .com never sees it.
    if (listing.requiresLlmKey) {
      const envVar = llmKeyEnvVarFor(listing);
      const serverFqdn = (getPodBaseUrl() ?? "")
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      const { enterServiceEnv } = await import("./service-env.js");
      // serviceId mirrors the daemon's `<creator>--<slug>` (installService).
      await enterServiceEnv(`${creator}--${slug}`, creator, slug, serverFqdn, envVar);
      return;
    }
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
