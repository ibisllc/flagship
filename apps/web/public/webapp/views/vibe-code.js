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
//      /api/llm/sessions/<id>/deploy {background:true}. The box tests the app
//      on a private copy, then installs it; the session's deployPhase says
//      which (lib/chatDeploy.js). After a deploy the session's AI key is gone,
//      so a later turn meets the usual needsCredential prompt.
//
// Attachments are inlined as base64 or text (no upload endpoint): images,
// text/code, CSV/JSON sample data and PDFs. The client mirrors the server
// caps so a violation is a friendly inline error, not a 400. The chat is NOT
// a secret channel, and the AI sees what's attached; the composer says so.
//
// The header's model menu (lib/modelMenu.js) picks the model and effort;
// both ride start and every reply, so the owner can change them between
// messages. A chat starts on the default model saved in Settings.

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, boxClient } from "../lib/api.js";
import { creationTarget, mountCreationPicker } from "../lib/appPlacement.js";
import { activeOperations } from "../lib/activeOperations.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { inlineAlert, inlineConfirm } from "../lib/modal.js";
import {
  CONFLICT_TITLE,
  EXAMPLES,
  INVITE_ONLY,
  canBuild,
  checkName,
  conflictFromError,
  conflictMessage,
  nameWarning,
  slugify,
  visibilityExplanation,
} from "../lib/vibeNames.js";
import { enterBuildKey } from "./build-key.js";
import { enterBuildJournal } from "./build-journal.js";
import { deployPhaseText, deployRequestBody, startAndFollowChatDeploy } from "../lib/chatDeploy.js";
import { RELAY_TURNED_OFF, TURN_RELAY_OFF, isRelayFailure } from "../lib/aiRelay.js";
import { turnRelayOffForCredential } from "../providers.js";
import { getSession } from "../lib/state.js";
import { freshCredential } from "../lib/freeAi.js";
import { defaultModelFor, loadProviders } from "../providers.js";
import {
  MAX_ATTACHMENTS,
  attachNotice,
  attachmentIcon,
  classifyFile,
  creditsUsedText,
  dataTextError,
  initialChoice,
  loadModelMenu,
  mountModelMenu,
  visionCheck,
  wireChoice,
  withModel,
} from "../lib/modelMenu.js";

registerView("view-vibe-code");

const POLL_INTERVAL_MS = 800;
const TERMINAL_STATUSES = new Set(["deployed", "failed", "cancelled"]);

export const SUMMARISED_NOTE = "Earlier conversation summarised";

let activeSessionId = null;
let pollTimer = null;
// The in-memory BYOK credential the box should use to drive this build, set
// from the AI-key step. { provider, apiKey, baseUrl?, relay } — never persisted here
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
// The box's latest answer for the name field, and the slug it answered for:
// a check only counts while the field still holds that slug.
let nameCheck = null;
let checkedSlug = "";
let nameCheckTimer = null;
let starting = false;
// Set when a deploy the owner asked to be invite only came back open.
let leftOpen = false;
// The live URL a finished deploy answered with (the session state may not
// carry it).
let deployedUrl = null;
// The relay was turned off for this build's key after a relay failure.
let relayTurnedOff = false;
// Where Back goes instead of the chooser: an edit session returns to the
// service it changes.
let backTo = null;
// The box this build runs on (docs/app-placement.md §2): the server picked
// for a new app, or the box holding a reopened session. Every call goes there.
let box = null;
// The model menu for this build's key, the owner's choice in it, and whether
// the owner changed it here (else a reopened session shows what it uses).
let modelMenu = null;
let modelChoice = { model: null, effort: null, thinkHarder: false };
let choiceTouched = false;
let sessionModel = null;
let menuHandle = null;
let menuLoad = 0;

const client = () => box ?? boxClient();
const boxFetch = (path, init) => client().fetch(path, init);

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
  return client().fqdn.split(".")[0] || null;
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

function showAttachError(message) {
  const el = $("vc-attach-error");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

async function stageFiles(fileList) {
  const files = Array.from(fileList || []);
  const errors = [];
  for (const file of files) {
    if (staged.length >= MAX_ATTACHMENTS) {
      errors.push(`Up to ${MAX_ATTACHMENTS} files per message.`);
      break;
    }
    const c = classifyFile(file);
    if (c.error) {
      errors.push(c.error);
      continue;
    }
    try {
      if (c.kind === "image" || c.kind === "document") {
        staged.push({ kind: c.kind, mediaType: c.mediaType, dataBase64: await readFileAsBase64(file), name: file.name });
      } else if (c.kind === "data") {
        const text = await readFileAsText(file);
        const bad = dataTextError(file.name, c.mediaType, text);
        if (bad) errors.push(bad);
        else staged.push({ kind: "data", name: file.name, mediaType: c.mediaType, text });
      } else {
        staged.push({ kind: "text", text: await readFileAsText(file), name: file.name });
      }
    } catch {
      errors.push(`Couldn't attach "${file.name}".`);
    }
  }
  showAttachError(errors.join(" "));
  renderChips();
}

function removeStaged(idx) {
  staged.splice(idx, 1);
  showAttachError("");
  renderChips();
}

function renderChips() {
  const box = $("vc-attach-chips");
  if (!box) return;
  const notice = $("vc-attach-notice");
  if (notice) notice.innerHTML = attachNotice(staged).map((l) => escapeHtml(l)).join("<br>");
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
          : `<span class="vc-chip-icon" aria-hidden="true">${attachmentIcon(a.kind)}</span>`;
      const label = escapeHtml(a.name || a.kind);
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
  if (!activeSessionId) return startBuild(text);
  if (!text && staged.length === 0) return toast("Type a message first.", "err");
  const attachments = staged.slice();
  if (!(await checkVision(attachments))) return;
  const sendBtn = $("vc-send");
  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  try {
    if (pendingTalkToolId) {
      // Follow-up turn answering the AI's talkToUser question.
      const replyBody = { text, attachments };
      // A free AI pass is swapped for a fresh one on every reply.
      buildCredential = await freshCredential(buildCredential, client().fqdn);
      if (buildCredential) replyBody.credential = buildCredential;
      Object.assign(replyBody, wireChoice(modelMenu, modelChoice, { reply: true }));
      await boxFetch(
        `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}/reply`,
        { method: "POST", body: JSON.stringify(replyBody) },
      );
      pendingTalkToolId = null;
    } else {
      toast("Wait for the AI to finish this turn.", "info");
      return;
    }
    clearComposer();
    schedulePoll();
    await poll();
  } catch (e) {
    toast(errorText(e), "err");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
}

/** What a failed send shows: the box's or free AI's own words, else the raw error. */
export function errorText(e) {
  if (e instanceof ScreensError) return e.message;
  if (typeof e?.code === "string" && e.code.startsWith("free-ai")) return e.message;
  return String(e);
}

function clearComposer() {
  $("vc-prompt").value = "";
  staged = [];
  showAttachError("");
  renderChips();
}

// ---- model menu ----------------------------------------------------------

/** Use `credential` for this build and load its model menu. */
function setBuildCredential(credential) {
  buildCredential = credential;
  return refreshModelMenu();
}

async function refreshModelMenu() {
  const bar = $("vc-model-bar");
  const load = ++menuLoad;
  if (!buildCredential) {
    modelMenu = null;
    bar?.classList.add("hidden");
    return;
  }
  const menu = await loadModelMenu(buildCredential, boxFetch);
  let saved = {};
  const session = getSession();
  if (session?.umk) {
    try {
      saved = defaultModelFor(await loadProviders(session.umk), buildCredential);
    } catch {
      saved = {};
    }
  }
  if (load !== menuLoad) return;
  modelMenu = menu;
  modelChoice = initialChoice(menu, sessionModel ?? saved);
  renderModelBar();
}

function renderModelBar() {
  const bar = $("vc-model-bar");
  if (!bar) return;
  bar.classList.toggle("hidden", !modelMenu);
  if (!modelMenu) return;
  if (menuHandle && bar.firstElementChild) {
    menuHandle.update(modelMenu, modelChoice);
    return;
  }
  menuHandle = mountModelMenu(bar, {
    menu: modelMenu,
    choice: modelChoice,
    onChange: (next) => {
      modelChoice = next;
      choiceTouched = true;
    },
  });
}

/** The session says which model it uses: show that until the owner picks. */
function adoptSessionModel(state) {
  if (!state?.model) return;
  sessionModel = { model: state.model, effort: state.effort };
  if (choiceTouched || !modelMenu || state.model === modelChoice.model) return;
  modelChoice = initialChoice(modelMenu, sessionModel);
  renderModelBar();
}

/**
 * Images for a model that can't see them: offer the switch (or say so).
 * Resolves whether to send.
 */
async function checkVision(attachments) {
  const check = visionCheck(modelMenu, modelChoice, attachments);
  if (check.kind === "ok") return true;
  if (check.kind === "blocked") {
    await inlineAlert({ message: check.message, okLabel: "OK" });
    return false;
  }
  const ok = await inlineConfirm({ message: check.message, okLabel: "Switch", cancelLabel: "Cancel" });
  if (!ok) return false;
  modelChoice = withModel(modelMenu, modelChoice, check.to);
  choiceTouched = true;
  renderModelBar();
  return true;
}

// ---- describe form (first turn) ------------------------------------------

function currentSlug() {
  return slugify($("vc-name")?.value);
}

function currentCheck() {
  return checkedSlug === currentSlug() ? nameCheck : null;
}

function serverFqdn() {
  return client().fqdn;
}

function renderNameStatus() {
  const slug = currentSlug();
  const addr = $("vc-name-address");
  if (addr) {
    addr.innerHTML = `https://<strong class="vc-address-name">${escapeHtml(slug || "<name>")}</strong>.${escapeHtml(serverFqdn())}`;
  }
  const status = $("vc-name-status");
  if (status) {
    const check = currentCheck();
    const warning = nameWarning(check, slug);
    status.classList.remove("is-taken", "is-free");
    if (warning) {
      status.textContent = `⚠ ${warning}`;
      status.classList.add("is-taken");
      status.classList.remove("hidden");
    } else if (check?.ok && check.name) {
      status.textContent = "✓ Available";
      status.classList.add("is-free");
      status.classList.remove("hidden");
    } else {
      status.textContent = "";
      status.classList.add("hidden");
    }
  }
  updateBuildButton();
}

function updateBuildButton() {
  if (activeSessionId) return;
  const btn = $("vc-send");
  if (!btn) return;
  btn.textContent = starting ? "Starting…" : "Build it";
  btn.disabled = !canBuild({
    slug: currentSlug(),
    prompt: $("vc-prompt")?.value,
    check: currentCheck(),
    starting,
  });
}

async function runNameCheck(slug) {
  const result = await checkName({ baseUrl: client().baseUrl, token: client().token(), name: slug });
  if (slug === currentSlug()) {
    nameCheck = result;
    checkedSlug = slug;
    renderNameStatus();
  }
  return result;
}

function onNameInput() {
  if (nameCheckTimer) clearTimeout(nameCheckTimer);
  renderNameStatus();
  const slug = currentSlug();
  if (!slug) return;
  nameCheckTimer = setTimeout(() => void runNameCheck(slug), 350);
}

export async function showConflict(check, name) {
  if (check.kind === "session") {
    const open = await inlineConfirm({
      title: CONFLICT_TITLE,
      message: conflictMessage(check, name),
      okLabel: "Open build sessions",
      cancelLabel: "Pick another name",
    });
    // The list's Back returns to the chooser, not this half-filled form.
    if (open) void enterBuildJournal();
  } else {
    await inlineAlert({ title: CONFLICT_TITLE, message: conflictMessage(check, name), okLabel: "Pick another name" });
  }
}

function renderExamples() {
  const box = $("vc-examples");
  if (!box) return;
  box.innerHTML = EXAMPLES.map(
    (ex, i) => `<button type="button" class="secondary vc-example" data-example="${i}">${escapeHtml(ex.label)}</button>`,
  ).join("");
  box.querySelectorAll("[data-example]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ex = EXAMPLES[Number(btn.dataset.example)];
      if (!ex) return;
      $("vc-prompt").value = ex.text;
      updateBuildButton();
    });
  });
}

function renderVisibilityNote() {
  const note = $("vc-visibility-note");
  if (note) note.textContent = visibilityExplanation($("vc-visibility")?.value);
}

function setFirstTurnVisible(visible) {
  $("vc-first-turn")?.classList.toggle("hidden", !visible);
  $("vc-first-turn-extras")?.classList.toggle("hidden", !visible);
}

async function startBuild(text) {
  if (starting) return;
  const promptEl = $("vc-prompt");
  const slug = currentSlug();
  if (!canBuild({ slug, prompt: text, check: currentCheck(), starting })) return;
  const attachments = staged.slice();
  if (!(await checkVision(attachments))) return;
  starting = true;
  updateBuildButton();
  try {
    const latest = currentCheck() ?? (await runNameCheck(slug));
    if (!latest.ok) {
      if (latest.kind !== "invalid") await showConflict(latest, slug);
      return;
    }
    // First turn — start the session, carrying the BYOK credential so the
    // box can drive the build with the owner's chosen key. YOU decide the
    // name (→ slug/web address) + who can see it; both ride the start.
    const startBody = { prompt: text, attachments, name: slug };
    buildCredential = await freshCredential(buildCredential, client().fqdn);
    if (buildCredential) startBody.credential = buildCredential;
    Object.assign(startBody, wireChoice(modelMenu, modelChoice));
    const visEl = $("vc-visibility");
    if (visEl && (visEl.value === "just-me" || visEl.value === "link")) {
      startBody.visibility = visEl.value;
    }
    let r;
    try {
      r = await boxFetch("/api/screens/vibe-code/start", {
        method: "POST",
        body: JSON.stringify(startBody),
      });
    } catch (e) {
      const taken = conflictFromError(e);
      if (!taken) throw e;
      nameCheck = taken;
      checkedSlug = slug;
      renderNameStatus();
      await showConflict(taken, slug);
      return;
    }
    if (r.needsCredential) {
      // No model can drive this yet — gently route into the AI-key step.
      // Don't surface a sliver op for a build that hasn't actually started.
      toast("Add an AI key to start.", "warn");
      promptEl.value = text; // keep what they typed
      promptEl.disabled = false;
      enterBuildKey({
        contextLabel: "Start from scratch with AI",
        back: "view-vibe-code",
        serverFqdn: client().fqdn,
        onChosen: (credential) => {
          show("view-vibe-code");
          void setBuildCredential(credential).then(send);
        },
      });
      return;
    }
    activeSessionId = r.sessionId;
    // The build is really running now — surface it in the global operations
    // sliver as "building <subject> on <server>" until it deploys or fails.
    buildSubject = subjectFromPrompt(text);
    registerBuildOp();
    // Name + visibility are first-turn-only — fold them away now the session
    // is running (they can't change mid-build).
    setFirstTurnVisible(false);
    clearComposer();
    schedulePoll();
    await poll();
  } catch (e) {
    toast(errorText(e), "err");
    if (typeof e?.code === "string" && e.code.startsWith("free-ai") && e.code !== "free-ai-unavailable") {
      // Free AI can't start this build (used up, busy today, no running
      // server, ended): straight to adding a key.
      buildCredential = null;
      enterBuildKey({
        back: "view-vibe-code",
        serverFqdn: client().fqdn,
        onChosen: (credential) => {
          show("view-vibe-code");
          void setBuildCredential(credential).then(send);
        },
      });
    }
  } finally {
    starting = false;
    const sendBtn = $("vc-send");
    if (activeSessionId) {
      sendBtn.textContent = "Send";
    } else {
      updateBuildButton();
    }
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
    state = await boxFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}`,
    );
  } catch {
    try {
      const snap = await boxFetch(
        `/api/screens/vibe-code/${encodeURIComponent(activeSessionId)}`,
      );
      state = {
        status: snap.status,
        deployPhase: snap.deployPhase,
        messages: (snap.transcript || []).map((t) => ({ role: t.role, text: t.content })),
        files: snap.files,
        deployedUrl: snap.deployedUrl,
        errorReason: snap.errorReason,
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

export const LEFT_OPEN_WARNING =
  "This server couldn't make it invite only, so anyone with the link can open it. You can restrict it from the service's Access settings.";

export function statusLabel(status, deployPhase) {
  switch (status) {
    case "streaming": return "Writing…";
    case "awaiting-tool-response": return "The AI has a question";
    case "ready-to-deploy": return "Ready to deploy";
    case "deploying": return deployPhaseText(deployPhase);
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
      return `<span class="vc-msg-file">${attachmentIcon(a.kind)} ${escapeHtml(a.name || a.kind || "file")}</span>`;
    })
    .join("")}</div>`;
}

/** The muted line under a Flagship Inference reply, else "". */
export function creditsMarkup(m) {
  if (m?.role !== "assistant" || typeof m.credits !== "number" || !Number.isFinite(m.credits)) return "";
  return `<div class="vc-msg-credits">${escapeHtml(creditsUsedText(m.credits))}</div>`;
}

function render(state) {
  $("vc-status").textContent = statusLabel(state.status, state.deployPhase);
  adoptSessionModel(state);

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
    const summarised = state.summarised ? `<div class="vc-summarised">${escapeHtml(SUMMARISED_NOTE)}</div>` : "";
    log.innerHTML = summarised + all
      .map((m) => {
        const side = m.role === "user" ? "vc-msg-user" : "vc-msg-ai";
        const who = m.role === "user" ? "You" : "AI";
        return `
          <div class="vc-msg ${side}">
            <div class="vc-msg-role">${who}</div>
            <div class="vc-msg-text">${escapeHtml(m.text || "")}</div>
            ${attachmentMarkup(m.attachments)}
          </div>${creditsMarkup(m)}`;
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
  const url = state.deployedUrl || (state.status === "deployed" ? deployedUrl : null);
  const failure = state.errorReason || state.failureReason || null;
  if (url) {
    // Task #28 — terminal "Publish this app" action: post the canonical
    // app id to /api/screens/marketplace/publish so the daemon (which holds
    // the IRK + manifest hash) signs the listing request to .com.
    const serviceCanonical = state.serviceCanonical ?? state.canonicalAppName ?? null;
    const publishedSlug = state.marketplaceSlug ?? null;
    resultBox.innerHTML = `
      <div class="card">
        <div class="weight-600">Deployed ✓</div>
        <div class="value text-sm mt-1">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
        </div>
        ${leftOpen ? `<p class="note vc-left-open mt-1">${escapeHtml(LEFT_OPEN_WARNING)}</p>` : ""}
        ${publishedSlug
          ? `<div class="faint-sm mt-2">published as <code>${escapeHtml(publishedSlug)}</code> on the marketplace</div>`
          : `<button id="vc-publish" class="secondary mt-2 full-width" data-canonical="${escapeHtml(serviceCanonical ?? "")}">
              Publish this app
            </button>`}
      </div>`;
    resultBox.classList.remove("hidden");
    $("vc-publish")?.addEventListener("click", () => publishToMarketplace(serviceCanonical));
  } else if (failure) {
    // A relay failure is shown as the box worded it, with the way out.
    const relayAction = isRelayFailure(failure) && buildCredential && !relayTurnedOff
      ? `<button id="vc-relay-off" class="secondary full-width mt-2">${escapeHtml(TURN_RELAY_OFF)}</button>`
      : "";
    resultBox.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(failure)}</p>${relayAction}</div>`;
    resultBox.classList.remove("hidden");
    $("vc-relay-off")?.addEventListener("click", () => void relayOff());
  } else {
    resultBox.classList.add("hidden");
  }
}

// Turn the relay off for this build's key after the box couldn't reach it.
async function relayOff() {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  try {
    if (!(await turnRelayOffForCredential(session.umk, buildCredential))) {
      return toast("That key isn't saved on this device.", "err");
    }
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), "err");
  }
  relayTurnedOff = true;
  $("vc-relay-off")?.remove();
  toast(RELAY_TURNED_OFF, "ok");
}

async function postDeploy(sessionId) {
  const baseUrl = client().baseUrl;
  const tok = client().token();
  const r = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/api/llm/sessions/${encodeURIComponent(sessionId)}/deploy`,
    {
      method: "POST",
      headers: { "x-flagship-session": tok, "content-type": "application/json" },
      body: JSON.stringify(deployRequestBody()),
    },
  );
  const text = await r.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const msg = typeof body?.error === "string" && body.error ? body.error : `deploy failed: ${r.status} ${text}`.trim();
    throw new ScreensError(msg, r.status, body);
  }
  return body;
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
    const r = await boxFetch("/api/screens/marketplace/publish", {
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
  const id = activeSessionId;
  if (!client().baseUrl || !client().token()) return toast("Not paired", "err");
  const btn = $("vc-deploy-go");
  btn.disabled = true;
  btn.textContent = "deploying…";
  schedulePoll();
  try {
    const out = await startAndFollowChatDeploy({
      start: () => postDeploy(id),
      fetchSnapshot: () => boxFetch(`/api/screens/vibe-code/${encodeURIComponent(id)}`),
      onPhase: (phase) => {
        if (activeSessionId === id) $("vc-status").textContent = statusLabel("deploying", phase);
      },
    });
    if (activeSessionId !== id) return;
    if (out.ok) {
      deployedUrl = out.url;
      leftOpen = out.inviteOnly === false;
      toast("Deployed");
    } else {
      toast(out.reason, "err");
    }
    schedulePoll();
    await poll().catch(() => {});
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
  modelMenu = null;
  modelChoice = { model: null, effort: null, thinkHarder: false };
  choiceTouched = false;
  sessionModel = null;
  menuHandle = null;
  menuLoad++;
  const bar = $("vc-model-bar");
  if (bar) {
    bar.innerHTML = "";
    bar.classList.add("hidden");
  }
  showAttachError("");
  buildSubject = null;
  leftOpen = false;
  deployedUrl = null;
  relayTurnedOff = false;
  backTo = null;
  box = boxClient(creationTarget().fqdn);
  starting = false;
  nameCheck = null;
  checkedSlug = "";
  if (nameCheckTimer) clearTimeout(nameCheckTimer);
  nameCheckTimer = null;
  renderChips();
  const promptEl = $("vc-prompt");
  promptEl.disabled = false;
  promptEl.value = "";
  // Restore the first-turn name + visibility settings for a fresh build.
  setFirstTurnVisible(true);
  const nameEl = $("vc-name");
  if (nameEl) nameEl.value = "";
  const visEl = $("vc-visibility");
  if (visEl) visEl.value = INVITE_ONLY;
  renderVisibilityNote();
  $("vc-status").textContent = "idle";
  $("vc-messages").innerHTML =
    '<div class="card placeholder">Say what you\'d like to build to get started.</div>';
  $("vc-files").innerHTML = "";
  $("vc-files-count").textContent = "(none yet)";
  $("vc-deploy-box")?.classList.add("hidden");
  $("vc-result")?.classList.add("hidden");
  renderNameStatus();
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
  $("vc-name")?.addEventListener("input", onNameInput);
  $("vc-prompt")?.addEventListener("input", updateBuildButton);
  $("vc-visibility")?.addEventListener("change", renderVisibilityNote);
  renderExamples();
  $("vc-attach-input")?.addEventListener("change", (e) => {
    void stageFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  });
  $("vibe-code-back")?.addEventListener("click", () => {
    clearPoll();
    if (backTo) void backTo();
    else show("view-build-source");
  });
}

export async function enterVibeCode(opts = {}) {
  // Building a service needs a server to build and run it: the one picked
  // for this new app, defaulting to the leader (docs/app-placement.md §2).
  const fqdn = await mountCreationPicker($("vc-runs-on"), {
    username: getSession()?.username ?? "",
    onChange: onServerChosen,
  });
  // With none paired, nudge the user to add one rather than opening a dead form.
  if (!fqdn) {
    toast("Please add your first server.", "err");
    show("view-home");
    return;
  }
  show("view-vibe-code");
  reset();
  // The AI-key step hands the chosen credential in here; reset() clears it,
  // so apply it after.
  if (opts.credential) void setBuildCredential(opts.credential);
}

// The owner picked another server: names are per server, so check again.
function onServerChosen() {
  if (activeSessionId) return;
  box = boxClient(creationTarget().fqdn);
  nameCheck = null;
  checkedSlug = "";
  onNameInput();
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

/**
 * Reopen a session the box still holds (from the build sessions list), or
 * open one just started to change a service.
 *   back       — called by Back instead of returning to the chooser
 *   credential — the AI key follow-up replies carry
 *   server     — the box holding it (default: the current server)
 */
export async function openVibeCodeSession(sessionId, { back = null, credential = null, server = "" } = {}) {
  if (activeSessionId === sessionId) {
    backTo = back;
    return resumeVibeCode();
  }
  show("view-vibe-code");
  reset();
  backTo = back;
  // A reopened session lives on the box that listed it (the current server
  // unless named).
  box = boxClient(server);
  activeSessionId = sessionId;
  if (credential) void setBuildCredential(credential);
  setFirstTurnVisible(false);
  const sendBtn = $("vc-send");
  if (sendBtn) sendBtn.textContent = "Send";
  await poll().catch(() => {});
}
