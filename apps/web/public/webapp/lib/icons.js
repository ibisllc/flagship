// Hand-picked Lucide icons used by the webapp (Task #45).
//
// Source: https://github.com/lucide-icons/lucide (ISC license).
// Each export is the raw <svg> body with stroke="currentColor" so the
// surrounding ink color cascades through; the wrapping <span class="icon">
// sizes the SVG via style.css.
//
// Why bundle by hand instead of pulling the npm package: the webapp
// ships as static files (no build step), so pulling the full
// 1500-icon package would dominate the network budget. We pay only
// for the ~15 SVGs we actually render. Adding more is a one-line
// copy from lucide.dev → exported here.
//
// All paths below are taken verbatim from the lucide source tree at
// /icons/<name>.svg (v0.x). Keep stroke-linecap="round" + linejoin="round"
// + stroke-width="2" + 24x24 viewBox so every icon scales identically.

const COMMON = `xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

export const serverIcon = `<svg ${COMMON}><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`;

export const hardDriveIcon = `<svg ${COMMON}><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>`;

export const keyIcon = `<svg ${COMMON}><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-2 2 1.5 1.5L22 4z"/><path d="m18 5 1.5 1.5"/></svg>`;

export const shieldIcon = `<svg ${COMMON}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

export const sendIcon = `<svg ${COMMON}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

export const plusIcon = `<svg ${COMMON}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

export const settingsIcon = `<svg ${COMMON}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

export const userIcon = `<svg ${COMMON}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

export const usersIcon = `<svg ${COMMON}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

export const alertCircleIcon = `<svg ${COMMON}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

export const checkCircleIcon = `<svg ${COMMON}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;

export const alertTriangleIcon = `<svg ${COMMON}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

export const refreshIcon = `<svg ${COMMON}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

export const monitorIcon = `<svg ${COMMON}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

// Sparkles — lucide alias "wand-sparkles"/"sparkles". Used for the
// vibe-code action since "wand" is the closest verb-match for
// "describe an idea → an app appears".
export const sparklesIcon = `<svg ${COMMON}><path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/><path d="M19 3l.7 2.1L22 6l-2.3.9L19 9l-.7-2.1L16 6l2.3-.9z"/><path d="M5 15l.7 1.7 1.8.8-1.8.8L5 20l-.7-1.7L2.5 17.5l1.8-.8z"/></svg>`;

export const packageIcon = `<svg ${COMMON}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;

export const shoppingBagIcon = `<svg ${COMMON}><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;

export const downloadIcon = `<svg ${COMMON}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

export const activityIcon = `<svg ${COMMON}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;

export const unlockIcon = `<svg ${COMMON}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

// Search / chevron-right / x — used by the WhatsApp-inspired uikit
// primitives (search field magnifier, list/settings-row chevron, the
// announcement-card + search-field dismiss control).
export const searchIcon = `<svg ${COMMON}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

export const chevronRightIcon = `<svg ${COMMON}><polyline points="9 18 15 12 9 6"/></svg>`;

export const xIcon = `<svg ${COMMON}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/**
 * Map of home-grid button id → icon. Centralised so the wiring below
 * is data-driven; the icon for each surface is chosen to mirror its
 * verb (Send order → arrow, Recovery → shield, Vibe-code → sparkles).
 *
 * Post-#23 the home grid is gone — these mappings remain so the
 * decorate helper is a no-op on the new IA but doesn't error if a
 * fork keeps the old layout. The browser-viewer mapping is
 * intentionally retained (the icon is now reused elsewhere) even
 * though the legacy "open-browser-viewer" id is no longer in the
 * markup; see views/service-detail.js for the only entry point (#32).
 */
export const HOME_BUTTON_ICONS = {
  "open-pod-pair":          keyIcon,
  "open-server-detail":     serverIcon,
  "open-apps-list":         packageIcon,
  "open-marketplace":       shoppingBagIcon,
  "open-vibe-code":         sparklesIcon,
  "open-paired-sessions":   usersIcon,
  "open-install-progress":  downloadIcon,
  "open-orders-debug":      sendIcon,
  // #32 — only entry point is service-detail.js; legacy id kept so a
  // pinned fork's CSS still resolves the icon. New code should not
  // reference "open-browser-viewer" — bind to sd-open-browser instead.
  "open-browser-viewer":    monitorIcon,
  "open-recovery":          shieldIcon,
};

/**
 * Map of toast variant → icon. Used by lib/toast.js to prepend a
 * visual cue so the bubble's intent is obvious without reading.
 */
export const TOAST_ICONS = {
  ok:    checkCircleIcon,
  err:   alertCircleIcon,
  warn:  alertTriangleIcon,
};

/**
 * Decorate the home-grid buttons in #view-home with their icons.
 * Idempotent — re-running it just re-wraps with the same content.
 * Wraps the existing button text in a <span class="label-text"> so
 * CSS can re-flow the button as icon-on-top + label-below.
 */
export function decorateHomeGrid(root = document) {
  for (const [id, svg] of Object.entries(HOME_BUTTON_ICONS)) {
    const btn = root.getElementById?.(id) ?? root.querySelector?.(`#${id}`);
    if (!btn || btn.dataset.iconWired === "1") continue;
    const labelText = btn.textContent;
    btn.innerHTML = `<span class="icon">${svg}</span><span class="label-text">${labelText}</span>`;
    btn.dataset.iconWired = "1";
  }
}
