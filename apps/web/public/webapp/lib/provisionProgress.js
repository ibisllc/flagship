// Provisioning progress model for the "your server is being installed"
// UI — built on the SINGLE canonical vocabulary (ProvisionStatusPhase),
// the same channel the install timeline reads (GET /api/order/<serial>/status).
// Byte-for-byte aligned with the canonical control-plane PHASE_TITLES and the
// canonical group projection, so the webapp's progress bar + step checklist
// match iOS / Android exactly.
//
// Pure (no DOM, no network) so it unit-tests in isolation.
import { tr } from "./i18n.js";

/** The canonical ladder, in order, EXCLUDING the terminal `error`.
 *  Mirror of PROVISION_STATUS_PHASES (control-plane) minus `error`. */
export const PROVISION_LADDER = Object.freeze([
  "booting",
  "partitioning",
  "installing",
  // The flagship bootstrap (git clone + apt + nodejs) — the post-install
  // software fetch. The base OS is already on the USB, so this follows
  // `installing` on the wire.
  "downloading",
  "registering",
  "sealing",
  // ACTION-NEEDED: install finished, box registered + sealed, then powered
  // off awaiting the user to unplug the USB + power on. The final pre-poweroff
  // checkpoint — sorts AFTER sealing. NOT success (`live` is success).
  "installed",
  "pairing",
  "live",
]);

/** Human title per canonical phase. Lockstep with PHASE_TITLES
 *  (packages/control-plane/src/provisionStatus.ts) — every surface uses these. */
export const PROVISION_PHASE_TITLES = Object.freeze({
  booting: tr("Booting up"),
  downloading: "Downloading",
  partitioning: tr("Partitioning disk"),
  installing: "Installing",
  installed: tr("Install complete"),
  registering: tr("Registering with Flagship"),
  sealing: tr("Sealing your disk key"),
  pairing: tr("Pairing with your phone"),
  live: tr("Your server is live"),
  error: tr("Setup hit a problem"),
});

/** The canonical UI group projection (design §1.2), in order. Each
 *  implementer (iOS / Android / webapp) derives the SAME grouping from this
 *  table — it is part of the contract. `error` fails the active group.
 *
 *  NOTE: the wire phase `installed` is its OWN rendered rung, positioned
 *  AFTER `securing` (sealing) — the final pre-poweroff checkpoint (the box
 *  registered + sealed, then powered off awaiting the user to unplug the USB +
 *  power on). When `installed` is current the box is OFF, so its row renders
 *  ACTIVE (action-needed, nothing spins) carrying the unplug-and-power-on
 *  instruction; `live` is the terminal success. */
export const PROVISION_STEP_GROUPS = Object.freeze([
  { key: "booting", label: tr("Booting"), phases: ["booting", "partitioning"] },
  { key: "installing", label: tr("Installing"), phases: ["installing", "downloading"] },
  { key: "registering", label: tr("Registering"), phases: ["registering", "pairing"] },
  { key: "securing", label: tr("Securing (TLS certificate)"), phases: ["sealing"] },
  { key: "installed", label: tr("Install complete"), phases: ["installed"] },
  { key: "ready", label: tr("Ready"), phases: ["live"] },
]);

/** Detail copy shown on the `installed` row when the box reaches the
 *  `installed` wire phase: the install finished and the box powered off
 *  awaiting the user. Longer than PROVISION_PHASE_TITLES.installed (the push
 *  banner's short form) because the in-ladder row spells out BOTH actions. */
export const INSTALLED_DONE_DETAIL =
  tr("Install complete. If it ran from a USB stick, unplug it and power the server back on.");

/** The box's failure text for a person: "Setup stopped while Expanding the
 *  disk (line 66)" loses the shell line number; empty becomes the title.
 *  MIRRORS: Android ProvisionProgress.failureDetail.
 *  @param {string|null|undefined} lastError
 *  @returns {string} */
export function failureDetail(lastError) {
  const stripped = String(lastError ?? "")
    .replace(/\s*[(\[]?\b(?:at )?lines? ?\d+[)\]]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[,:;]+$/, "");
  return stripped.length > 0 ? stripped : PROVISION_PHASE_TITLES.error;
}

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
  if (phase === "live") return 1;
  if (phase === "error") return 0;
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

  if (phase === "live") {
    return groups.map((g) => ({ key: g.key, label: g.label, state: "done", detail: null }));
  }

  if (phase === "error") {
    const failedPhase =
      prevPhase && isLadderPhase(prevPhase) ? prevPhase : "booting";
    const failedGroup = groupKeyForPhase(failedPhase);
    const failedIdx = groups.findIndex((g) => g.key === failedGroup);
    return groups.map((g, i) => {
      if (i < failedIdx) return { key: g.key, label: g.label, state: "done", detail: null };
      if (i === failedIdx) {
        return {
          key: g.key,
          label: g.label,
          state: "failed",
          detail: failureDetail(lastError),
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

  // `installed` is its own ACTION-NEEDED rung (after Securing): the install
  // finished, the box registered + sealed, then powered off awaiting the
  // user. The box is OFF so nothing spins, but the row is still ACTIVE
  // (action needed) carrying the unplug-and-power-on instruction. Everything
  // before it is DONE; `live` stays upcoming.
  const activeGroup = groupKeyForPhase(phase);
  const activeIdx = groups.findIndex((g) => g.key === activeGroup);
  return groups.map((g, i) => {
    if (i < activeIdx) return { key: g.key, label: g.label, state: "done", detail: null };
    if (i === activeIdx) {
      const detail = phase === "installed" ? INSTALLED_DONE_DETAIL : PROVISION_PHASE_TITLES[phase];
      return { key: g.key, label: g.label, state: "active", detail };
    }
    return { key: g.key, label: g.label, state: "pending", detail: null };
  });
}

/** True when a demoServer block should render a progress bar on the
 *  list (i.e. it has a server still pre-`live`). A `live` server (or
 *  one with no demoServer) renders as a normal online server.
 *  @param {{ phase?: string|null, status?: string }|null|undefined} block
 *  @returns {boolean}
 */
export function shouldShowProgressBar(block) {
  if (!block) return false;
  if (block.status === "up" && (block.phase == null || block.phase === "live")) return false;
  if (block.phase === "live") return false;
  if (block.status === "none") return false;
  // provisioning, OR phase present and not live, OR error → show.
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
 *  when no bar should show (live / none / absent).
 *  @param {{ phase?: string|null, status?: string }|null|undefined} block
 *  @returns {string} */
export function renderListProgressBar(block) {
  if (!shouldShowProgressBar(block)) return "";
  const pct = Math.round(provisionFraction(block?.phase) * 100);
  const failed = block?.phase === "error";
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
  const failed = block.phase === "error";
  const rows = steps
    .map((s) => {
      const icon =
        s.state === "done" ? "✓" : s.state === "failed" ? "!" : s.state === "active" ? "…" : "○";
      const detail = s.detail
        ? `<div class="demo-step-detail">${esc(s.detail)}</div>`
        : "";
      // A stopped step is not retrying on its own: the detail says where it
      // stopped, and the pending view offers the way out (renderSetupStopped).
      return (
        `<li class="demo-step demo-step-${s.state}">` +
        `<span class="demo-step-icon">${icon}</span>` +
        `<span class="demo-step-label">${esc(s.label)}</span>` +
        detail +
        `</li>`
      );
    })
    .join("");
  const info = [
    block.ip ? `<div>${tr("IP: <code>{0}</code>", esc(block.ip))}</div>` : "",
    block.region ? `<div>${tr("Location: {0}", esc(block.region))}</div>` : "",
    block.image ? `<div>${tr("OS: {0}", esc(block.image))}</div>` : "",
    block.serverType ? `<div>${tr("Size: {0}", esc(block.serverType))}</div>` : "",
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

/** The way out of a stopped install: cancel the order and start again, or
 *  write to support with the order number. The caller wires
 *  `#setup-stopped-start-again`. MIRRORS: Android SetupStoppedCard.
 *  @param {{ serial?: string|null, step?: string|null }} [args]
 *  @returns {string} */
export function renderSetupStopped({ serial, step } = {}) {
  const where = failureDetail(step);
  const note = where === PROVISION_PHASE_TITLES.error ? "" : `. ${where.replace(/[.!?]+$/, "")}`;
  const body =
    tr("My server's setup stopped. Order: {0} Step: {1} ", serial || "unknown", step ? failureDetail(step) : "");
  const mailto =
    `mailto:support@flagshipserver.com?subject=${encodeURIComponent("Server setup stopped")}` +
    `&body=${encodeURIComponent(body)}`;
  return (
    `<div class="card" id="setup-stopped">` +
    `<h3>${tr("Setup stopped")}</h3>` +
    `<p class="note mt-2">${esc(`This server didn't finish installing${note}. Cancel this order to free the name and create the server again, or contact us and we'll look at it.`)}</p>` +
    `<div class="row-2 mt-2">` +
    `<button class="danger" id="setup-stopped-start-again">${tr("Cancel order and start again")}</button>` +
    `<a class="secondary" id="setup-stopped-contact" href="${esc(mailto)}">${tr("Contact us")}</a>` +
    `</div></div>`
  );
}
