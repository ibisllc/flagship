// The global "operations" sliver — the DOM half of the active-operations
// feature. A teal strip pinned at the very top that the whole shell slides
// DOWN to reveal (modelled on WhatsApp's active-call bar). It shows the most
// recently started running operation ("preparing Home", "building blog on
// Home") with a spinner; clicking it routes to that operation's own view.
//
// Renders nothing (zero height, no push) when there are no operations or the
// app is locked — the latter so operation names (the user's own data) never
// show through over the unlock/PIN screens, mirroring iOS's hide-under-lock.
//
// The data + ordering live in lib/activeOperations.js (the testable half);
// this file is the thin render + the router glue, so there's no logic here
// beyond "show the primary, go where it points".

import { activeOperations, operationLabel } from "./activeOperations.js";
import { chevronRightIcon } from "./icons.js";

let barEl = null;
let unlockedFn = () => true;

/**
 * Resolve whether the app is currently unlocked. The bar hides while locked
 * so the lock/PIN screens never have operation names slide in over them.
 * Wired by app.js (which knows the session state); defaults to "unlocked"
 * so a surface that never wires it still shows operations.
 */
export function setOperationsBarUnlockedResolver(fn) {
  if (typeof fn === "function") unlockedFn = fn;
}

/** Route a deep-link target `{ view, params }` to the matching view. Kept
 *  here (not in the store) so the store stays DOM/router-free + unit-testable.
 *  Dynamic imports mirror lib/deepLink.js so the bar doesn't pull every view
 *  module into the entry bundle. */
async function navigateToTarget(target) {
  if (!target || !target.view) return;
  const params = target.params ?? {};
  try {
    if (target.view === "view-server-detail") {
      // The webapp's server-detail resolves the server from the paired
      // session, so a deploying box (no paired session of its own yet) is
      // best surfaced where its live pending card + progress bar live: Home.
      const { enterHome } = await import("../views/home.js");
      await enterHome();
      return;
    }
    if (target.view === "view-vibe-code") {
      // Resume the live chat (don't reset it) when tapping a running build.
      const { resumeVibeCode } = await import("../views/vibe-code.js");
      await resumeVibeCode(params);
      return;
    }
    if (target.view === "view-vibecode-chat") {
      // #91 — an AI-chat-needs-you alert: open the W10 chat at that session
      // so the owner can answer the AI's question / set the env var.
      const { enterVibeCodeChat } = await import("../views/vibecode-chat.js");
      await enterVibeCodeChat(params.sessionId);
      return;
    }
    // Fallback — just show the view id if it's a plain router target.
    const { show } = await import("./router.js");
    show(target.view);
  } catch {
    /* navigation is best-effort — a missing view must not throw from a tap */
  }
}

function ensureBar() {
  if (barEl) return barEl;
  if (typeof document === "undefined") return null;
  barEl = document.createElement("div");
  barEl.id = "global-operations-bar";
  barEl.className = "ops-bar";
  barEl.setAttribute("role", "button");
  barEl.setAttribute("tabindex", "0");
  barEl.setAttribute("aria-label", "Active operation");
  // Pin it as the FIRST child of <body> so it sits above the sticky header;
  // the header tucks below it via the --ops-bar-h var set in render().
  document.body.insertBefore(barEl, document.body.firstChild);
  const go = () => {
    const op = activeOperations.primary;
    if (op) void navigateToTarget(op.target);
  };
  barEl.addEventListener("click", go);
  barEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
  return barEl;
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

function render() {
  const el = ensureBar();
  if (!el) return;
  const op = unlockedFn() ? activeOperations.primary : null;
  if (!op) {
    el.classList.remove("is-shown");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = "";
    // Collapse the header offset so the shell sits flush again.
    document.body.style.setProperty("--ops-bar-h", "0px");
    return;
  }
  const extra = activeOperations.additionalCount;
  const extraPill =
    extra > 0
      ? `<span class="ops-bar-extra">+${extra}</span>`
      : "";
  el.innerHTML = `
    <span class="ops-bar-spinner" aria-hidden="true"></span>
    <span class="ops-bar-label">${escapeText(operationLabel(op))}</span>
    ${extraPill}
    <span class="ops-bar-chevron" aria-hidden="true">${chevronRightIcon}</span>
  `;
  el.setAttribute("aria-label", operationLabel(op));
  el.removeAttribute("aria-hidden");
  el.classList.add("is-shown");
  // Push the sticky header (and so the whole shell) down by the bar's height
  // — the CSS transition on this var + the bar height is the slide.
  document.body.style.setProperty("--ops-bar-h", "44px");
}

/**
 * Mount the bar once and keep it in sync with the operations center. Safe to
 * call repeatedly (idempotent). Call again whenever the lock state flips so
 * the bar re-evaluates whether it may show.
 */
export function initOperationsBar() {
  if (typeof document === "undefined") return;
  ensureBar();
  if (!initOperationsBar._subscribed) {
    activeOperations.subscribe(() => render());
    initOperationsBar._subscribed = true;
  }
  render();
}

/** Re-evaluate visibility (e.g. after unlock/lock). */
export function refreshOperationsBar() {
  render();
}
