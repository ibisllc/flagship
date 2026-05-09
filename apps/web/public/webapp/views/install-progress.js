// P2.10 — Install-progress view.
//
// Polls /api/screens/install-events/:serial?since=N (P1.15) and
// renders the events as a step-by-step progress timeline. Used while
// a freshly-built ISO is booting / coming online.
//
// The user enters a serial number; the view polls every 2s and
// stops once a `ready` or `failed` event lands.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-install-progress");

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_KINDS = new Set(["ready", "failed"]);

let pollTimer = null;
let activeSerial = null;
let cursor = 0;
let seenEvents = [];

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function fmtKind(kind) {
  switch (kind) {
    case "registered": return "registered with control plane";
    case "boot": return "first boot";
    case "tunnel-online": return "tunnel online";
    case "cert-issued": return "TLS cert issued";
    case "ready": return "READY ✓";
    case "failed": return "FAILED ✗";
    default: return kind;
  }
}

function render() {
  const root = $("install-progress-content");
  if (!seenEvents.length) {
    root.innerHTML = '<div class="card placeholder">no events yet — the box may not have booted yet</div>';
    return;
  }
  root.innerHTML = seenEvents.map((e) => {
    const cls = e.kind === "failed" ? "err" : e.kind === "ready" ? "ok" : "";
    const detail = e.kind === "failed" && e.reason
      ? `<div style="color:var(--err); font-size:0.78rem;">${escapeHtml(e.reason)}</div>`
      : e.kind === "ready" && e.serverFqdn
      ? `<div class="value" style="font-size:0.78rem;">${escapeHtml(e.serverFqdn)}</div>`
      : "";
    return `
      <div class="card">
        <div class="row">
          <span class="value">${escapeHtml(fmtKind(e.kind))}</span>
          <span class="pill ${cls}">${escapeHtml(new Date(e.at).toLocaleTimeString())}</span>
        </div>
        ${detail}
      </div>
    `;
  }).join("");
}

async function poll() {
  if (!activeSerial) return;
  try {
    const body = await screensFetch(
      `/api/screens/install-events/${encodeURIComponent(activeSerial)}?since=${cursor}`,
    );
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > 0) {
      seenEvents = [...seenEvents, ...events];
      // Track the highest seq we've seen so the next poll only asks
      // for newer events.
      if (typeof body.cursor === "number") cursor = body.cursor;
      else {
        // Some upstream variants don't return a cursor; fall back to
        // counting the events we've appended.
        cursor = seenEvents.length;
      }
      render();
      const last = events[events.length - 1];
      if (last && TERMINAL_KINDS.has(last.kind)) {
        clearPoll();
        return;
      }
    }
  } catch (e) {
    if (e instanceof ScreensError) {
      $("install-progress-content").innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
      clearPoll();
      return;
    }
    // transient — keep polling
  }
  pollTimer = setTimeout(() => poll().catch(() => {}), POLL_INTERVAL_MS);
}

function start() {
  const serial = $("ip-serial").value.trim();
  if (!serial) return toast("enter the serial first", "err");
  clearPoll();
  activeSerial = serial;
  cursor = 0;
  seenEvents = [];
  render();
  poll().catch((e) => toast(String(e), "err"));
}

function reset() {
  clearPoll();
  activeSerial = null;
  cursor = 0;
  seenEvents = [];
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
