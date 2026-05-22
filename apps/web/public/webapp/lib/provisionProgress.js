// Provisioning progress model for the "your server is being installed"
// UI. Byte-for-byte mirror of packages/protocol/src/provisionProgress.ts
// (fraction + grouping + per-step state) so the webapp's progress bar +
// step checklist match iOS / Android exactly.
//
// Pure (no DOM, no network) so it unit-tests in isolation.

/** The fine-grained ladder, in order, EXCLUDING the terminal `failed`.
 *  Mirror of PROVISION_PHASES (auth.ts) minus `failed`. */
export const PROVISION_LADDER = Object.freeze([
  "boot",
  "cloned",
  "deps",
  "built",
  "identity",
  "registered",
  "tunnel-online",
  "acme-order",
  "dns01-publish-attempt",
  "dns01-publish-ok",
  "dns01-propagation-wait",
  "tlsalpn-served",
  "acme-validating",
  "cert-issued",
  "ready",
]);

/** Human title per fine-grained phase. Lockstep with PROVISION_PHASE_TITLES
 *  (protocol) + PHASE_TITLES (control-plane push fan-out). */
export const PROVISION_PHASE_TITLES = Object.freeze({
  boot: "Server booting",
  cloned: "Code cloned",
  deps: "Installing dependencies",
  built: "Build complete",
  identity: "Identity generated",
  registered: "Registered with Flagship",
  "tunnel-online": "Tunnel online",
  "acme-order": "Requesting certificate",
  "dns01-publish-attempt": "Publishing DNS challenge",
  "dns01-publish-ok": "DNS challenge published",
  "dns01-propagation-wait": "Waiting for DNS",
  "tlsalpn-served": "Serving TLS challenge",
  "acme-validating": "Validating certificate",
  "cert-issued": "TLS certificate issued",
  ready: "Server is live",
  failed: "Provisioning failed",
});

/** The four user-facing groups, in order. */
export const PROVISION_STEP_GROUPS = Object.freeze([
  { key: "booting", label: "Booting", phases: ["boot", "cloned", "deps", "built", "identity"] },
  { key: "registering", label: "Registering", phases: ["registered", "tunnel-online"] },
  {
    key: "securing",
    label: "Securing (TLS certificate)",
    phases: [
      "acme-order",
      "dns01-publish-attempt",
      "dns01-publish-ok",
      "dns01-propagation-wait",
      "tlsalpn-served",
      "acme-validating",
      "cert-issued",
    ],
  },
  { key: "ready", label: "Ready", phases: ["ready"] },
]);

/** @param {string} phase */
function isLadderPhase(phase) {
  return PROVISION_LADDER.includes(phase);
}

/** Map a phase to a 0..1 fraction for a determinate progress bar.
 *  @param {string|null|undefined} phase
 *  @returns {number}
 */
export function provisionFraction(phase) {
  if (!phase) return 0;
  if (phase === "ready") return 1;
  if (phase === "failed") return 0;
  if (!isLadderPhase(phase)) return 0;
  const idx = PROVISION_LADDER.indexOf(phase);
  if (idx < 0) return 0;
  return (idx + 1) / PROVISION_LADDER.length;
}

/** @param {string} phase @returns {string} */
function groupKeyForPhase(phase) {
  for (const g of PROVISION_STEP_GROUPS) {
    if (g.phases.includes(phase)) return g.key;
  }
  return "booting";
}

/**
 * Project (phase, lastError, prevPhase) into the per-group checklist.
 * @param {string|null|undefined} phase
 * @param {string|null} [lastError]
 * @param {string|null} [prevPhase]
 * @returns {Array<{key: string, label: string, state: "done"|"active"|"pending"|"failed", detail: string|null}>}
 */
export function provisionStepStates(phase, lastError, prevPhase) {
  const groups = PROVISION_STEP_GROUPS;

  if (phase === "ready") {
    return groups.map((g) => ({ key: g.key, label: g.label, state: "done", detail: null }));
  }

  if (phase === "failed") {
    const failedPhase =
      prevPhase && isLadderPhase(prevPhase) ? prevPhase : "boot";
    const failedGroup = groupKeyForPhase(failedPhase);
    const failedIdx = groups.findIndex((g) => g.key === failedGroup);
    return groups.map((g, i) => {
      if (i < failedIdx) return { key: g.key, label: g.label, state: "done", detail: null };
      if (i === failedIdx) {
        return {
          key: g.key,
          label: g.label,
          state: "failed",
          detail: lastError && lastError.length > 0 ? lastError : PROVISION_PHASE_TITLES.failed,
        };
      }
      return { key: g.key, label: g.label, state: "pending", detail: null };
    });
  }

  if (!phase || !isLadderPhase(phase)) {
    return groups.map((g, i) => ({
      key: g.key,
      label: g.label,
      state: i === 0 ? "active" : "pending",
      detail: null,
    }));
  }

  const activeGroup = groupKeyForPhase(phase);
  const activeIdx = groups.findIndex((g) => g.key === activeGroup);
  return groups.map((g, i) => {
    if (i < activeIdx) return { key: g.key, label: g.label, state: "done", detail: null };
    if (i === activeIdx) {
      return { key: g.key, label: g.label, state: "active", detail: PROVISION_PHASE_TITLES[phase] };
    }
    return { key: g.key, label: g.label, state: "pending", detail: null };
  });
}

/** True when a demoServer block should render a progress bar on the
 *  list (i.e. it has a server still pre-`ready`). A `ready` server (or
 *  one with no demoServer) renders as a normal online server.
 *  @param {{ phase?: string|null, status?: string }|null|undefined} block
 *  @returns {boolean}
 */
export function shouldShowProgressBar(block) {
  if (!block) return false;
  if (block.status === "up" && (block.phase == null || block.phase === "ready")) return false;
  if (block.phase === "ready") return false;
  if (block.status === "none") return false;
  // provisioning, OR phase present and not ready, OR failed → show.
  return block.status === "provisioning" || block.phase != null;
}

/** Minimal HTML escape for the strings we interpolate (lastError, ip,
 *  image). Kept local so the module has no DOM/import dependency.
 *  @param {string} s @returns {string} */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/** Render the thin determinate progress bar for a list row. Returns ''
 *  when no bar should show (ready / none / absent).
 *  @param {{ phase?: string|null, status?: string }|null|undefined} block
 *  @returns {string} */
export function renderListProgressBar(block) {
  if (!shouldShowProgressBar(block)) return "";
  const pct = Math.round(provisionFraction(block?.phase) * 100);
  const failed = block?.phase === "failed";
  const cls = failed ? "demo-progress-bar failed" : "demo-progress-bar";
  return (
    `<div class="${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">` +
    `<div class="demo-progress-fill" style="width:${pct}%"></div>` +
    `</div>`
  );
}

/** Render the full detail-page step checklist + device info block.
 *  Pure string builder so it's unit-testable and droppable into any
 *  view's innerHTML.
 *  @param {object} block  the demoServer block
 *  @returns {string} */
export function renderProgressDetail(block) {
  if (!block) return "";
  const steps = provisionStepStates(block.phase, block.lastError);
  const pct = Math.round(provisionFraction(block.phase) * 100);
  const failed = block.phase === "failed";
  const rows = steps
    .map((s) => {
      const icon =
        s.state === "done" ? "✓" : s.state === "failed" ? "!" : s.state === "active" ? "…" : "○";
      const detail = s.detail
        ? `<div class="demo-step-detail">${esc(s.detail)}</div>`
        : "";
      // For the failed group the daemon retries — surface that, not a dead end.
      const retry =
        s.state === "failed"
          ? `<div class="demo-step-retry">retrying — last error: ${esc(s.detail || "")}</div>`
          : "";
      return (
        `<li class="demo-step demo-step-${s.state}">` +
        `<span class="demo-step-icon">${icon}</span>` +
        `<span class="demo-step-label">${esc(s.label)}</span>` +
        detail +
        retry +
        `</li>`
      );
    })
    .join("");
  const info = [
    block.ip ? `<div>IP: <code>${esc(block.ip)}</code></div>` : "",
    block.region ? `<div>Location: ${esc(block.region)}</div>` : "",
    block.image ? `<div>OS: ${esc(block.image)}</div>` : "",
    block.serverType ? `<div>Size: ${esc(block.serverType)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");
  return (
    `<div class="demo-progress-bar${failed ? " failed" : ""}" role="progressbar" aria-valuenow="${pct}">` +
    `<div class="demo-progress-fill" style="width:${pct}%"></div></div>` +
    `<ol class="demo-step-list">${rows}</ol>` +
    (info ? `<div class="demo-device-info">${info}</div>` : "")
  );
}
