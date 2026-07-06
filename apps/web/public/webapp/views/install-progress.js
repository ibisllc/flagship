// Install-progress view — reads the SINGLE canonical provisioning channel.
//
// Polls GET https://flagshipserver.com/api/order/<serial>/status (the one
// channel the box + daemon report every phase to) and renders the canonical
// grouped step ladder. Used while a freshly-built ISO is booting / coming
// online.
//
// The user enters a serial number; the view polls every 2s and stops once a
// terminal phase (`live` or `error`) lands. A 404 means "no record yet" — the
// box hasn't phoned home, so we render the booting lead-in.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import {
  PROVISION_PHASE_TITLES,
  renderProgressDetail,
} from "../lib/provisionProgress.js";
import { controlApex } from "../lib/apex.js";

registerView("view-install-progress");

const POLL_INTERVAL_MS = 2_000;
const CONTROL_PLANE_BASE = controlApex();
// Terminal canonical phases — stop polling once one lands.
const TERMINAL_PHASES = new Set(["live", "error"]);

let pollTimer = null;
let activeSerial = null;
/** Latest canonical record { phase, detail, serverDomain, history }. */
let latest = null;

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function render() {
  const root = $("install-progress-content");
  if (!root) return;
  if (!latest || !latest.phase) {
    root.innerHTML =
      '<div class="card placeholder">waiting for your box to phone home — it may not have booted yet</div>';
    return;
  }
  // Reuse the shared canonical step-ladder renderer so the webapp matches
  // iOS / Android. The block shape it wants overlaps the canonical record
  // (phase + detail-as-lastError + optional serverDomain).
  const block = {
    phase: latest.phase,
    lastError: latest.phase === "error" ? latest.detail || "" : undefined,
  };
  const title = PROVISION_PHASE_TITLES[latest.phase] || latest.phase;
  const domain = latest.serverDomain
    ? `<div class="value text-xs">${escapeText(latest.serverDomain)}</div>`
    : "";
  root.innerHTML =
    `<div class="card"><div class="row"><span class="value">${escapeText(title)}</span></div>${domain}</div>` +
    renderProgressDetail(block);
}

/** UX-F — a wedged/failed status read shouldn't trap the user on a spinner
 *  or a raw error. Render the human reason plus a way out: retry the poll,
 *  or head Home (where the pending pod keeps rendering — the install is
 *  still progressing on the box regardless of our read failing). */
function renderEscape(reason) {
  const root = $("install-progress-content");
  if (!root) return;
  root.innerHTML = `
    <div class="card">
      <p class="err-text">${escapeText(reason)}</p>
      <p class="note mt-2">Your box may still be installing — this only means we couldn't read its status just now. It keeps going on its own, and you'll see it on Home when it comes online.</p>
      <div class="row-2 mt-3">
        <button id="ip-escape-retry" class="secondary">Try again</button>
        <button id="ip-escape-home" class="secondary">Go to Home</button>
      </div>
    </div>`;
  $("ip-escape-retry")?.addEventListener("click", () => {
    if (!activeSerial) return;
    latest = null;
    render();
    poll().catch((e) => {
      console.error("install retry failed", e);
      toast(humanError(e), "err");
    });
  });
  $("ip-escape-home")?.addEventListener("click", () => {
    clearPoll();
    show("view-home");
  });
}

/** Local minimal escape (the shared renderer escapes its own interpolations;
 *  this is only for the title + domain we render here). */
function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

async function poll() {
  if (!activeSerial) return;
  try {
    const resp = await fetch(
      `${CONTROL_PLANE_BASE}/api/order/${encodeURIComponent(activeSerial)}/status`,
    );
    if (resp.status === 404) {
      // No record yet — box hasn't reported. Keep the booting lead-in.
      latest = null;
      render();
    } else if (resp.ok) {
      const body = await resp.json();
      latest = body;
      render();
      if (body && TERMINAL_PHASES.has(body.phase)) {
        clearPoll();
        return;
      }
    } else {
      // A non-404 error status from the control plane. Don't strand the
      // user on a raw `HTTP 5xx` — translate it, keep the box's state
      // honest (it may still be installing; this is OUR status read that
      // failed), and offer a way out (retry the poll, or go Home where the
      // pending pod is still rendered).
      console.error("install status poll failed", resp.status);
      renderEscape(humanError(resp.status));
      clearPoll();
      return;
    }
  } catch (e) {
    // transient (network blip) — keep polling, but record it.
    console.error("install status poll error (will retry)", e);
  }
  pollTimer = setTimeout(() => poll().catch(() => {}), POLL_INTERVAL_MS);
}

function start() {
  const serial = $("ip-serial").value.trim();
  if (!serial) return toast("Enter the serial first", "err");
  clearPoll();
  activeSerial = serial;
  latest = null;
  render();
  poll().catch((e) => {
    console.error("install poll failed", e);
    toast(humanError(e), "err");
  });
}

function reset() {
  clearPoll();
  activeSerial = null;
  latest = null;
  $("ip-serial").value = "";
  render();
}

export function initInstallProgressView() {
  $("ip-go")?.addEventListener("click", start);
  $("ip-reset")?.addEventListener("click", reset);
  $("install-progress-back")?.addEventListener("click", () => {
    clearPoll();
    show("view-home");
  });
}

export function enterInstallProgress() {
  show("view-install-progress");
}
