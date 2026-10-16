// Git build mode (webapp). Paste a repo URL and, optionally, the name it
// goes live under. The box clones it and reports whether it's Flagship-ready:
//   - FIT     → install as-is (Deploy), no AI.
//   - NOT FIT → offer the AI adapt, which runs in the background on the box
//               while this view follows it.
// Every step is recorded in the build journal.

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, boxReason, boxClient } from "../lib/api.js";
import { creationTarget, mountCreationPicker } from "../lib/appPlacement.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { checkName, nameWarning, slugify } from "../lib/vibeNames.js";
import {
  ADAPTING_NOTE,
  ADAPT_BUTTON,
  CHECK_AGAIN,
  CLOSED_NOTE,
  DEPLOY_BUTTON,
  NOT_LIVE,
  NOT_LIVE_FALLBACK,
  RETRY_ADAPT,
  EXPORT_BUTTON,
  EXPORT_NOTE,
  EXPORT_PREPARING,
  SHARE_LABEL,
  SHARE_NOTE,
  adaptRequestBody,
  adaptingText,
  addressLabel,
  blankNameHint,
  checkRepoFailure,
  deployFailure,
  exportAdapter,
  followAdapt,
  gitRequestBody,
  notReadyText,
  startAndFollowAdapt,
} from "../lib/gitImport.js";
import { enterVibeCode, showConflict } from "./vibe-code.js";
import { enterBuildJournal } from "./build-journal.js";
import { enterBuildKey } from "./build-key.js";
import { freshCredential } from "../lib/freeAi.js";
import { getSession } from "../lib/state.js";
import { turnRelayOffForCredential } from "../providers.js";
import { RELAY_TURNED_OFF, TURN_RELAY_OFF, isRelayFailure } from "../lib/aiRelay.js";

registerView("view-build-git");

let buildId = null;
// The in-memory BYOK credential for the adapt pass, set from the AI-key step.
let adaptCredential = null;
// The not-fit verdict, restored when an adapt fails so it can be retried.
let lastVerdict = null;
// The name the box will install it under, once the repo is checked.
let assignedName = null;
// The box's latest answer for the name field, and the slug it answered for.
let nameCheck = null;
let checkedSlug = "";
let nameCheckTimer = null;
let checking = false;
// The not-ready card's share switch; a new check turns it back on.
let share = true;
// A Flagship-ready or not-ready card is up; it takes Check repo's place.
let verdictShown = false;
// The box handed this build over to go live: no more AI runs on it.
let closed = false;
// The adapt's running phase and latest journal line, for the progress card.
let adaptPhase = null;
let adaptProgress = null;
// The box this import runs on (docs/app-placement.md §2); every call goes there.
let box = null;

const client = () => box ?? boxClient();
const boxFetch = (path, init) => client().fetch(path, init);

export function initBuildGitView() {
  $("build-git-check").addEventListener("click", checkRepo);
  $("build-git-back").addEventListener("click", () => show("view-build-source"));
  $("build-git-name").addEventListener("input", onNameInput);
  $("build-git-ref").addEventListener("input", renderNameStatus);
}

export function enterBuildGit() {
  buildId = null;
  adaptCredential = null;
  lastVerdict = null;
  assignedName = null;
  nameCheck = null;
  checkedSlug = "";
  share = true;
  verdictShown = false;
  closed = false;
  if (nameCheckTimer) clearTimeout(nameCheckTimer);
  nameCheckTimer = null;
  $("build-git-url").value = "";
  $("build-git-ref").value = "";
  $("build-git-name").value = "";
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  box = boxClient(creationTarget().fqdn);
  renderNameStatus();
  show("view-build-git");
  return mountCreationPicker($("build-git-runs-on"), {
    username: getSession()?.username ?? "",
    onChange: onServerChosen,
  }).then(() => {
    if (!buildId && !checking) onServerChosen();
  });
}

/**
 * Reopen a git build the box brought back failed (Build sessions → Open): say
 * the box's reason and offer what the card offers, running the AI again
 * (unless the build is sealed) or installing the files it holds.
 */
export async function resumeBuildGit({ buildId: id, server = "", state, fileCount = 0, reason, canAdapt = true }) {
  await enterBuildGit();
  // It stays on the server that holds it: no server picker.
  const picker = $("build-git-runs-on");
  if (picker) picker.innerHTML = "";
  box = boxClient(server || creationTarget().fqdn);
  buildId = id;
  assignedName = state?.name ?? null;
  closed = state?.sealed === true;
  lastVerdict = { buildId: id, fit: false, reason, fileCount, name: assignedName };
  // No AI for a sealed build, or on a box with no model to adapt with.
  const offerAi = canAdapt && !closed;
  const card = $("build-git-verdict");
  card.classList.remove("hidden");
  card.innerHTML = `
    <div class="card" data-build-failed>
      <p class="err-text">${escapeHtml(reason)}</p>
      ${offerAi ? `<button id="build-git-adapt" class="full-width mt-2">${escapeHtml(ADAPT_BUTTON)}</button>` : ""}
      <button id="build-git-deploy" class="${offerAi ? "secondary " : ""}full-width mt-2">${escapeHtml(DEPLOY_BUTTON)}</button>
      ${journalLink()}
    </div>`;
  $("build-git-adapt")?.addEventListener("click", () =>
    enterBuildKey({
      contextLabel: "Building with AI",
      back: "view-build-git",
      onChosen: (credential) => {
        adaptCredential = credential;
        show("view-build-git");
        void adapt();
      },
    }),
  );
  $("build-git-deploy").addEventListener("click", deploy);
  wireJournalLink();
}

// Another server: a repo checked on the old one doesn't carry over, and names
// are per server.
function onServerChosen() {
  box = boxClient(creationTarget().fqdn);
  buildId = null;
  lastVerdict = null;
  assignedName = null;
  verdictShown = false;
  nameCheck = null;
  checkedSlug = "";
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  onNameInput();
}

function currentSlug() {
  return slugify($("build-git-name")?.value);
}

function currentCheck() {
  return checkedSlug === currentSlug() ? nameCheck : null;
}

function serverFqdn() {
  return client().fqdn;
}

function renderNameStatus() {
  const slug = currentSlug();
  const addr = $("build-git-address");
  if (addr) {
    addr.innerHTML = `https://<strong class="vc-address-name">${escapeHtml(addressLabel(slug, assignedName))}</strong>.${escapeHtml(serverFqdn())}`;
  }
  const status = $("build-git-name-status");
  if (status) {
    const check = currentCheck();
    const warning = nameWarning(check, slug);
    status.classList.remove("is-taken", "is-free", "is-hint", "hidden");
    if (warning) {
      status.textContent = `⚠ ${warning}`;
      status.classList.add("is-taken");
    } else if (check?.ok && check.name) {
      status.textContent = "✓ Available";
      status.classList.add("is-free");
    } else if (!slug) {
      status.textContent = blankNameHint($("build-git-ref")?.value);
      status.classList.add("is-hint");
    } else {
      status.textContent = "";
      status.classList.add("hidden");
    }
  }
  updateCheckButton();
}

function updateCheckButton() {
  const btn = $("build-git-check");
  if (!btn) return;
  btn.textContent = checking ? "cloning…" : "Check repo";
  btn.disabled = checking || currentCheck()?.ok === false;
  btn.classList.toggle("hidden", verdictShown);
}

async function runNameCheck(slug) {
  const result = await checkName({ baseUrl: client().baseUrl, token: client().token(), name: slug });
  if (slug === currentSlug()) {
    nameCheck = result;
    checkedSlug = slug;
    renderNameStatus();
  }
}

function onNameInput() {
  if (nameCheckTimer) clearTimeout(nameCheckTimer);
  renderNameStatus();
  const slug = currentSlug();
  if (!slug) return;
  nameCheckTimer = setTimeout(() => void runNameCheck(slug), 350);
}

async function checkRepo() {
  const body = gitRequestBody({
    gitUrl: $("build-git-url").value,
    ref: $("build-git-ref").value,
    name: $("build-git-name").value,
  });
  if (!body.gitUrl) return toast("Paste a repo URL first", "err");
  buildId = null;
  lastVerdict = null;
  assignedName = null;
  share = true;
  verdictShown = false;
  closed = false;
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  checking = true;
  renderNameStatus();
  try {
    const r = await boxFetch("/api/build/git", { method: "POST", body: JSON.stringify(body) });
    buildId = r.buildId;
    assignedName = r.name ?? body.name ?? null;
    renderVerdict(r);
  } catch (e) {
    const failure = checkRepoFailure(e);
    if (failure.conflict) {
      nameCheck = failure.conflict;
      checkedSlug = body.name ?? "";
      checking = false;
      renderNameStatus();
      await showConflict(failure.conflict, body.name ?? "");
    } else {
      // A 404 here means the box has no service/build platform wired.
      toast(failure.message, "err");
    }
  } finally {
    checking = false;
    renderNameStatus();
  }
}

function journalLink() {
  return `<p class="note mt-2"><a id="build-git-journal" href="#">View build journal →</a></p>`;
}

function wireJournalLink() {
  const j = $("build-git-journal");
  if (j) j.addEventListener("click", (e) => { e.preventDefault(); enterBuildJournal(buildId, { server: client().fqdn }); });
}

function checkAgainButton() {
  return `<button id="build-git-recheck" class="secondary build-git-recheck" aria-label="${escapeHtml(CHECK_AGAIN)}" title="${escapeHtml(CHECK_AGAIN)}">↻</button>`;
}

function renderVerdict(r, error = null) {
  const box = $("build-git-verdict");
  box.classList.remove("hidden");
  verdictShown = true;
  updateCheckButton();
  if (r.fit) {
    box.innerHTML = `
      <div class="card">
        <div class="build-git-verdict-head"><p><strong>Flagship-ready ✓</strong></p>${checkAgainButton()}</div>
        <p class="note">${escapeHtml(r.reason)} — ${r.fileCount} file(s).</p>
        <button id="build-git-deploy" class="full-width mt-2">${escapeHtml(DEPLOY_BUTTON)}</button>
        ${journalLink()}
      </div>`;
    $("build-git-deploy").addEventListener("click", deploy);
  } else {
    lastVerdict = r;
    const relayAction = error && isRelayFailure(error) && adaptCredential
      ? `<button id="build-git-relay-off" class="secondary full-width mt-2">${escapeHtml(TURN_RELAY_OFF)}</button>`
      : "";
    // A build handed over to go live takes no more AI: Check again starts a
    // new one.
    const aiControls = closed
      ? `<p class="note mt-2">${escapeHtml(CLOSED_NOTE)}</p>
        <button id="build-git-recheck-full" class="full-width mt-2">${escapeHtml(CHECK_AGAIN)}</button>`
      : `<button id="build-git-adapt" class="full-width mt-2">${escapeHtml(ADAPT_BUTTON)}</button>
        <label class="inline-check mt-3">
          <input type="checkbox" id="build-git-share" role="switch"${share ? " checked" : ""} /> ${escapeHtml(SHARE_LABEL)}
        </label>
        <p class="faint-sm">${escapeHtml(SHARE_NOTE)}</p>`;
    box.innerHTML = `
      <div class="card">
        <div class="build-git-verdict-head"><p>${escapeHtml(notReadyText(r.reason))}</p>${checkAgainButton()}</div>
        ${error ? `<p class="err-text mt-2">${escapeHtml(error)}</p>` : ""}
        ${relayAction}
        ${aiControls}
        ${journalLink()}
      </div>`;
    $("build-git-relay-off")?.addEventListener("click", () => void relayOff(r, error));
    $("build-git-recheck-full")?.addEventListener("click", checkRepo);
    $("build-git-share")?.addEventListener("change", (e) => { share = e.target.checked; });
    // The adapt pass uses the box's model — confirm/provide the AI key first,
    // then run the adapt with that in-memory credential.
    $("build-git-adapt")?.addEventListener("click", () =>
      enterBuildKey({
        contextLabel: "Building with AI",
        back: "view-build-git",
        onChosen: (credential) => {
          adaptCredential = credential;
          show("view-build-git");
          void adapt();
        },
      }),
    );
  }
  $("build-git-recheck").addEventListener("click", checkRepo);
  wireJournalLink();
}

function leaveVerdict() {
  verdictShown = false;
  updateCheckButton();
}

// Turn the relay off for the key this adapt used, then offer the adapt again.
async function relayOff(verdict, error) {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  try {
    if (!(await turnRelayOffForCredential(session.umk, adaptCredential))) return toast("That key isn't saved on this device.", "err");
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), "err");
  }
  toast(RELAY_TURNED_OFF, "ok");
  renderVerdict(verdict, null);
}

function renderAdapting() {
  leaveVerdict();
  const progress = adaptProgress;
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p class="build-git-adapting"><span class="build-git-spinner" aria-hidden="true"></span>${escapeHtml(adaptingText(adaptPhase))}</p>
      ${progress ? `<p class="note mt-2" id="build-git-progress">${escapeHtml(progress)}</p>` : ""}
      <p class="note mt-2">${escapeHtml(ADAPTING_NOTE)}</p>
    </div>`;
}

function renderAdapted(fileCount) {
  leaveVerdict();
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p><strong>Adapted ✓</strong></p>
      <p class="note">The AI rewrote this repo into a Flagship app (${fileCount} file(s)).</p>
      <button id="build-git-deploy" class="full-width mt-2">${escapeHtml(DEPLOY_BUTTON)}</button>
      ${adapterExport()}
      ${journalLink()}
    </div>`;
  $("build-git-deploy").addEventListener("click", deploy);
  wireAdapterExport();
  wireJournalLink();
}

function renderInstalled(url) {
  leaveVerdict();
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p><strong>Installed ✓</strong></p>
      <p class="note"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>
      ${adapterExport()}
    </div>`;
  wireAdapterExport();
}

// For the repo's author: the file to commit so every Flagship server runs
// the repo this way.
function adapterExport() {
  return `<button id="build-git-export" class="secondary full-width mt-2">${escapeHtml(EXPORT_BUTTON)}</button>
      <p class="note mt-2">${escapeHtml(EXPORT_NOTE)}</p>`;
}

function wireAdapterExport() {
  const btn = $("build-git-export");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!buildId || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = EXPORT_PREPARING;
    const r = await exportAdapter({ buildId, fetchJson: (path) => boxFetch(path) });
    btn.disabled = false;
    btn.textContent = EXPORT_BUTTON;
    if (!r.ok) toast(r.message, "err");
  });
}

// The AI's tested copy didn't go live. The build is closed to the AI now,
// so trying again checks the repo afresh (a new build) and adapts that with
// the same key.
function renderNotLive(reason) {
  leaveVerdict();
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p><strong>${escapeHtml(NOT_LIVE)}</strong></p>
      <p class="err-text mt-2">${escapeHtml(reason || NOT_LIVE_FALLBACK)}</p>
      <button id="build-git-retry" class="full-width mt-2">${escapeHtml(RETRY_ADAPT)}</button>
      ${journalLink()}
    </div>`;
  $("build-git-retry").addEventListener("click", () => void retryAdapt());
  wireJournalLink();
}

async function retryAdapt() {
  await checkRepo();
  if (buildId && lastVerdict && lastVerdict.buildId === buildId && !closed && adaptCredential) await adapt();
}

function failAdapt(message, { sealed = false } = {}) {
  toast(message, "err");
  if (sealed) closed = true;
  if (lastVerdict) renderVerdict(lastVerdict, message);
}

function showAdaptOutcome(outcome) {
  if (outcome.phase === "installed") {
    renderInstalled(outcome.url);
    toast("Deployed", "ok");
  } else if (outcome.phase === "adapted") {
    renderAdapted(outcome.fileCount);
    toast("Adapted — review and install", "ok");
  } else if (outcome.phase === "not-live") {
    closed = true;
    renderNotLive(outcome.reason);
  } else {
    failAdapt(outcome.reason, { sealed: outcome.sealed === true });
  }
}

// Start the AI adapt on a non-fit repo in the background and follow it. An
// older box ignores `background` and answers with the finished result. If
// the box has no model wired (503), fall back to the from-scratch flow; if
// it already started the AI itself (409), follow that run.
async function adapt() {
  if (!buildId) return;
  const id = buildId;
  const path = `/api/build/sessions/${encodeURIComponent(id)}`;
  adaptPhase = null;
  adaptProgress = null;
  renderAdapting();
  try {
    adaptCredential = await freshCredential(adaptCredential, "");
    const body = adaptRequestBody({ credential: adaptCredential, share });
    const outcome = await startAndFollowAdapt({
      start: () => boxFetch(`${path}/adapt`, { method: "POST", body: JSON.stringify(body) }),
      follow: () => followAdapt({
        fetchState: () => boxFetch(path),
        fetchJournal: () => boxFetch(`${path}/journal`),
        onProgress: (p) => {
          if (buildId !== id) return;
          adaptProgress = p;
          renderAdapting();
        },
        onPhase: (phase) => {
          if (buildId !== id || phase === adaptPhase) return;
          adaptPhase = phase;
          renderAdapting();
        },
      }),
    });
    if (buildId !== id) return;
    showAdaptOutcome(outcome);
  } catch (e) {
    if (buildId !== id) return;
    if (e instanceof ScreensError && e.status === 503) {
      toast("AI adapt isn't available on this server yet — starting from scratch instead", "warn");
      // Mirror iOS (ServicesTab `onFallBackToScratch`) + Android
      // (BuildGitScreen `nav.navigate("vibe/key")`): a from-scratch build still
      // drives the box's model, so route through the AI-key step FIRST — then
      // open the chat seeded with the chosen credential. (Going straight to
      // enterVibeCode() let the chat self-correct via `needsCredential`, costing
      // an extra round-trip + a worse first impression.)
      enterBuildKey({
        contextLabel: "Start from scratch with AI",
        back: "view-build-git",
        onChosen: (credential) => enterVibeCode({ credential }),
      });
      return;
    }
    failAdapt(boxReason(e) ?? (e instanceof ScreensError || e?.rateLimited ? e.message : String(e)));
  }
}

async function deploy() {
  if (!buildId) return;
  const btn = $("build-git-deploy");
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    const r = await boxFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
    renderInstalled(r.url);
    toast("Deployed", "ok");
  } catch (e) {
    const failure = deployFailure(e);
    if (failure.needsAdapt) {
      // A shared adaptation that crashed here: the repo needs the owner's AI
      // now, so show the card that offers it.
      renderVerdict({ buildId, fit: false, reason: failure.reason, fileCount: lastVerdict?.fileCount ?? 0, name: assignedName });
      return;
    }
    toast(failure.message, "err");
    btn.disabled = false;
    btn.textContent = DEPLOY_BUTTON;
  }
}
