// P2.5 — Vibe-code dialog.
//
// Flow:
//   1. User types a prompt → POST /api/screens/vibe-code/start (P1.5).
//   2. While the session is in `streaming`/`ready-to-deploy`, poll
//      /api/screens/vibe-code/<id> (P1.7) every 500ms and re-render
//      transcript + files tree.
//   3. When status becomes `ready-to-deploy`, surface a "Deploy" button
//      that calls /api/llm/sessions/<id>/deploy (the legacy deploy
//      endpoint — works with the production-wired deploySession seam).
//   4. Final state surfaces the deployedUrl.
//
// The WS stream variant (P1.6) is a follow-up; this polling-based
// cadence is good enough for v1 and exercises the same daemon path.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-vibe-code");

const POLL_INTERVAL_MS = 500;
const TERMINAL_STATUSES = new Set(["deployed", "failed", "cancelled"]);

let activeSessionId = null;
let pollTimer = null;

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
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
    schedulePoll();
  } catch (e) {
    if (e instanceof ScreensError) toast(e.message, "err");
    else toast(String(e), "err");
    startBtn.disabled = false;
    startBtn.textContent = "Start";
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
      <div class="card" style="padding: 0.4rem 0.7rem;">
        <details>
          <summary style="cursor: pointer; font-weight: 600;">${escapeHtml(p)} <span style="color:var(--fg-mute); font-weight: 400;">(${files[p].length} chars)</span></summary>
          <pre style="margin: 0.4rem 0 0; white-space: pre-wrap; font-size: 0.78rem; color: var(--fg-mute);">${escapeHtml(files[p])}</pre>
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
    resultBox.innerHTML = `
      <div class="card">
        <div style="font-weight:600;">deployed ✓</div>
        <div class="value" style="font-size:0.85rem; margin-top:0.2rem;">
          <a href="${escapeHtml(body.deployedUrl)}" target="_blank" rel="noopener">${escapeHtml(body.deployedUrl)}</a>
        </div>
      </div>
    `;
    resultBox.classList.remove("hidden");
  } else if (body.errorReason) {
    resultBox.innerHTML = `
      <div class="card"><p style="margin:0; color:var(--err);">${escapeHtml(body.errorReason)}</p></div>
    `;
    resultBox.classList.remove("hidden");
  } else {
    resultBox.classList.add("hidden");
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
  activeSessionId = null;
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
    show("view-home");
  });
}

export async function enterVibeCode() {
  show("view-vibe-code");
  reset();
}
