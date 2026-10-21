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
//      When it asks for an env var instead, a card above the result takes the
//      value: signed POST /api/screens/services/<appId>/env/set (the only path
//      that carries it), then /reply { envVarStatus }. An edit session runs on
//      an app that is already live, so that card comes before the live link.
//   4. When status becomes ready-to-deploy, surface Deploy →
//      /api/llm/sessions/<id>/deploy {background:true}. The box tests the app
//      on a private copy, then installs it; the session's deployPhase says
//      which (lib/chatDeploy.js).
//   5. A chat that is ready to deploy or failed (`canContinue`) takes a new
//      message on the same /reply endpoint: the AI changes the files and the
//      owner deploys again. A key the box no longer holds (a deploy forgets it
//      before going live) rides that message (`needsCredential`). A deployed
//      app is changed from its page instead (edit-service.js).
//
// Attachments are inlined as base64 or text (no upload endpoint): images,
// text/code, CSV/JSON sample data and PDFs. The client mirrors the server
// caps so a violation is a friendly inline error, not a 400. The chat is NOT
// a secret channel, and the AI sees what's attached; the composer says so.
//
// The header's model menu (lib/modelGroups.js) lists Flagship Inference and
// every saved key, each with its models, and an effort when the model offers
// effort levels; model and effort ride start and every reply. Picking a model
// under another key switches the chat to that provider: its key rides the
// next message. A chat starts on the default model saved in Settings.

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, boxClient, currentPodFqdn } from "../lib/api.js";
import { creationTarget, loadAccountPods, mountCreationPicker, sessionServers } from "../lib/appPlacement.js";
import { findSessionServer } from "../lib/vibeSessions.js";
import { hiddenMessagesText, isAtBottom, transcriptWindow } from "../lib/vibeTranscript.js";
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
import { signWithIrk } from "../keystore.js";
import { signedEnvChangeBody } from "../lib/serviceEnvChange.js";
import { fetchFreeAiStatus, freeAiEntryView, freshCredential, mintFreeAiCredential } from "../lib/freeAi.js";
import { credentialFor, defaultModelFor, loadProviders } from "../providers.js";
import {
  MAX_ATTACHMENTS,
  attachNotice,
  attachmentIcon,
  classifyFile,
  creditsUsedText,
  dataTextError,
  fetchInferenceCatalog,
  initialChoice,
  loadModelMenu,
  visionCheck,
  wireChoice,
  withModel,
} from "../lib/modelMenu.js";
import {
  buildGroups,
  contextNotice,
  credentialForMessage,
  groupById,
  groupForCredential,
  groupForProvider,
  mountGroupedModelMenu,
} from "../lib/modelGroups.js";

import { tr } from "../lib/i18n.js";
registerView("view-vibe-code");

const POLL_INTERVAL_MS = 800;
const TERMINAL_STATUSES = new Set(["deployed", "failed", "cancelled"]);

export const SUMMARISED_NOTE = tr("Earlier conversation summarised");
const FIRST_TURN_PLACEHOLDER = tr("A simple habit tracker — checkboxes per day, last 30 days visible.");

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
// The env var the AI is waiting on (requestEnvVar), and the app it goes to.
let pendingEnvVar = null;
let pendingAppId = null;
// What #vc-result last showed: the poll re-renders often, and rebuilding the
// card would wipe a value the owner is typing.
let lastResultHtml = "";
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
// The model menu, grouped by provider (lib/modelGroups.js): Flagship
// Inference, then each saved key. The owner's choice in it ({ group, model,
// effort }), whether they changed it here (else a reopened session shows what
// it uses), and the group whose key the box holds now: picking a model in
// another group sends that group's key with the next message.
let groups = [];
let modelChoice = { group: null, model: null, effort: null };
let choiceTouched = false;
let sessionModel = null;
let boxGroupId = null;
let menuHandle = null;
let menuSignature = "";
let menuLoad = 0;
// The session's latest public state (needsCredential, canContinue, size).
let lastState = null;
// Whether the transcript follows the newest message: true until the owner
// scrolls up, so a poll never drags them back down while they read.
let followTail = true;
let followSession = null;

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
  if (!t) return tr("new service");
  const words = t.split(" ").slice(0, 4).join(" ");
  return words.length > 32 ? `${words.slice(0, 31)}…` : words;
}

/** Register / refresh this session's build op in the sliver. */
function registerBuildOp() {
  if (!activeSessionId) return;
  activeOperations.upsertBuild(
    activeSessionId,
    buildSubject || tr("new service"),
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
      errors.push(tr("Up to {0} files per message.", MAX_ATTACHMENTS));
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
      errors.push(tr("Couldn't attach \"{0}\".", file.name));
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
          <button class="vc-chip-x" data-idx="${i}" aria-label="${tr("Remove {0}", label)}">×</button>
        </span>`;
    })
    .join("");
  box.querySelectorAll(".vc-chip-x").forEach((btn) => {
    btn.addEventListener("click", () => removeStaged(Number(btn.dataset.idx)));
  });
}

// ---- send / poll ---------------------------------------------------------

/**
 * What the composer offers for a session's state: whether it takes a message
 * and the hint in it. The AI's question is answered; a chat that is ready to
 * deploy or failed takes a new message (`canContinue`).
 */
export function composerMode(state) {
  if (state?.pendingRequest?.kind === "talkToUser") return { enabled: true, placeholder: tr("Reply to the AI…") };
  if (state?.canContinue === true) {
    return {
      enabled: true,
      placeholder: state.status === "failed" ? tr("Tell the AI what to try next…") : tr("Ask for a change…"),
    };
  }
  return { enabled: false, placeholder: "" };
}

/** The credential this message carries, or null to keep the box's key. */
async function messageCredential({ starting = false } = {}) {
  const group = groupById(groups, modelChoice.group);
  if (!group) return freshCredential(buildCredential, client().fqdn);
  return credentialForMessage(group, {
    starting,
    picked: group.id !== boxGroupId,
    needsCredential: lastState?.needsCredential === true,
    mintFlagship: async () => (await mintFreeAiCredential(client().fqdn)).credential,
  });
}

/** The current group's menu (for the wire choice and the vision check). */
function currentMenu() {
  return groupById(groups, modelChoice.group)?.menu ?? null;
}

async function send() {
  const promptEl = $("vc-prompt");
  const text = promptEl.value.trim();
  if (!activeSessionId) return startBuild(text);
  if (!text && staged.length === 0) return toast(tr("Type a message first."), "err");
  if (!composerMode(lastState).enabled) {
    toast(tr("Wait for the AI to finish this turn."), "info");
    return;
  }
  const attachments = staged.slice();
  if (!(await checkVision(attachments))) return;
  const sendBtn = $("vc-send");
  sendBtn.disabled = true;
  sendBtn.textContent = tr("Sending…");
  try {
    if (pendingEnvVar) {
      toast(tr("Answer the request for {0} above first.", pendingEnvVar), "info");
      return;
    }
    // An answer to the AI's question, or a new message on a chat that is
    // ready to deploy or failed: the same endpoint. A model from another
    // provider brings that provider's key; a Flagship pass is always fresh.
    const replyBody = { text, attachments };
    const credential = await messageCredential();
    if (!credential && lastState?.needsCredential) {
      askForKey();
      return;
    }
    if (credential) {
      replyBody.credential = credential;
      buildCredential = credential;
    }
    Object.assign(replyBody, wireChoice(currentMenu(), modelChoice, { reply: true }));
    await boxFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}/reply`,
      { method: "POST", body: JSON.stringify(replyBody) },
    );
    if (credential) boxGroupId = modelChoice.group;
    pendingTalkToolId = null;
    registerBuildOp();
    clearComposer();
    schedulePoll();
    await poll();
  } catch (e) {
    toast(errorText(e), "err");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = tr("Send");
  }
}

/** What a failed send shows: the box's or free AI's own words, else the raw error. */
export function errorText(e) {
  if (e instanceof ScreensError) return e.message;
  if (e?.rateLimited) return e.message;
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

/** No key can drive this chat: add or pick one, then send again. */
function askForKey() {
  toast(tr("Add an AI key to carry on."), "warn");
  enterBuildKey({
    back: "view-vibe-code",
    serverFqdn: client().fqdn,
    onChosen: (credential) => {
      show("view-vibe-code");
      void setBuildCredential(credential).then(send);
    },
  });
}

/** Use `credential` for this build: its group is chosen in the menu. */
function setBuildCredential(credential) {
  buildCredential = credential;
  choiceTouched = false;
  return refreshModelMenu();
}

/** A group's models: Flagship Inference's catalog, or the key's list from the box. */
function loadGroupMenu(group) {
  if (group.kind === "flagship") return fetchInferenceCatalog().then((catalog) => ({ kind: "flagship", catalog }));
  return loadModelMenu(credentialFor(group.entry), boxFetch);
}

const groupCredential = (group) => (group.kind === "flagship" ? { provider: "flagship" } : credentialFor(group.entry));

/** Build the grouped menu: Flagship Inference (when usable or in use), then each saved key. */
async function refreshModelMenu() {
  const load = ++menuLoad;
  const session = getSession();
  let list = { entries: [] };
  if (session?.umk) {
    try {
      list = await loadProviders(session.umk);
    } catch {
      list = { entries: [] };
    }
  }
  const [catalog, status] = await Promise.all([
    fetchInferenceCatalog(),
    session?.umk ? fetchFreeAiStatus() : Promise.resolve(null),
  ]);
  if (load !== menuLoad) return;
  const currentProvider = buildCredential?.provider ?? lastState?.provider ?? null;
  groups = buildGroups({
    entries: list.entries,
    flagshipUsable: freeAiEntryView(status).usable,
    flagshipMenu: { kind: "flagship", catalog },
    currentProvider,
    unsaved: buildCredential,
  });
  const group =
    groupForCredential(groups, buildCredential) ??
    groupForProvider(groups, lastState?.provider) ??
    (activeSessionId ? null : groups[0] ?? null);
  if (buildCredential && group) boxGroupId = activeSessionId ? group.id : null;
  else if (lastState?.provider && group) boxGroupId = group.id;
  await chooseGroup(group, sessionModel ?? defaultModelFor(list, group ? groupCredential(group) : null), load);
}

/** Select `group` with its saved (or the session's) model. */
async function chooseGroup(group, wanted, load = menuLoad) {
  if (group && !group.menu) group.menu = await loadGroupMenu(group);
  if (load !== menuLoad) return;
  modelChoice = group ? { group: group.id, ...initialChoice(group.menu, wanted ?? {}) } : { group: null, model: null, effort: null };
  renderModelBar();
}

function renderModelBar() {
  const bar = $("vc-model-bar");
  if (!bar) return;
  const empty = groups.length === 0;
  bar.classList.toggle("hidden", empty);
  if (empty) return;
  const notice = activeSessionId
    ? contextNotice({
        menu: currentMenu(),
        choice: modelChoice,
        sessionModel: lastState?.model ?? null,
        conversationTokens: lastState?.conversationTokens,
      })
    : null;
  // Polls re-render the chat often; the menu only when something it shows
  // changed (an open panel or a model being typed stays as it is).
  const signature = JSON.stringify([modelChoice, notice, groups.map((g) => [g.id, !!g.menu])]);
  if (menuHandle && bar.firstElementChild) {
    if (signature === menuSignature) return;
    menuSignature = signature;
    menuHandle.update(groups, modelChoice, notice);
    return;
  }
  menuSignature = signature;
  menuHandle = mountGroupedModelMenu(bar, {
    groups,
    choice: modelChoice,
    notice,
    loadGroup: loadGroupMenu,
    onChange: (next) => {
      modelChoice = next;
      choiceTouched = true;
      renderModelBar();
    },
  });
}

/** The session says which provider and model it uses: show that until the owner picks. */
function adoptSessionModel(state) {
  const providerChanged = state?.provider && state.provider !== lastState?.provider;
  lastState = state;
  if (state?.model) sessionModel = { model: state.model, effort: state.effort };
  if (choiceTouched) return renderModelBar();
  if (providerChanged && !buildCredential) {
    // A reopened chat: rebuild the menu around the provider it uses.
    void refreshModelMenu();
    return;
  }
  const group = groupById(groups, modelChoice.group);
  if (!group?.menu || !state?.model || state.model === modelChoice.model) return renderModelBar();
  modelChoice = { group: group.id, ...initialChoice(group.menu, sessionModel) };
  renderModelBar();
}

/**
 * Images for a model that can't see them: offer the switch (or say so).
 * Resolves whether to send.
 */
async function checkVision(attachments) {
  const check = visionCheck(currentMenu(), modelChoice, attachments);
  if (check.kind === "ok") return true;
  if (check.kind === "blocked") {
    await inlineAlert({ message: check.message, okLabel: tr("OK") });
    return false;
  }
  const ok = await inlineConfirm({ message: check.message, okLabel: tr("Switch"), cancelLabel: tr("Cancel") });
  if (!ok) return false;
  modelChoice = { group: modelChoice.group, ...withModel(currentMenu(), modelChoice, check.to) };
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
    addr.innerHTML = `${tr("https://<strong class=\"vc-address-name\">{0}</strong>.{1}", escapeHtml(slug || "<name>"), escapeHtml(serverFqdn()))}`;
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
      status.textContent = tr("✓ Available");
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
  btn.textContent = starting ? tr("Starting…") : tr("Build it");
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
      okLabel: tr("Open build sessions"),
      cancelLabel: tr("Pick another name"),
    });
    // The list's Back returns to the chooser, not this half-filled form.
    if (open) void enterBuildJournal();
  } else {
    await inlineAlert({ title: CONFLICT_TITLE, message: conflictMessage(check, name), okLabel: tr("Pick another name") });
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
    const credential = await messageCredential({ starting: true });
    if (credential) {
      buildCredential = credential;
      startBody.credential = credential;
    }
    Object.assign(startBody, wireChoice(currentMenu(), modelChoice));
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
      toast(tr("Add an AI key to start."), "warn");
      promptEl.value = text; // keep what they typed
      promptEl.disabled = false;
      enterBuildKey({
        contextLabel: tr("Start from scratch with AI"),
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
    if (credential) boxGroupId = modelChoice.group;
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
      sendBtn.textContent = tr("Send");
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
  tr("This server couldn't make it invite only, so anyone with the link can open it. You can restrict it from the service's Access settings.");

export function statusLabel(status, deployPhase) {
  switch (status) {
    case "streaming": return tr("Writing…");
    case "awaiting-tool-response": return tr("The AI has a question");
    case "ready-to-deploy": return tr("Ready to deploy");
    case "deploying": return deployPhaseText(deployPhase);
    case "deployed": return tr("Deployed");
    case "failed": return tr("Something went wrong");
    case "cancelled": return tr("Cancelled");
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
  if (followSession !== activeSessionId) {
    followSession = activeSessionId;
    followTail = true;
  }
  if (all.length === 0) {
    log.innerHTML = `<div class="card placeholder">${tr("Say what you'd like to build to get started.")}</div>`;
  } else {
    const summarised = state.summarised ? `<div class="vc-summarised">${escapeHtml(SUMMARISED_NOTE)}</div>` : "";
    const { hidden, messages: shown } = transcriptWindow(all);
    const older = hidden > 0 ? `<div class="vc-summarised" data-vc-hidden>${escapeHtml(hiddenMessagesText(hidden))}</div>` : "";
    const keepTop = log.scrollTop;
    log.innerHTML = summarised + older + shown
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
    log.scrollTop = followTail ? log.scrollHeight : keepTop;
  }
  paintJumpToLatest();

  // The composer takes a message when the AI asked a question, or when the
  // chat is ready to deploy or failed (the owner carries on from there).
  // While the AI is writing or deploying, and once deployed or stopped, it
  // is disabled to make the turn-taking obvious.
  const mode = composerMode(state);
  $("vc-send").disabled = !mode.enabled;
  const promptEl = $("vc-prompt");
  promptEl.disabled = !mode.enabled;
  promptEl.placeholder = mode.placeholder;

  // Files tree.
  const files = state.files || {};
  const paths = Object.keys(files).sort();
  $("vc-files-count").textContent = paths.length === 0 ? tr("(none yet)") : `(${paths.length})`;
  const filesRoot = $("vc-files");
  if (paths.length === 0) {
    filesRoot.innerHTML = `<div class="card placeholder">${tr("files appear here as the AI emits them…")}</div>`;
  } else {
    filesRoot.innerHTML = paths
      .map(
        (p) => `
      <div class="card card-compact">
        <details>
          <summary class="file-summary">${escapeHtml(p)} <span class="file-summary-meta">${tr("({0} chars)", files[p].length)}</span></summary>
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
  pendingEnvVar = state.pendingRequest?.kind === "requestEnvVar" ? state.pendingRequest.payload?.name ?? null : null;
  pendingAppId = state.appId ?? null;
  const html = resultMarkup(state.pendingRequest, {
    url,
    leftOpen,
    failure,
    relayOff: Boolean(failure && isRelayFailure(failure) && buildCredential && !relayTurnedOff),
  });
  resultBox.classList.toggle("hidden", !html);
  if (html === lastResultHtml) return;
  lastResultHtml = html;
  resultBox.innerHTML = html;
  $("vc-relay-off")?.addEventListener("click", () => void relayOff());
  $("vc-envvar-send")?.addEventListener("click", () => void sendEnvVar());
  $("vc-envvar-decline")?.addEventListener("click", () => void answerEnvVar("declined"));
}

/**
 * What #vc-result shows. What the AI is waiting on comes first: an edit
 * session runs on an app that is already live, and the owner must still be
 * able to answer it; the live link (or the failure) follows.
 */
export function resultMarkup(pending, { url = null, leftOpen: open = false, failure = null, relayOff = false } = {}) {
  let html = envVarRequestMarkup(pending);
  if (url) {
    html += deployedMarkup(url, open);
  } else if (failure) {
    // A relay failure is shown as the box worded it, with the way out.
    const action = relayOff
      ? `<button id="vc-relay-off" class="secondary full-width mt-2">${escapeHtml(TURN_RELAY_OFF)}</button>`
      : "";
    html += `<div class="card"><p class="err-text">${escapeHtml(failure)}</p>${action}</div>`;
  }
  return html;
}

/** The card for an env var the AI asked for, else "". */
export function envVarRequestMarkup(pending) {
  if (pending?.kind !== "requestEnvVar" || !pending.payload?.name) return "";
  const p = pending.payload;
  return `
      <div class="card vc-envvar" id="vc-envvar">
        <div class="weight-600">${tr("The app needs <code>{0}</code>", escapeHtml(p.name))}</div>
        ${p.description ? `<p class="value text-sm mt-1">${escapeHtml(p.description)}</p>` : ""}
        ${p.why ? `<p class="note">${tr("Why: {0}", escapeHtml(p.why))}</p>` : ""}
        ${p.example ? `<p class="note">${tr("Example: <code>{0}</code>", escapeHtml(p.example))}</p>` : ""}
        <input id="vc-envvar-value" type="password" placeholder="${tr("Paste the value")}" aria-label="${tr("Value for {0}", escapeHtml(p.name))}"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <p class="note mt-1">${tr("Sent once to your server. Not saved in this browser.")}</p>
        <button id="vc-envvar-send" class="full-width mt-2">${tr("Send value")}</button>
        <button id="vc-envvar-decline" class="secondary full-width mt-2">${tr("Decline")}</button>
      </div>`;
}

/** The live link a deploy answered with. */
export function deployedMarkup(url, open) {
  return `
      <div class="card">
        <div class="weight-600">${tr("Deployed ✓")}</div>
        <div class="value text-sm mt-1">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
        </div>
        ${open ? `<p class="note vc-left-open mt-1">${escapeHtml(LEFT_OPEN_WARNING)}</p>` : ""}
      </div>`;
}

// The value goes to the box's env store under the owner's signature (the
// only path that carries it); the AI is told only that it was set.
async function sendEnvVar() {
  const name = pendingEnvVar;
  const el = $("vc-envvar-value");
  const value = el?.value ?? "";
  if (!name || !activeSessionId) return;
  if (!value) return toast(tr("Paste a value first."), "err");
  const appId = pendingAppId ?? "";
  // appId = "<creator>--<slug>": neither half may contain "--".
  const parts = appId.split("--");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return toast(tr("This build has no app to set it on yet."), "err");
  const session = getSession();
  if (!session?.umk) return toast(tr("Unlock first"), "err");
  const btn = $("vc-envvar-send");
  if (btn) btn.disabled = true;
  try {
    const body = await signedEnvChangeBody(
      { serverId: client().fqdn, serviceId: appId, op: "set", name, value },
      (bytes) => signWithIrk(session.umk, bytes),
    );
    await boxFetch(`/api/screens/services/${encodeURIComponent(appId)}/env/set`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (el) el.value = "";
    await answerEnvVar("set");
  } catch (e) {
    toast(errorText(e), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function answerEnvVar(status) {
  if (!activeSessionId) return;
  try {
    // The ack resumes the AI, so it carries what any message does: the key
    // for the chosen model (a fresh Flagship pass; an own key when it changes
    // or the box has none) and the model choice. A chat opened from a
    // notification holds no key itself: the menu follows the box's provider.
    const body = { envVarStatus: status };
    const credential = await messageCredential();
    if (credential) {
      body.credential = credential;
      buildCredential = credential;
    }
    Object.assign(body, wireChoice(currentMenu(), modelChoice, { reply: true }));
    await boxFetch(`/api/screens/llm/sessions/${encodeURIComponent(activeSessionId)}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (credential) boxGroupId = modelChoice.group;
    pendingEnvVar = null;
    toast(status === "set" ? tr("Sent") : tr("Declined"), "ok");
    schedulePoll();
    await poll();
  } catch (e) {
    toast(errorText(e), "err");
  }
}

// Turn the relay off for this build's key after the box couldn't reach it.
async function relayOff() {
  const session = getSession();
  if (!session.umk) return toast(tr("Unlock first"), "err");
  try {
    if (!(await turnRelayOffForCredential(session.umk, buildCredential))) {
      return toast(tr("That key isn't saved on this device."), "err");
    }
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), "err");
  }
  relayTurnedOff = true;
  // The next message carries the key again, so the box stores the new setting.
  const group = groupForCredential(groups, { ...buildCredential, relay: true });
  if (group?.entry) group.entry.relay = false;
  boxGroupId = null;
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

async function triggerDeploy() {
  if (!activeSessionId) return;
  const id = activeSessionId;
  if (!client().baseUrl || !client().token()) return toast(tr("Not paired"), "err");
  const btn = $("vc-deploy-go");
  btn.disabled = true;
  btn.textContent = tr("deploying…");
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
      toast(tr("Deployed"));
    } else {
      toast(out.reason, "err");
    }
    schedulePoll();
    await poll().catch(() => {});
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.textContent = tr("Deploy");
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
  pendingEnvVar = null;
  pendingAppId = null;
  lastResultHtml = "";
  buildCredential = null;
  groups = [];
  modelChoice = { group: null, model: null, effort: null };
  choiceTouched = false;
  sessionModel = null;
  boxGroupId = null;
  lastState = null;
  menuHandle = null;
  menuSignature = "";
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
  promptEl.placeholder = FIRST_TURN_PLACEHOLDER;
  // Restore the first-turn name + visibility settings for a fresh build.
  setFirstTurnVisible(true);
  const nameEl = $("vc-name");
  if (nameEl) nameEl.value = "";
  const visEl = $("vc-visibility");
  if (visEl) visEl.value = INVITE_ONLY;
  renderVisibilityNote();
  $("vc-status").textContent = "idle";
  $("vc-messages").innerHTML =
    `<div class="card placeholder">${tr("Say what you'd like to build to get started.")}</div>`;
  $("vc-files").innerHTML = "";
  $("vc-files-count").textContent = tr("(none yet)");
  $("vc-deploy-box")?.classList.add("hidden");
  $("vc-result")?.classList.add("hidden");
  renderNameStatus();
  const deployBtn = $("vc-deploy-go");
  if (deployBtn) {
    deployBtn.disabled = false;
    deployBtn.textContent = tr("Deploy");
  }
}

/** "Jump to latest" shows while the owner has scrolled up from the newest message. */
function paintJumpToLatest() {
  const btn = $("vc-jump-latest");
  if (btn) btn.classList.toggle("hidden", followTail);
}

export function initVibeCodeView() {
  $("vc-messages")?.addEventListener("scroll", (e) => {
    const atBottom = isAtBottom(e.currentTarget);
    if (atBottom === followTail) return;
    followTail = atBottom;
    paintJumpToLatest();
  });
  $("vc-jump-latest")?.addEventListener("click", () => {
    const log = $("vc-messages");
    followTail = true;
    if (log) log.scrollTop = log.scrollHeight;
    paintJumpToLatest();
  });
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
    toast(tr("Please add your first server."), "err");
    show("view-home");
    return;
  }
  show("view-vibe-code");
  reset();
  // The AI-key step hands the chosen credential in here; reset() clears it,
  // so apply it after. Without one the menu starts on its first group.
  if (opts.credential) void setBuildCredential(opts.credential);
  else void refreshModelMenu();
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
  // Without a key handed in, the menu follows the provider the box reports.
  if (credential) void setBuildCredential(credential);
  else void refreshModelMenu();
  setFirstTurnVisible(false);
  const sendBtn = $("vc-send");
  if (sendBtn) sendBtn.textContent = tr("Send");
  await poll().catch(() => {});
}

export const SESSION_NOT_FOUND = tr("That build isn't open on any of your servers any more.");

/**
 * Open a session named only by its id (an AI-needs-you notification, the
 * operations sliver): on `server` when that box holds it, else the current
 * server, else whichever of this device's servers does. Every call, and the
 * serverId an env value is signed for, then names that box.
 */
export async function openVibeCodeSessionById(sessionId, { server = "" } = {}) {
  const fqdn = await findSessionServer(sessionId, {
    first: [server, currentPodFqdn()],
    more: async () => sessionServers(await loadAccountPods(getSession()?.username ?? "")).map((s) => s.fqdn),
    probe: async (candidate) => {
      const c = boxClient(candidate);
      if (!c.hasSession()) return false;
      await c.fetch(`/api/screens/llm/sessions/${encodeURIComponent(sessionId)}`);
      return true;
    },
  });
  if (!fqdn) {
    toast(SESSION_NOT_FOUND, "err");
    return enterBuildJournal();
  }
  return openVibeCodeSession(sessionId, { server: fqdn });
}
