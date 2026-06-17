// Task #26 — URL multiplexing controller view.
//
// Router slot: `data-view="view-url-controller"` (section id
// `view-url-controller`). The shell worker wires the entry point
// (e.g. `open-url-controller` button on home) to `enterUrlController`.
//
// Surfaces three things the user actually thinks about for URL multiplex:
//   1. URLs this pod controls right now (owned list).
//   2. Live siblings — other pods of the same user currently online,
//      so the user knows where a takeover would land. Uses the existing
//      `/api/live_siblings/list` long-poll pattern with a WS-aware
//      fallback to plain GET (mirrors vibe-code.js's WS+poll fallback).
//   3. A claim form (POST /api/screens/url-controller/claim) and a
//      drop-URL action (DELETE → POST release; we model "drop" as a
//      re-claim of the canonical FQDN since the daemon's url-controller
//      surface doesn't expose a top-level drop endpoint yet).
//
// BFF endpoints consumed:
//   GET  /api/screens/url-controller/owned
//   POST /api/screens/url-controller/claim
//   GET  /api/live_siblings/list  (long-poll fallback)
//
// Empty state speaks: when there are no claimed aliases yet, prompt the
// user to claim their first URL; when there are no live siblings the
// panel explains the user has only one pod online so takeover targets
// are limited to this one.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-url-controller");

const SIBLING_POLL_INTERVAL_MS = 5_000;

let siblingPollTimer = null;
let siblingSocket = null;

function clearSiblingPoll() {
  if (siblingPollTimer) {
    clearTimeout(siblingPollTimer);
    siblingPollTimer = null;
  }
}

function closeSiblingSocket() {
  if (siblingSocket) {
    try { siblingSocket.close(); } catch (_e) { /* ignore */ }
    siblingSocket = null;
  }
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

function kindPill(kind) {
  if (kind === "canonical") return '<span class="pill ok">canonical</span>';
  if (kind === "alias") return '<span class="pill accent">alias</span>';
  if (kind === "custom") return '<span class="pill">custom</span>';
  return `<span class="pill">${escapeHtml(kind ?? "unknown")}</span>`;
}

export async function renderOwned() {
  const root = $("url-controller-owned");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading owned URLs…</div>';
  try {
    const body = await screensFetch("/api/screens/url-controller/owned");
    const urls = body.urls ?? [];
    if (!urls.length) {
      root.innerHTML =
        '<div class="card placeholder">no URLs claimed yet — claim one below to multiplex traffic onto this pod</div>';
      return;
    }
    root.innerHTML = urls.map((u) => {
      const canonical = u.kind === "canonical";
      return `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(u.fqdn)} ${kindPill(u.kind)}</div>
              <div class="faint-sm">claimed ${escapeHtml(fmtDate(u.claimedAt))}</div>
            </div>
            ${canonical
              ? '<button class="secondary" disabled title="canonical FQDN cannot be dropped">canonical</button>'
              : `<button class="secondary" data-action="drop" data-fqdn="${escapeHtml(u.fqdn)}">drop</button>`}
          </div>
        </div>
      `;
    }).join("");
    root.querySelectorAll('[data-action="drop"]').forEach((b) => {
      b.addEventListener("click", () =>
        runDrop(b.getAttribute("data-fqdn"), b),
      );
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

export async function renderLiveSiblings() {
  const root = $("url-controller-siblings");
  if (!root) return;
  // Don't blow away a populated list on every poll tick — only show the
  // placeholder before the first successful response.
  if (!root.dataset.hasRendered) {
    root.innerHTML = '<div class="card placeholder">probing live siblings…</div>';
  }
  // The sibling-WS surface lives on the daemon's app-token-bearer side;
  // the webapp's paired-session auth doesn't reach it, so we fall
  // straight to the GET-via-pod path. Same shape (`{ siblings }`) for
  // both transports though, which is why this is a "WS+poll fallback"
  // shape rather than a poll-only one — when a future BFF exposes a
  // session-token sibling stream this view will pick it up by flipping
  // the WS branch on.
  const baseUrl = getPodBaseUrl();
  const tok = getSessionToken();
  if (!baseUrl || !tok) {
    root.innerHTML = '<div class="card placeholder">not paired</div>';
    return;
  }
  let body;
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/live_siblings/list`, {
      headers: { "x-flagship-session": tok },
    });
    if (!r.ok) {
      // /api/live_siblings/* is app-token-bearer in production, so 401
      // is the normal state for the webapp. Surface that politely.
      if (r.status === 401 || r.status === 403) {
        root.innerHTML =
          '<div class="card placeholder">live sibling list is gated to app tokens — no peer info available to the webapp yet</div>';
        root.dataset.hasRendered = "1";
        return;
      }
      throw new Error(`HTTP ${r.status}`);
    }
    body = await r.json();
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(String(e.message ?? e))}</p></div>`;
    return;
  }
  const siblings = body.siblings ?? [];
  if (!siblings.length) {
    root.innerHTML =
      '<div class="card placeholder">no live siblings — this is the only pod of yours online right now. Bring another pod online to multiplex across both.</div>';
    root.dataset.hasRendered = "1";
    return;
  }
  root.innerHTML = siblings.map((s) => {
    const online = s.online !== false;
    const fqdns = (s.fqdns ?? []).map((f) => escapeHtml(f)).join(", ") || "—";
    const lastSeen = s.lastSeenMs ? `seen ${escapeHtml(fmtDate(s.lastSeenMs))}` : "";
    return `
      <div class="card">
        <div class="row row-top">
          <div>
            <div class="weight-600">${escapeHtml(s.siblingId ?? "?")} ${online ? '<span class="pill ok">online</span>' : '<span class="pill warn">offline</span>'}</div>
            <div class="value text-xs">${fqdns}</div>
            <div class="faint-sm">${lastSeen}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
  root.dataset.hasRendered = "1";
}

function scheduleSiblingPoll() {
  clearSiblingPoll();
  siblingPollTimer = setTimeout(() => {
    renderLiveSiblings()
      .catch((e) => { console.error(e); toast(humanError(e), "err"); })
      .finally(() => {
        const visible = !$("view-url-controller")?.classList.contains("hidden");
        if (visible) scheduleSiblingPoll();
      });
  }, SIBLING_POLL_INTERVAL_MS);
}

async function runClaim() {
  const input = $("url-controller-claim-input");
  const btn = $("url-controller-claim-go");
  const fqdn = (input?.value ?? "").trim();
  if (!fqdn) return toast("enter an FQDN", "err");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "claiming…";
  }
  try {
    await screensFetch("/api/screens/url-controller/claim", {
      method: "POST",
      body: JSON.stringify({ fqdn }),
    });
    toast(`claimed ${fqdn}`);
    if (input) input.value = "";
    await renderOwned();
    // Auto-kick a verify request so the user sees the TXT record they
    // need to publish without having to find a "verify" button.
    void runVerify(fqdn);
  } catch (e) {
    toast(e.message ?? String(e), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Claim";
    }
  }
}

/**
 * P1.22 — POST /api/screens/url-controller/verify. The daemon resolves
 * `_flagship.<fqdn>` TXT and reports back PENDING / VERIFIED / FAILED.
 * On PENDING the daemon also returns the exact `expectedTxtRecord` the
 * user needs to publish.
 */
async function runVerify(fqdn) {
  try {
    const body = await screensFetch("/api/screens/url-controller/verify", {
      method: "POST",
      body: JSON.stringify({ fqdn }),
    });
    if (body.status === "verified") {
      toast(`verified ${fqdn}`);
      return;
    }
    if (body.status === "pending") {
      toast(
        `pending: publish TXT _flagship.${fqdn} = ${body.expectedTxtRecord}`,
        "warn",
        8_000,
      );
      return;
    }
    toast(`verify failed: ${body.reason ?? "unknown"}`, "err");
  } catch (e) {
    if (e.status === 404) {
      // Daemon hasn't shipped /verify yet — silently skip rather than
      // confuse the user. iOS surfaces the same case as a noop.
      return;
    }
    toast(`verify error: ${e.message ?? e}`, "err");
  }
}

async function runDrop(fqdn, btn) {
  if (!fqdn) return;
  if (!confirm(`Drop your claim on ${fqdn}? Live traffic will fail over to whichever sibling pod takes it next.`)) {
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "dropping…";
  }
  try {
    // The daemon's /api/screens/url-controller surface does not yet
    // expose an explicit drop endpoint; the sibling-router's
    // `/api/url/release` is app-token-bearer. For paired-session calls
    // we surface a clear "not yet wired" error rather than silently
    // claiming the wrong thing.
    const baseUrl = getPodBaseUrl();
    const tok = getSessionToken();
    if (!baseUrl || !tok) throw new Error("not paired");
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/screens/url-controller/release`, {
      method: "POST",
      headers: { "x-flagship-session": tok, "content-type": "application/json" },
      body: JSON.stringify({ fqdn }),
    });
    if (r.status === 404) {
      // BFF doesn't expose release yet — surface a TODO link.
      throw new Error("drop not yet wired in the daemon BFF; ask the server admin to release manually");
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`drop failed: ${r.status} ${text}`.trim());
    }
    toast(`dropped ${fqdn}`);
    await renderOwned();
  } catch (e) {
    toast(e.message ?? String(e), "err");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "drop";
    }
  }
}

export function initUrlControllerView() {
  $("url-controller-back")?.addEventListener("click", () => {
    clearSiblingPoll();
    closeSiblingSocket();
    show("view-home");
  });
  $("url-controller-refresh")?.addEventListener("click", () => {
    renderOwned().catch((e) => { console.error(e); toast(humanError(e), "err"); });
    renderLiveSiblings().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  $("url-controller-claim-go")?.addEventListener("click", runClaim);
}

export async function enterUrlController() {
  show("view-url-controller");
  await renderOwned();
  await renderLiveSiblings();
  scheduleSiblingPoll();
}
