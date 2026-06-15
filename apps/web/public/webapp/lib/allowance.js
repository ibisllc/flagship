// #6 / #7 — usage/allowance dashboard + over-allowance upgrade alert.
//
// Reads the public, UNAUTHENTICATED `GET /api/users/:u/allowance` on .com
// (the only usage-metered thing is PUBLIC-BANDWIDTH egress) and renders a
// Home card: tier, a labeled GB progress bar, % used, remaining, and the
// monthly reset date. When usage is approaching/over the quota the same card
// carries a prominent upgrade CTA to /pro.
//
// Everything here is pure + DOM-free except `renderAllowanceCard`, so the
// formatting + copy + colour selection is unit-testable without a browser.
// The fetch path is deliberately best-effort: a failure / `!ok` / missing
// endpoint resolves to null so Home never breaks.

const COM_BASE = "https://flagshipserver.com";

/** /pro membership + private-payment page (a separate static surface). */
export const PRO_URL = "/pro";

/** Marketing labels for each backend tier name. The paid tiers sit under the
 *  "Pro" umbrella. */
export const TIER_LABELS = {
  free: "Free",
  hobby: "Pro",
  maker: "Pro Max",
};

/** Human label for a tier name (unknown → the raw value, never throws). */
export function tierLabel(tier) {
  return TIER_LABELS[tier] ?? String(tier ?? "");
}

const GB = 1024 * 1024 * 1024;

/**
 * Format a byte count as GB with one decimal (e.g. 50 GB → "50 GB",
 * 13_314_398_028 → "12.4 GB"). A whole number of GB drops the ".0" so the
 * common quota labels read cleanly. Negative / non-finite → "0 GB".
 */
export function formatGB(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 GB";
  const gb = n / GB;
  // One decimal, but strip a trailing ".0" (so quotas like 50/250 read clean).
  const rounded = Math.round(gb * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} GB`;
}

/** "12.4 GB of 50 GB" — the progress-bar caption. */
export function formatUsedOfQuota(usedBytes, quotaBytes) {
  return `${formatGB(usedBytes)} of ${formatGB(quotaBytes)}`;
}

/** Whole-number percent of quota used (clamped 0..100 for the bar width;
 *  the displayed % is NOT clamped above 100 so an over-quota account reads
 *  e.g. "112% used"). */
export function usedPercent(usedFraction) {
  const f = Number(usedFraction);
  if (!Number.isFinite(f) || f <= 0) return 0;
  return Math.round(f * 100);
}

/** Bar fill width 0..100 (clamped both ends). */
export function barWidthPercent(usedFraction) {
  return Math.max(0, Math.min(100, usedPercent(usedFraction)));
}

/**
 * Map the backend `state` onto a bar colour bucket:
 *   ok → "ok" (teal / normal) · approaching → "warn" (amber) · over → "err"
 *   (red). Unknown states fall back to "ok".
 */
export function barTone(state) {
  switch (state) {
    case "approaching":
      return "warn";
    case "over":
      return "err";
    default:
      return "ok";
  }
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "Resets 1 Jul" — the quota resets on the 1st of the month AFTER the given
 * "YYYY-MM" period. December rolls to the next January. A malformed period
 * yields "" (the caller omits the line).
 */
export function resetLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!m) return "";
  let month = Number(m[2]); // 1..12, the CURRENT period
  // Reset is the 1st of the NEXT month.
  let next = month % 12; // 0..11 index for the next month (12 → 0 = Jan)
  return `Resets 1 ${MONTHS[next]}`;
}

/**
 * Whether the over-allowance upgrade alert (#7) should show. True for the
 * "approaching" and "over" states only.
 */
export function shouldShowUpgradeAlert(state) {
  return state === "approaching" || state === "over";
}

/**
 * Select the upgrade-alert copy for the given allowance status. Returns null
 * when no alert applies (state "ok"). The three cases mirror the locked copy:
 *   - approaching → soft nudge with the % used.
 *   - over + hardCapped (free) → "you've hit your cap, public traffic paused".
 *   - over + !hardCapped (paid) → "overage applies, consider Pro Max".
 *
 * @param {{ state?: string, usedFraction?: number, hardCapped?: boolean }} a
 * @returns {{ tone: string, message: string, cta: string } | null}
 */
export function upgradeAlertCopy(a = {}) {
  const { state } = a;
  if (state === "approaching") {
    const pct = usedPercent(a.usedFraction);
    return {
      tone: "warn",
      message: `You've used ${pct}% of your bandwidth this month. Upgrade to Pro for more.`,
      cta: "Upgrade to Pro",
    };
  }
  if (state === "over") {
    if (a.hardCapped) {
      return {
        tone: "err",
        message:
          "You've hit your free bandwidth cap — public traffic is paused until next month or until you upgrade.",
        cta: "Upgrade to Pro",
      };
    }
    return {
      tone: "err",
      message:
        "You're over your plan's bandwidth — overage applies. Consider Pro Max.",
      cta: "Upgrade to Pro Max",
    };
  }
  return null;
}

/** Minimal HTML-escape (mirrors lib/util.escapeHtml; kept local so the module
 *  is self-contained + unit-testable without the view layer). */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate an allowance payload into the normalized shape the renderer uses,
 * or null if it's not a usable `ok:true` response. Defensive: every numeric
 * field is coerced + defaulted so a partial payload still renders cleanly.
 */
export function normalizeAllowance(raw) {
  if (!raw || raw.ok !== true) return null;
  const tier = typeof raw.tier === "string" ? raw.tier : "free";
  const usedBytes = Number(raw.usedBytes) || 0;
  const quotaBytes = Number(raw.quotaBytes) || 0;
  const remainingBytes = Number.isFinite(Number(raw.remainingBytes))
    ? Number(raw.remainingBytes)
    : Math.max(0, quotaBytes - usedBytes);
  const usedFraction = Number.isFinite(Number(raw.usedFraction))
    ? Number(raw.usedFraction)
    : quotaBytes > 0
      ? usedBytes / quotaBytes
      : 0;
  const state =
    raw.state === "approaching" || raw.state === "over" ? raw.state : "ok";
  return {
    username: typeof raw.username === "string" ? raw.username : "",
    tier,
    period: typeof raw.period === "string" ? raw.period : "",
    usedBytes,
    quotaBytes,
    remainingBytes,
    usedFraction,
    overQuota: !!raw.overQuota,
    overageUsd: Number(raw.overageUsd) || 0,
    state,
    hardCapped: !!raw.hardCapped,
  };
}

/**
 * Build the inner HTML of the allowance card from a NORMALIZED status object
 * (see {@link normalizeAllowance}). Pure string builder so the layout + copy
 * + colour bucket are unit-testable without a DOM.
 *
 * @param {ReturnType<typeof normalizeAllowance>} a
 */
export function allowanceCardHtml(a) {
  const tone = barTone(a.state);
  const width = barWidthPercent(a.usedFraction);
  const pct = usedPercent(a.usedFraction);
  const reset = resetLabel(a.period);
  const alert = upgradeAlertCopy(a);

  const alertHtml = alert
    ? `
      <div class="allowance-alert allowance-alert--${escapeHtml(alert.tone)}">
        <p class="allowance-alert-msg">${escapeHtml(alert.message)}</p>
        <a class="primary full-width allowance-upgrade" href="${escapeHtml(
          PRO_URL,
        )}" data-allowance-upgrade>${escapeHtml(alert.cta)}</a>
      </div>`
    : "";

  return `
    <div class="card allowance-card" data-allowance-card>
      <div class="row allowance-head">
        <div class="weight-600">Bandwidth this month</div>
        <span class="pill allowance-tier">${escapeHtml(tierLabel(a.tier))}</span>
      </div>
      <div class="allowance-bar" role="progressbar"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
           aria-label="Bandwidth used">
        <div class="allowance-bar-fill allowance-bar-fill--${escapeHtml(
          tone,
        )}" style="width:${width}%"></div>
      </div>
      <div class="row allowance-meta">
        <span class="muted-sm">${escapeHtml(
          formatUsedOfQuota(a.usedBytes, a.quotaBytes),
        )}</span>
        <span class="muted-sm">${pct}% used</span>
      </div>
      <div class="row allowance-meta">
        <span class="muted-sm">${escapeHtml(
          formatGB(a.remainingBytes),
        )} remaining</span>
        ${reset ? `<span class="muted-sm">${escapeHtml(reset)}</span>` : ""}
      </div>
      ${alertHtml}
    </div>
  `;
}

/**
 * Best-effort fetch of the public allowance status for `username`. Resolves to
 * a NORMALIZED status object, or null on any failure / `!ok` / missing
 * endpoint so the caller can no-op cleanly.
 *
 * @param {string} username
 * @param {{ fetch?, comBase?: string }} [deps]
 */
export async function fetchAllowance(username, deps = {}) {
  if (!username) return null;
  const base = deps.comBase ?? COM_BASE;
  const f = deps.fetch ?? fetch;
  try {
    const r = await f(
      `${base}/api/users/${encodeURIComponent(username)}/allowance`,
      { cache: "no-store" },
    );
    if (!r.ok) return null;
    const body = await r.json();
    return normalizeAllowance(body);
  } catch {
    return null;
  }
}

/**
 * Fetch + render the allowance card into `host` (a container element). On any
 * failure the host is left empty (the card simply doesn't appear) — Home is
 * never broken by a metering hiccup. Returns the normalized status (or null).
 *
 * @param {HTMLElement|null} host
 * @param {string} username
 * @param {{ fetch?, comBase?: string }} [deps]
 */
export async function renderAllowanceCard(host, username, deps = {}) {
  if (!host) return null;
  const a = await fetchAllowance(username, deps);
  if (!a) {
    host.innerHTML = "";
    return null;
  }
  host.innerHTML = allowanceCardHtml(a);
  return a;
}
