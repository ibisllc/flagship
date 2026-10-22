// Developer console — the signed-in creator's marketplace listings, their
// sales, and the payout owed.
//
// Reads GET /api/developer/sales/<creator>?issuedAt=<ms>&sig=<hex>, where the
// sig is Ed25519 over the canonical bytes
//     flagship/developer-sales-read/v1|<creator>|<issuedAt>
// signed with the user's IRK (same-origin fetch, like installService.js). The
// creator is the signed-in user's username (lib/state.js `getSession()`).

import { $, registerView, show } from "../lib/router.js";
import { bytesToHex, signWithIrk } from "../keystore.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { scanGradePill } from "./marketplace.js";

registerView("view-developer");

export const TAG_DEVELOPER_SALES_READ = "flagship/developer-sales-read/v1";

export const EMPTY_STATE_HTML =
  '<div class="card placeholder">You have no marketplace listings yet.</div>';

/** Canonical bytes the backend Ed25519-verifies against the user's IRK. */
export function canonicalDeveloperSalesBytes(creator, issuedAt) {
  return new TextEncoder().encode(
    [TAG_DEVELOPER_SALES_READ, creator, issuedAt].join("|"),
  );
}

/** Format an integer cent amount as a dollar string (handles negatives). */
export function formatCents(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

/** Basis-points → a human percent ("1500" → "15%", "1250" → "12.5%"). */
export function formatCutPct(cutBps) {
  const bps = Number(cutBps) || 0;
  const pct = bps / 100;
  // Drop trailing zeros: 1500 → "15%", 1250 → "12.5%".
  return `${Number(pct.toFixed(2))}%`;
}

export function renderTotalsHtml(totals, cutBps) {
  const t = totals ?? {};
  const payout = t.payout_owed_cents ?? t.net_cents;
  return `
    <div class="card">
      <div class="row row-top">
        <div>
          <div class="faint-sm">payout owed</div>
          <div class="weight-600">${formatCents(payout)}</div>
        </div>
        <div>
          <div class="faint-sm">gross</div>
          <div class="value">${formatCents(t.gross_cents)}</div>
        </div>
      </div>
      <div class="muted-sm">platform cut ${escapeHtml(formatCutPct(cutBps))} · ${formatCents(t.cut_cents)}</div>
      <div class="muted-sm">${Number(t.sale_count) || 0} sales · ${Number(t.install_count) || 0} installs</div>
    </div>`;
}

export function renderListingRowHtml(listing) {
  const l = listing ?? {};
  const price = l.is_paid ? formatCents(l.price_usd_cents) : "free";
  const grade = scanGradePill(l.scan_grade ?? l.scanGrade ?? null);
  return `
    <tr data-listing="${escapeHtml(l.listing_id ?? "")}">
      <td>${escapeHtml(l.name ?? l.slug ?? "")}</td>
      <td>${escapeHtml(price)}</td>
      <td>${Number(l.install_count) || 0}</td>
      <td>${Number(l.sale_count) || 0}</td>
      <td>${formatCents(l.gross_cents)}</td>
      <td>${formatCents(l.net_cents)}</td>
      <td>${grade}</td>
    </tr>`;
}

export function renderListingsTableHtml(listings) {
  const rows = (listings ?? []).map(renderListingRowHtml).join("");
  return `
    <div class="card">
      <table class="developer-listings">
        <thead>
          <tr><th>app</th><th>price</th><th>installs</th><th>sales</th><th>gross</th><th>net</th><th>scan</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderSalesListHtml(sales) {
  const items = (sales ?? []).slice(0, 20).map((s) => {
    const s2 = s ?? {};
    return `<div class="row row-top">
        <div class="muted-sm">${escapeHtml(s2.buyer ?? "")}</div>
        <div class="value">${formatCents(s2.net_cents)}</div>
      </div>`;
  }).join("");
  if (!items) return "";
  return `<div class="card"><div class="faint-sm">recent sales</div>${items}</div>`;
}

/**
 * Sign the read proof and fetch the developer-sales report. Dependency-
 * injected (fetch / signWithIrk / now / origin) so it's testable without a
 * DOM or a real keystore.
 */
export async function fetchDeveloperSales(
  { creator, umk, signWithIrk: sign = signWithIrk },
  { fetch: fetchImpl = fetch, origin = "", now = () => Date.now() } = {},
) {
  if (!umk) throw new Error("unlock first");
  if (!creator) throw new Error("no username on this account yet");
  const issuedAt = now();
  const sig = await sign(umk, canonicalDeveloperSalesBytes(creator, issuedAt));
  const url = `${origin}/api/developer/sales/${encodeURIComponent(creator)}`
    + `?issuedAt=${issuedAt}&sig=${bytesToHex(sig)}`;
  const r = await fetchImpl(url);
  if (!r.ok) {
    const text = await (r.text?.().catch(() => "") ?? Promise.resolve(""));
    throw new Error(`developer sales fetch failed: ${r.status} ${text}`.trim());
  }
  return await r.json();
}

export async function renderDeveloper() {
  const root = $("developer-content");
  if (!root) return;
  const session = getSession();
  if (!session.umk) {
    root.innerHTML = '<div class="card placeholder">Unlock to view your developer console.</div>';
    return;
  }
  const creator = session.username;
  if (!creator) {
    root.innerHTML = '<div class="card placeholder">No username on this account yet.</div>';
    return;
  }
  root.innerHTML = skeletonCards(3);
  try {
    const body = await fetchDeveloperSales({ creator, umk: session.umk });
    if (!body.listings?.length) {
      root.innerHTML = EMPTY_STATE_HTML;
      return;
    }
    root.innerHTML =
      renderTotalsHtml(body.totals, body.cut_bps)
      + renderListingsTableHtml(body.listings)
      + renderSalesListHtml(body.sales);
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message ?? String(e))}</p></div>`;
  }
}

export function initDeveloperView() {
  $("developer-back")?.addEventListener("click", () => show("view-home"));
  $("developer-refresh")?.addEventListener("click", () => {
    renderDeveloper().catch((e) => toast(String(e), "err"));
  });
}

export async function enterDeveloper() {
  show("view-developer");
  await renderDeveloper();
}
