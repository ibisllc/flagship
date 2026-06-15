// P2.5 — Build-from-scratch chat.
//
// A real multi-turn chat with attachments. The owner describes a service
// (optionally attaching a screenshot/mockup or a text file the app should
// use); the AI writes + deploys it on the box.
//
// Flow:
//   1. First turn → POST /api/screens/vibe-code/start { prompt, attachments }.
//   2. Poll GET /api/screens/vibe-code/<id> for status + files; render the
//      streamed/assembled assistant reply into the message list.
//   3. When the AI pauses to ask a question (status awaiting-tool-response
//      with a talkToUser pending request), the composer sends the next
//      turn to POST /api/screens/llm/sessions/<id>/reply { text, attachments }.
//   4. When status becomes ready-to-deploy, surface Deploy →
//      /api/llm/sessions/<id>/deploy.
//
// Attachments are inlined as base64 (no upload endpoint). The client
// mirrors the server caps so a violation is a friendly toast, not a 400.
// The chat is NOT a secret channel — the composer note says so.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-vibe-code");

const POLL_INTERVAL_MS = 800;
const TERMINAL_STATUSES = new Set(["deployed", "failed", "cancelled"]);

// Caps — mirror packages/server-daemon/src/llm/vibeCodeAttachments.ts.
const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_TEXT_BYTES = 256 * 1024; // 256 KB
const TEXT_EXTENSIONS = /\.(txt|md|sql|json|csv)$/i;

let activeSessionId = null;
let pollTimer = null;
// Pending attachments staged in the composer for the NEXT turn.
let staged = [];
// The pending talkToUser tool the AI is waiting on, when any.
let pendingTalkToolId = null;

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ---- attachment staging --------------------------------------------------

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => {
      // data:<mime>;base64,<data>
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}

async function stageFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (staged.length >= MAX_ATTACHMENTS) {
      toast(`Up to ${MAX_ATTACHMENTS} files per message.`, "err");
      break;
    }
    const isImage = file.type.startsWith("image/");
    const isText = file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name);
    try {
      if (isImage) {
        if (file.size > MAX_IMAGE_BYTES) {
          toast(`"${file.name}" is too large (images ≤ 4 MB).`, "err");
          continue;
        }
        const dataBase64 = await readFileAsBase64(file);
        staged.push({ kind: "image", mediaType: file.type, dataBase64, name: file.name });
      } else if (isText) {
        if (file.size > MAX_TEXT_BYTES) {
          toast(`"${file.name}" is too large (text ≤ 256 KB).`, "err");
          continue;
        }
        const text = await readFileAsText(file);
        staged.push({ kind: "text", text, name: file.name });
      } else {
        toast(`"${file.name}" isn't a supported type (image or text).`, "err");
      }
    } catch (e) {
      toast(`Couldn't attach "${file.name}".`, "err");
    }
  }
  renderChips();
}

function removeStaged(idx) {
  staged.splice(idx, 1);
  renderChips();
}

function renderChips() {
  const box = $("vc-attach-chips");
  if (!box) return;
  if (staged.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = staged
    .map((a, i) => {
      const thumb =
        a.kind === "image"
          ? `<img class="vc-chip-thumb" alt="" src="data:${escapeHtml(a.mediaType)};base64,${a.dataBase64}">`
          : `<span class="vc-chip-icon" aria-hidden="true">📄</span>`;
      const label = escapeHtml(a.name || (a.kind === "image" ? "image" : "text"));
      return `
        <span class="vc-chip" data-idx="${i}">
          ${thumb}
          <span class="vc-chip-name">${label}</span>
          <button class="vc-chip-x" data-idx="${i}" aria-label="Remove ${label}">×</button>
        </span>`;
    })
    .join("");
  box.querySelectorAll(".vc-chip-x").forEach((btn) => {
    btn.addEventListener("click", () => removeStaged(Number(btn.dataset.idx)));
  });
}

// ---- send / poll ---------------------------------------------------------

async function send() {
  const promptEl = $("vc-prompt");
  const text = promptEl.value.trim();
  if (!text && staged.length === 0) return toast("Type a message first.", "err");
  const attachments = staged.slice();
  const sendBtn = $("vc-send");
  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  try {
    if (!activeSessionId) {
      // First turn — start the session.
      const r = await screensFetch("/api/screens/vibe-code/start", {
        method: "POST",
        body: JSON.stringify({ prompt: text, attachments }),
      });
      activeSessionId = r.sessionId;
    } else if (pendingTalkToolId) {
      // Follow-up turn answering the AI's talkToUser question.
      await screensFetch(
        `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}/reply`,
        { method: "POST", body: JSON.stringify({ text, attachments }) },
      );
      pendingTalkToolId = null;
    } else {
      toast("Wait for the AI to finish this turn.", "info");
      return;
    }
    // Clear the composer + staged attachments.
    promptEl.value = "";
    staged = [];
    renderChips();
    schedulePoll();
    await poll();
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
}

function schedulePoll() {
  clearPoll();
  pollTimer = setTimeout(() => poll().catch(() => {}), POLL_INTERVAL_MS);
}

async function poll() {
  if (!activeSessionId) return;
  // The richer public state carries per-message attachments + the pending
  // tool; the older /vibe-code/:id snapshot is the fallback.
  let state;
  try {
    state = await screensFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}`,
    );
  } catch {
    try {
      const snap = await screensFetch(
        `/api/screens/vibe-code/${encodeURIComponent(activeSessionId)}`,
      );
      state = {
        status: snap.status,
        messages: (snap.transcript || []).map((t) => ({ role: t.role, text: t.content })),
        files: snap.files,
        deployedUrl: snap.deployedUrl,
      };
    } catch (e) {
      $("vc-status").textContent = e instanceof ScreensError ? `error: ${e.message}` : "error";
      return;
    }
  }
  render(state);
  if (!TERMINAL_STATUSES.has(state.status)) schedulePoll();
}

function statusLabel(status) {
  switch (status) {
    case "streaming": return "Writing…";
    case "awaiting-tool-response": return "The AI has a question";
    case "ready-to-deploy": return "Ready to deploy";
    case "deploying": return "Deploying…";
    case "deployed": return "Deployed";
    case "failed": return "Something went wrong";
    case "cancelled": return "Cancelled";
    default: return status || "idle";
  }
}

function attachmentMarkup(att) {
  if (!att || att.length === 0) return "";
  return `<div class="vc-msg-attachments">${att
    .map((a) => {
      if (a.kind === "image" && a.dataBase64) {
        return `<img class="vc-msg-thumb" alt="${escapeHtml(a.name || "image")}" src="data:${escapeHtml(a.mediaType || "image/png")};base64,${a.dataBase64}">`;
      }
      return `<span class="vc-msg-file">📄 ${escapeHtml(a.name || "text")}</span>`;
    })
    .join("")}</div>`;
}

function render(state) {
  $("vc-status").textContent = statusLabel(state.status);

  // Message list — user right, assistant left.
  const log = $("vc-messages");
  const messages = state.messages || [];
  // When the AI is asking a question, surface it as the latest assistant
  // bubble so the user sees what they're replying to.
  let extra = [];
  pendingTalkToolId = null;
  if (state.pendingRequest && state.pendingRequest.kind === "talkToUser") {
    pendingTalkToolId = state.pendingRequest.toolUseId;
    extra = [{ role: "assistant", text: state.pendingRequest.payload.message }];
  }
  const all = messages.concat(extra);
  if (all.length === 0) {
    log.innerHTML = '<div class="card placeholder">Say what you\'d like to build to get started.</div>';
  } else {
    log.innerHTML = all
      .map((m) => {
        const side = m.role === "user" ? "vc-msg-user" : "vc-msg-ai";
        const who = m.role === "user" ? "You" : "AI";
        return `
          <div class="vc-msg ${side}">
            <div class="vc-msg-role">${who}</div>
            <div class="vc-msg-text">${escapeHtml(m.text || "")}</div>
            ${attachmentMarkup(m.attachments)}
          </div>`;
      })
      .join("");
    log.scrollTop = log.scrollHeight;
  }

  // The composer is a reply box only when the AI asked a question, ready
  // for a fresh build, or pre-session. While the AI is writing, the Send
  // button is disabled to make the turn-taking obvious.
  const sendBtn = $("vc-send");
  if (state.status === "streaming" || state.status === "deploying") {
    sendBtn.disabled = true;
  } else {
    sendBtn.disabled = false;
  }

  // Files tree.
  const files = state.files || {};
  const paths = Object.keys(files).sort();
  $("vc-files-count").textContent = paths.length === 0 ? "(none yet)" : `(${paths.length})`;
  const filesRoot = $("vc-files");
  if (paths.length === 0) {
    filesRoot.innerHTML = '<div class="card placeholder">files appear here as the AI emits them…</div>';
  } else {
    filesRoot.innerHTML = paths
      .map(
        (p) => `
      <div class="card card-compact">
        <details>
          <summary class="file-summary">${escapeHtml(p)} <span class="file-summary-meta">(${files[p].length} chars)</span></summary>
          <pre class="file-body">${escapeHtml(files[p])}</pre>
        </details>
      </div>`,
      )
      .join("");
  }

  // Deploy affordance.
  const deployBox = $("vc-deploy-box");
  deployBox.classList.toggle("hidden", state.status !== "ready-to-deploy");

  // Result.
  const resultBox = $("vc-result");
  if (state.deployedUrl) {
    resultBox.innerHTML = `
      <div class="card">
        <div class="weight-600">Deployed ✓</div>
        <div class="value text-sm mt-1">
          <a href="${escapeHtml(state.deployedUrl)}" target="_blank" rel="noopener">${escapeHtml(state.deployedUrl)}</a>
        </div>
      </div>`;
    resultBox.classList.remove("hidden");
  } else if (state.errorReason) {
    resultBox.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(state.errorReason)}</p></div>`;
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
        headers: { "x-flagship-session": tok, "content-type": "application/json" },
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`deploy failed: ${r.status} ${text}`.trim());
    }
    toast("deployed");
    schedulePoll();
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.textContent = "Deploy";
  }
}

function reset() {
  clearPoll();
  activeSessionId = null;
  staged = [];
  pendingTalkToolId = null;
  renderChips();
  const promptEl = $("vc-prompt");
  promptEl.disabled = false;
  promptEl.value = "";
  $("vc-status").textContent = "idle";
  $("vc-messages").innerHTML =
    '<div class="card placeholder">Say what you\'d like to build to get started.</div>';
  $("vc-files").innerHTML = "";
  $("vc-files-count").textContent = "(none yet)";
  $("vc-deploy-box")?.classList.add("hidden");
  $("vc-result")?.classList.add("hidden");
  const sendBtn = $("vc-send");
  sendBtn.disabled = false;
  sendBtn.textContent = "Send";
  const deployBtn = $("vc-deploy-go");
  if (deployBtn) {
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy";
  }
}

export function initVibeCodeView() {
  $("vc-send")?.addEventListener("click", send);
  $("vc-deploy-go")?.addEventListener("click", triggerDeploy);
  $("vc-reset")?.addEventListener("click", reset);
  $("vc-attach-input")?.addEventListener("change", (e) => {
    void stageFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  });
  $("vibe-code-back")?.addEventListener("click", () => {
    clearPoll();
    show("view-home");
  });
}

export async function enterVibeCode() {
  // Building a service needs a server to build and run it. With none
  // paired, nudge the user to add one rather than opening a dead form.
  if (!getPodBaseUrl()) {
    toast("Please add your first server.", "err");
    show("view-home");
    return;
  }
  show("view-vibe-code");
  reset();
}
