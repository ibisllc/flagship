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
import { activeOperations } from "../lib/activeOperations.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { enterBuildKey } from "./build-key.js";

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
// The in-memory BYOK credential the box should use to drive this build, set
// from the AI-key step. { provider, apiKey, baseUrl? } — never persisted here
// and never sent to flagshipserver.com (screensFetch goes to the box).
let buildCredential = null;
// Pending attachments staged in the composer for the NEXT turn.
let staged = [];
// The pending talkToUser tool the AI is waiting on, when any.
let pendingTalkToolId = null;
// The headline noun shown in the global operations sliver for this build —
// seeded from the first prompt so the sliver reads "building <subject> on
// <server>" while the AI works. Refreshed if the build's name is learned.
let buildSubject = null;

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ---- global operations sliver (build feeder) -----------------------------

/** The short server name for the sliver's "on <server>" clause — the first
 *  DNS label of the paired pod's host (`home.alice.flagship.services` → "home").
 *  Empty when no pod is paired (the sliver then drops the "on …" clause). */
function pairedServerName() {
  const base = getPodBaseUrl();
  if (!base) return null;
  try {
    return new URL(base).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

/** A friendly subject from the first prompt — the first few words, so the
 *  sliver shows something human while the service has no name yet. */
function subjectFromPrompt(text) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "new service";
  const words = t.split(" ").slice(0, 4).join(" ");
  return words.length > 32 ? `${words.slice(0, 31)}…` : words;
}

/** Register / refresh this session's build op in the sliver. */
function registerBuildOp() {
  if (!activeSessionId) return;
  activeOperations.upsertBuild(
    activeSessionId,
    buildSubject || "new service",
    pairedServerName(),
    { view: "view-vibe-code" },
  );
}

/** Drop this session's build op (terminal status, reset, or leaving). */
function removeBuildOp() {
  if (activeSessionId) activeOperations.removeBuild(activeSessionId);
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
      // First turn — start the session, carrying the BYOK credential so the
      // box can drive the build with the owner's chosen key.
      const startBody = { prompt: text, attachments };
      if (buildCredential) startBody.credential = buildCredential;
      const r = await screensFetch("/api/screens/vibe-code/start", {
        method: "POST",
        body: JSON.stringify(startBody),
      });
      activeSessionId = r.sessionId;
      if (r.needsCredential) {
        // No model can drive this yet — gently route into the AI-key step.
        // Don't surface a sliver op for a build that hasn't actually started.
        toast("Add an AI key to start.", "warn");
        promptEl.value = text; // keep what they typed
        promptEl.disabled = false;
        enterBuildKey({
          contextLabel: "Start from scratch with AI",
          back: "view-vibe-code",
          onChosen: (credential) => {
            buildCredential = credential;
            activeSessionId = null; // re-start cleanly with the key
            show("view-vibe-code");
            void send();
          },
        });
        return;
      }
      // The build is really running now — surface it in the global operations
      // sliver as "building <subject> on <server>" until it deploys or fails.
      buildSubject = subjectFromPrompt(text);
      registerBuildOp();
    } else if (pendingTalkToolId) {
      // Follow-up turn answering the AI's talkToUser question.
      const replyBody = { text, attachments };
      if (buildCredential) replyBody.credential = buildCredential;
      await screensFetch(
        `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}/reply`,
        { method: "POST", body: JSON.stringify(replyBody) },
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
  if (!TERMINAL_STATUSES.has(state.status)) {
    schedulePoll();
  } else {
    // Deployed / failed / cancelled — the operation is over; clear it from
    // the global sliver so the strip collapses.
    removeBuildOp();
  }
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
    // Task #28 — terminal "Publish this app" action: post the canonical
    // app id to /api/screens/marketplace/publish so the daemon (which holds
    // the IRK + manifest hash) signs the listing request to .com.
    const serviceCanonical = state.serviceCanonical ?? state.canonicalAppName ?? null;
    const publishedSlug = state.marketplaceSlug ?? null;
    resultBox.innerHTML = `
      <div class="card">
        <div class="weight-600">Deployed ✓</div>
        <div class="value text-sm mt-1">
          <a href="${escapeHtml(state.deployedUrl)}" target="_blank" rel="noopener">${escapeHtml(state.deployedUrl)}</a>
        </div>
        ${publishedSlug
          ? `<div class="faint-sm mt-2">published as <code>${escapeHtml(publishedSlug)}</code> on the marketplace</div>`
          : `<button id="vc-publish" class="secondary mt-2 full-width" data-canonical="${escapeHtml(serviceCanonical ?? "")}">
              Publish this app
            </button>`}
      </div>
    `;
    resultBox.classList.remove("hidden");
    $("vc-publish")?.addEventListener("click", () => publishToMarketplace(serviceCanonical));
  } else if (state.errorReason) {
    resultBox.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(state.errorReason)}</p></div>`;
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
async function publishToMarketplace(serviceCanonical) {
  if (!serviceCanonical) {
    return toast("missing app canonical name", "err");
  }
  if (!confirm(
    `Publish "${serviceCanonical}" to the Flagship marketplace? You can unlist later from the marketplace view.`,
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
      body: JSON.stringify({ serviceCanonical }),
    });
    toast(`published as ${r.slug ?? serviceCanonical}`);
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
  // Drop any in-flight build op from the global sliver before we forget the
  // session id (removeBuildOp keys off activeSessionId).
  removeBuildOp();
  activeSessionId = null;
  staged = [];
  pendingTalkToolId = null;
  buildCredential = null;
  buildSubject = null;
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

export async function enterVibeCode(opts = {}) {
  // Building a service needs a server to build and run it. With none
  // paired, nudge the user to add one rather than opening a dead form.
  if (!getPodBaseUrl()) {
    toast("Please add your first server.", "err");
    show("view-home");
    return;
  }
  show("view-vibe-code");
  reset();
  // The AI-key step hands the chosen credential in here; reset() clears it,
  // so apply it after.
  if (opts.credential) buildCredential = opts.credential;
}

/**
 * Return to the chat WITHOUT discarding an in-flight build — used when the
 * user taps the global operations sliver for a running build. If a session
 * is live we just re-show the view and re-arm polling so the transcript +
 * status pick up where they left off; otherwise this is a fresh entry.
 */
export async function resumeVibeCode() {
  if (!activeSessionId) return enterVibeCode();
  show("view-vibe-code");
  schedulePoll();
  await poll().catch(() => {});
}
