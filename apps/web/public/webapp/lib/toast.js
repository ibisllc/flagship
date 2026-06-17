// Unified toast surface for the webapp. P2.14 in the cycle plan calls
// for unifying error handling across views — toast() is that surface.
// An `err` / `ok` / `warn` kind tints the bubble and prepends the matching
// Lucide icon (Task #45).
//
// L7 — the surface is QUEUED + DEDUPED, mirroring iOS/Android's ToastCenter:
// the old single-slot version had a second toast clobber the first (and reset
// the shared 3s timer), so two near-simultaneous messages lost one. Now toast()
// appends to a queue; the FRONT entry is shown and auto-dismisses after its own
// timer, then the next entry shows. A publish whose (kind,message) already sits
// in the queue is dropped (a rapid identical re-publish doesn't stack), exactly
// like ToastCenter.publish. The public API — `toast(text, kind)` — is unchanged.

import { TOAST_ICONS } from "./icons.js";

const DISPLAY_MS = 3000;

/** The live queue. The element at index 0 is the one on screen. Exported for
 *  tests (the DOM render is the thin half — the queue is the testable core). */
export const toastQueue = [];
let frontTimer = null;

/**
 * Pure queue op — append unless an identical (kind,message) entry is already
 * queued (dedupe). Returns true when the entry was added, false when it was a
 * duplicate that got dropped. Pure: no DOM, no timers — the unit-tested core.
 * @param {Array<{text:string, kind?:string}>} queue
 * @param {string} text
 * @param {string} [kind]
 */
export function enqueueToast(queue, text, kind) {
  const entry = { text: String(text), kind: kind || undefined };
  if (queue.some((t) => t.text === entry.text && t.kind === entry.kind)) {
    return false;
  }
  queue.push(entry);
  return true;
}

export function toast(text, kind) {
  if (typeof document === "undefined") return;
  // Dedupe + enqueue; a dropped duplicate doesn't disturb what's on screen.
  const added = enqueueToast(toastQueue, text, kind);
  if (!added) return;
  // If nothing was showing, this entry is now the front — paint it.
  if (toastQueue.length === 1) showFront();
}

/** Render the front entry + arm its own dismissal timer. */
function showFront() {
  const el = document.getElementById("toast");
  if (!el) return;
  const entry = toastQueue[0];
  if (!entry) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden", "err", "ok", "warn");
  const icon = TOAST_ICONS[entry.kind];
  if (icon) {
    el.innerHTML = `<span class="icon">${icon}</span><span>${escapeText(entry.text)}</span>`;
    el.classList.add(entry.kind);
  } else {
    el.textContent = entry.text;
  }
  if (frontTimer) clearTimeout(frontTimer);
  frontTimer = setTimeout(advance, DISPLAY_MS);
}

/** Drop the front entry and show the next, or hide when the queue empties. */
function advance() {
  if (frontTimer) {
    clearTimeout(frontTimer);
    frontTimer = null;
  }
  toastQueue.shift();
  if (toastQueue.length > 0) {
    showFront();
  } else {
    const el = document.getElementById("toast");
    if (el) el.classList.add("hidden");
  }
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
