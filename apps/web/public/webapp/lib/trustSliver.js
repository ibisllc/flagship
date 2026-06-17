// The persistent ALARMING-RED top sliver — the trust half of the
// push-content-down pattern. A higher, red, NON-dismissible variant of the
// teal operations bar (lib/operationsBar.js): while the control/relay blessing
// is broken it pins one red line per failing cert at the very top of the
// shell, the whole UI sliding down to reveal it. It STAYS even after the owner
// overrides a cert (the degraded state must remain visible —
// docs/maintainer-trust-enforcement.md).
//
// Contract (identical across all surfaces):
//   - ONE line per failing certHash (deduped).
//   - slug = first 8 hex of certHash.
//   - label "Control server certificate expired · <slug>"   (certClass "control")
//           "Relay certificate expired · <slug>"            (certClass "relay")
//   - non-dismissible while untrusted; persists after override.
//
// Tapping a line opens the per-cert override flow (lib/trustOverride.js),
// which is biometric/PIN-gated and records a signed TrustException.
//
// The data half is lib/serverTrust.js (serverTrust.failingCerts()); this file
// is the thin render + the slug/label shapes (the pure, unit-tested part lives
// in trustSliverLabels below so the DOM isn't needed to test the contract).

import { serverTrust } from "./serverTrust.js";

/** First 8 hex of the cert-hash — the slug shown in the sliver line. */
export function certSlug(certHash) {
  return String(certHash || "").slice(0, 8);
}

/** The line label for a failing cert (shared contract). */
export function trustLineLabel(cert) {
  const slug = certSlug(cert.certHash);
  if (cert.certClass === "relay") return `Relay certificate expired · ${slug}`;
  return `Control server certificate expired · ${slug}`;
}

/**
 * Compute the deduped set of sliver lines from a list of failing certs. One
 * line per distinct certHash; first occurrence's class wins. Pure — the
 * testable core (no DOM).
 * @param {Array<{certClass:string, certHash:string, overridden?:boolean}>} certs
 * @returns {Array<{certHash:string, certClass:string, slug:string, label:string, overridden:boolean}>}
 */
export function trustSliverLines(certs) {
  const seen = new Set();
  const lines = [];
  for (const c of certs ?? []) {
    if (!c || !c.certHash || seen.has(c.certHash)) continue;
    seen.add(c.certHash);
    lines.push({
      certHash: c.certHash,
      certClass: c.certClass === "relay" ? "relay" : "control",
      slug: certSlug(c.certHash),
      label: trustLineLabel(c),
      overridden: !!c.overridden,
    });
  }
  return lines;
}

/* ---------- DOM render ---------- */

let barEl = null;
let onLineTap = null;

/** Wire the per-line tap handler (the override flow). */
export function setTrustSliverTapHandler(fn) {
  if (typeof fn === "function") onLineTap = fn;
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function ensureBar() {
  if (barEl) return barEl;
  if (typeof document === "undefined") return null;
  barEl = document.createElement("div");
  barEl.id = "trust-sliver";
  barEl.className = "trust-bar";
  barEl.setAttribute("role", "alert");
  barEl.setAttribute("aria-live", "assertive");
  // Pin it as the VERY FIRST child of <body> — above even the teal ops bar.
  document.body.insertBefore(barEl, document.body.firstChild);
  return barEl;
}

export function renderTrustSliver() {
  const el = ensureBar();
  if (!el) return;
  const lines = trustSliverLines(serverTrust.failingCerts());
  if (lines.length === 0) {
    el.classList.remove("is-shown");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = "";
    document.body.style.setProperty("--trust-bar-h", "0px");
    return;
  }
  el.removeAttribute("aria-hidden");
  el.classList.add("is-shown");
  el.innerHTML = lines
    .map(
      (l) => `
      <button type="button" class="trust-bar-line" data-cert-hash="${escapeText(l.certHash)}"
              aria-label="${escapeText(l.label)}${l.overridden ? " (accepted)" : ""}">
        <span class="trust-bar-icon" aria-hidden="true">&#9888;</span>
        <span class="trust-bar-label">${escapeText(l.label)}</span>
        ${l.overridden ? '<span class="trust-bar-accepted">accepted</span>' : ""}
      </button>`,
    )
    .join("");
  for (const btn of el.querySelectorAll(".trust-bar-line")) {
    btn.addEventListener("click", () => {
      const certHash = btn.getAttribute("data-cert-hash");
      if (certHash && onLineTap) void onLineTap(certHash);
    });
  }
  // Each line is ~38px; drive the push-down var in lockstep.
  document.body.style.setProperty("--trust-bar-h", `${lines.length * 38}px`);
}

/** Mount once + keep in sync with the trust store. Idempotent. */
export function initTrustSliver() {
  if (typeof document === "undefined") return;
  ensureBar();
  if (!initTrustSliver._subscribed) {
    serverTrust.subscribe(() => renderTrustSliver());
    initTrustSliver._subscribed = true;
  }
  renderTrustSliver();
}
