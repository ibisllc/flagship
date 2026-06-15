/**
 * Home "Become a Pro member" CTA banner.
 *
 * Flagship is free. Monetization is bandwidth-metered (Free 50 GB, Pro
 * 250 GB) plus a marketplace — but most users never hit the bandwidth cap,
 * so the cap-hit upgrade alert (a separate surface) never reaches the ~95%
 * who'd happily chip in to keep the project free + independent. This banner
 * is the ALWAYS-AVAILABLE membership path for them: a gentle, on-brand,
 * supportive CTA (membership framing, NOT a donation/guilt plea) that links
 * to the existing /pro page.
 *
 * Per the project's hard rule that marketing surfaces never nag or auto-open
 * anything: this is a one-card, fully dismissible nudge whose visibility is
 * gated on a persisted per-device dismiss flag. Once dismissed it never
 * re-appears on this device (no re-arm, no timer, no auto-anything).
 */
import { sparklesIcon } from "./icons.js";
import { announcementCard } from "./uikit.js";
import {
  get as profileGet,
  set as profileSet,
} from "./profilesStore.js";

// Per-device dismiss flag — a UI preference, not a security/account decision,
// so it lives in the per-profile store. Pinned-to-string by the proBanner test.
export const PRO_BANNER_DISMISS_KEY = "flagship.pro.banner.dismissed.v1";
export const PRO_BANNER_ID = "home-pro-banner";

// The /pro membership page is served from the .com identity origin, not the
// webapp host (web.flagshipserver.com), so we link to the absolute URL — the
// same convention every other external webapp link uses.
export const PRO_URL = "https://flagshipserver.com/pro";

/**
 * Pure predicate: show the Pro-member CTA iff the user hasn't dismissed it on
 * this device. Always-available by design — there's no "cap hit" or other
 * precondition; the ONLY gate is the dismiss flag. Extracted so the rule is
 * testable without a DOM (mirrors shouldShowRecoveryBanner in home.js).
 *
 * @param {{ dismissed?: string|null }} [state]
 */
export function shouldShowProBanner({ dismissed } = {}) {
  return dismissed !== "true";
}

/**
 * Render (or remove) the dismissible "Become a Pro member" announcement card
 * directly above the server list. The "x" writes the per-device dismiss flag
 * so it stays hidden forever after; the CTA opens /pro in a new tab. Safe to
 * call on every home enter — it no-ops if already dismissed or already shown.
 */
export function renderProBanner() {
  let dismissed = null;
  try {
    dismissed = profileGet("proBannerDismissed");
  } catch {
    /* localStorage disabled — treat as not-dismissed, still render once */
  }

  const existing = document.getElementById(PRO_BANNER_ID);
  if (!shouldShowProBanner({ dismissed })) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const host = document.createElement("div");
  host.id = PRO_BANNER_ID;
  host.innerHTML = announcementCard({
    icon: sparklesIcon,
    title: "Become a Pro member",
    message:
      "Flagship is free and always will be. Go Pro to support the project — keep Flagship free & independent — and lift your bandwidth to 250 GB.",
    ctaLabel: "See Pro membership",
    dismissible: true,
    tone: "teal",
  });

  const list = document.getElementById("servers-list");
  list?.parentNode?.insertBefore(host, list);

  host.querySelector("[data-ann-cta]")?.addEventListener("click", () => {
    window.open(PRO_URL, "_blank", "noopener");
  });
  host.querySelector("[data-ann-dismiss]")?.addEventListener("click", () => {
    try {
      profileSet("proBannerDismissed", "true");
    } catch {
      /* swallow — worst case the nudge re-renders next enter */
    }
    document.getElementById(PRO_BANNER_ID)?.remove();
  });
}
