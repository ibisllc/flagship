// P2.5 — Vibe-code dialog.
//
// Flow:
//   1. User types a prompt → POST /api/screens/vibe-code/start (P1.5).
//   2. Open a WS to /api/screens/vibe-code/<id>/stream (P1.6) and
//      render frames live. Token frames append to the assistant
//      transcript; manifest-emit / deploy / done / error are surfaced
//      as discrete UI states.
//   3. On WS open we ALSO do an immediate GET P1.7 to pull the
//      current files snapshot, since the WS doesn't replay token
//      deltas (clients that need transcript history use polling).
//   4. If the WS errors out — older daemons return 501 — fall back to
//      polling P1.7 every 500ms until terminal.
//   5. When status becomes ready-to-deploy, surface a Deploy button
//      that calls /api/llm/sessions/<id>/deploy.
//
// Both code paths run against the same daemon-side primitives, so the
// fallback is fully equivalent — just chattier on the network.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-vibe-code");

const POLL_INTERVAL_MS = 500;
const TERMINAL_STATUSES = new Set(["deployed", "failed", "cancelled"]);

let activeSessionId = null;
let pollTimer = null;
let activeSocket = null;
let assistantStreamBuffer = "";

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function closeSocket() {
  if (activeSocket) {
    try { activeSocket.close(); } catch (_e) { /* ignore */ }
    activeSocket = null;
  }
}

async function startSession() {
  const promptEl = $("vc-prompt");
  const prompt = promptEl.value.trim();
  if (!prompt) return toast("enter a prompt first", "err");
  const startBtn = $("vc-start");
  startBtn.disabled = true;
  startBtn.textContent = "starting…";
  try {
    const r = await screensFetch("/api/screens/vibe-code/start", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    activeSessionId = r.sessionId;
    promptEl.disabled = true;
    openStream();
  } catch (e) {
    if (e instanceof ScreensError) toast(e.message, "err");
    else toast(String(e), "err");
    startBtn.disabled = false;
    startBtn.textContent = "Start";
  }
}

function openStream() {
  if (!activeSessionId) return;
  const baseUrl = getPodBaseUrl();
  const tok = getSessionToken();
  if (!baseUrl || !tok) {
    schedulePoll();
    return;
  }
  // The pod URL is https://; flip the protocol for the WS upgrade.
  const wsBase = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const url = `${wsBase}/api/screens/vibe-code/${encodeURIComponent(activeSessionId)}/stream?sessionToken=${encodeURIComponent(tok)}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    schedulePoll();
    return;
  }
  activeSocket = socket;

  // Pull the current snapshot once so the files-tree renders even
  // before any frames arrive.
  void (async () => {
    try {
      const body = await screensFetch(
        `/api/screens/vibe-code/${encodeURIComponent(activeSessionId)}`,
      );
      renderSession(body);
    } catch {
      /* ignore — the WS will catch us up when frames flow */
    }
  })();

  socket.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });
  socket.addEventListener("error", () => {
    // Often the server returned a non-101; fall back to polling.
    if (activeSocket === socket) activeSocket = null;
    schedulePoll();
  });
  socket.addEventListener("close", () => {
    if (activeSocket === socket) activeSocket = null;
    // After WS close, refresh once via GET — picks up the terminal
    // state if we missed the closing frame.
    if (activeSessionId) {
      poll().catch(() => {});
    }
  });
}

function handleFrame(frame) {
  if (!frame || typeof frame.kind !== "string") return;
  switch (frame.kind) {
    case "token": {
      assistantStreamBuffer += frame.text ?? "";
      $("vc-transcript").textContent = assistantStreamBuffer;
      // Keep status fresh — the GET reconciles files-tree snapshots.
      $("vc-status").textContent = "streaming";
      return;
    }
    case "manifest-emit":
    case "build-start":
    case "deploy":
    case "done":
    case "error":
      // For these state transitions we re-fetch P1.7 once — the
      // session's files-tree + status are easier to render against
      // the canonical snapshot than to maintain locally in the FE.
      poll().catch(() => {});
      if (frame.kind === "error" && frame.message) toast(frame.message, "err");
      return;
    default:
      return;
  }
}

function schedulePoll() {
  clearPoll();
  pollTimer = setTimeout(() => poll().catch((e) => toast(String(e), "err")), POLL_INTERVAL_MS);
}

async function poll() {
  if (!activeSessionId) return;
  let body;
  try {
    body = await screensFetch(
      `/api/screens/vibe-code/${encodeURIComponent(activeSessionId)}`,
    );
  } catch (e) {
    if (e instanceof ScreensError) {
      $("vc-status").textContent = `error: ${e.message}`;
      return;
    }
    throw e;
  }
  renderSession(body);
  if (!TERMINAL_STATUSES.has(body.status)) {
    schedulePoll();
  }
}

function renderSession(body) {
  $("vc-status").textContent = body.status;
  // Transcript: just the assistant's most-recent reply, if any.
  const assistant = body.transcript.find((t) => t.role === "assistant");
  $("vc-transcript").textContent = assistant?.content ?? "";

  // Files tree.
  const filesRoot = $("vc-files");
  const files = body.files ?? {};
  const paths = Object.keys(files).sort();
  if (paths.length === 0) {
    filesRoot.innerHTML = '<div class="card placeholder">files appear here as the LLM emits them…</div>';
  } else {
    filesRoot.innerHTML = paths.map((p) => `
      <div class="card card-compact">
        <details>
          <summary class="file-summary">${escapeHtml(p)} <span class="file-summary-meta">(${files[p].length} chars)</span></summary>
          <pre class="file-body">${escapeHtml(files[p])}</pre>
        </details>
      </div>
    `).join("");
  }

  // Deploy button — visible when ready-to-deploy.
  const deployBox = $("vc-deploy-box");
  if (body.status === "ready-to-deploy") {
    deployBox.classList.remove("hidden");
  } else {
    deployBox.classList.add("hidden");
  }

  // Deployed result.
  const resultBox = $("vc-result");
  if (body.deployedUrl) {
    // Task #28 — terminal "Publish this app" action. Posts the
    // canonical name + manifest to /api/screens/marketplace/publish so
    // the daemon (which has the IRK + manifest hash) signs the listing
    // request to .com. The webapp doesn't need the manifest contents
    // here — just the canonical app id; the daemon resolves the rest.
    const appCanonical = body.appCanonical ?? body.canonicalAppName ?? null;
    const publishedSlug = body.marketplaceSlug ?? null;
    resultBox.innerHTML = `
      <div class="card">
        <div class="weight-600">deployed ✓</div>
        <div class="value text-sm mt-1">
          <a href="${escapeHtml(body.deployedUrl)}" target="_blank" rel="noopener">${escapeHtml(body.deployedUrl)}</a>
        </div>
        ${publishedSlug
          ? `<div class="faint-sm mt-2">published as <code>${escapeHtml(publishedSlug)}</code> on the marketplace</div>`
          : `<button id="vc-publish" class="secondary mt-2 full-width" data-canonical="${escapeHtml(appCanonical ?? "")}">
              Publish this app
            </button>`}
      </div>
    `;
    resultBox.classList.remove("hidden");
    $("vc-publish")?.addEventListener("click", () => publishToMarketplace(appCanonical));
  } else if (body.errorReason) {
    resultBox.innerHTML = `
      <div class="card"><p class="err-text">${escapeHtml(body.errorReason)}</p></div>
    `;
    resultBox.classList.remove("hidden");
  } else {
    resultBox.classList.add("hidden");
  }
}

/**
 * Task #28 — Publish a vibe-coded app to the marketplace.
 *
 * POSTs `/api/screens/marketplace/publish` with the canonical app
 * name. The daemon resolves the manifest, signs the listing request
 * with the user's IRK, and proxies to .com's POST /api/marketplace/list.
 *
 * The webapp doesn't see the manifest contents — that lives on the
 * pod's data layer and the daemon has direct access. Listings stay
 * `scan_grade=null` until the scanner service catches up.
 */
async function publishToMarketplace(appCanonical) {
  if (!appCanonical) {
    return toast("missing app canonical name", "err");
  }
  if (!confirm(
    `Publish "${appCanonical}" to the Flagship marketplace? You can unlist later from the marketplace view.`,
  )) {
    return;
  }
  const btn = $("vc-publish");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "publishing…";
  }
  try {
    const r = await screensFetch("/api/screens/marketplace/publish", {
      method: "POST",
      body: JSON.stringify({ appCanonical }),
    });
    toast(`published as ${r.slug ?? appCanonical}`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "published ✓";
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Publish this app";
    }
    toast(e.message ?? String(e), "err");
  }
}

async function triggerDeploy() {
  if (!activeSessionId) return;
  const baseUrl = getPodBaseUrl();
  const tok = getSessionToken();
  if (!baseUrl || !tok) return toast("not paired", "err");
  const btn = $("vc-deploy-go");
  btn.disabled = true;
  btn.textContent = "deploying…";
  try {
    const r = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/llm/sessions/${encodeURIComponent(activeSessionId)}/deploy`,
      {
        method: "POST",
        headers: {
          "x-flagship-session": tok,
          "content-type": "application/json",
        },
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`deploy failed: ${r.status} ${text}`.trim());
    }
    toast("deployed");
    schedulePoll(); // pick up the new status + url
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.textContent = "Deploy";
  }
}

function reset() {
  clearPoll();
  closeSocket();
  activeSessionId = null;
  assistantStreamBuffer = "";
  const promptEl = $("vc-prompt");
  promptEl.disabled = false;
  promptEl.value = "";
  $("vc-status").textContent = "idle";
  $("vc-transcript").textContent = "";
  $("vc-files").innerHTML = "";
  $("vc-deploy-box")?.classList.add("hidden");
  $("vc-result")?.classList.add("hidden");
  const startBtn = $("vc-start");
  startBtn.disabled = false;
  startBtn.textContent = "Start";
  const deployBtn = $("vc-deploy-go");
  if (deployBtn) {
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
  }
}

export function initVibeCodeView() {
  $("vc-start")?.addEventListener("click", startSession);
  $("vc-deploy-go")?.addEventListener("click", triggerDeploy);
  $("vc-reset")?.addEventListener("click", reset);
  $("vibe-code-back")?.addEventListener("click", () => {
    clearPoll();
    closeSocket();
    show("view-home");
  });
}

export async function enterVibeCode() {
  show("view-vibe-code");
  reset();
}
