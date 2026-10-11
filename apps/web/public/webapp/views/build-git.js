// Git build mode (webapp). Paste a repo URL and, optionally, the name it
// goes live under. The box clones it and reports whether it's Flagship-ready:
//   - FIT     → install as-is (Deploy), no AI.
//   - NOT FIT → offer the AI adapt, which runs in the background on the box
//               while this view follows it.
// Every step is recorded in the build journal.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, boxReason, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { checkName, nameWarning, slugify } from "../lib/vibeNames.js";
import {
  ADAPTING,
  ADAPTING_NOTE,
  ADAPT_BUTTON,
  EXPORT_BUTTON,
  EXPORT_NOTE,
  EXPORT_PREPARING,
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
  if (nameCheckTimer) clearTimeout(nameCheckTimer);
  nameCheckTimer = null;
  $("build-git-url").value = "";
  $("build-git-ref").value = "";
  $("build-git-name").value = "";
  $("build-git-share").checked = true;
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  renderNameStatus();
  show("view-build-git");
}

function currentSlug() {
  return slugify($("build-git-name")?.value);
}

function currentCheck() {
  return checkedSlug === currentSlug() ? nameCheck : null;
}

function serverFqdn() {
  const base = getPodBaseUrl();
  if (!base) return "";
  try {
    return new URL(base).hostname;
  } catch {
    return "";
  }
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
}

async function runNameCheck(slug) {
  const result = await checkName({ baseUrl: getPodBaseUrl(), token: getSessionToken(), name: slug });
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
    share: $("build-git-share").checked,
  });
  if (!body.gitUrl) return toast("Paste a repo URL first", "err");
  buildId = null;
  lastVerdict = null;
  assignedName = null;
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  checking = true;
  renderNameStatus();
  try {
    const r = await screensFetch("/api/build/git", { method: "POST", body: JSON.stringify(body) });
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
  if (j) j.addEventListener("click", (e) => { e.preventDefault(); enterBuildJournal(buildId); });
}

function renderVerdict(r, error = null) {
  const box = $("build-git-verdict");
  box.classList.remove("hidden");
  if (r.fit) {
    box.innerHTML = `
      <div class="card">
        <p><strong>Flagship-ready ✓</strong></p>
        <p class="note">${escapeHtml(r.reason)} — ${r.fileCount} file(s).</p>
        <button id="build-git-deploy" class="full-width mt-2">Install it</button>
        ${journalLink()}
      </div>`;
    $("build-git-deploy").addEventListener("click", deploy);
  } else {
    lastVerdict = r;
    box.innerHTML = `
      <div class="card">
        <p>${escapeHtml(notReadyText(r.reason))}</p>
        ${error ? `<p class="err-text mt-2">${escapeHtml(error)}</p>` : ""}
        <button id="build-git-adapt" class="full-width mt-2">${escapeHtml(ADAPT_BUTTON)}</button>
        ${journalLink()}
      </div>`;
    // The adapt pass uses the box's model — confirm/provide the AI key first,
    // then run the adapt with that in-memory credential.
    $("build-git-adapt").addEventListener("click", () =>
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
  wireJournalLink();
}

function renderAdapting(progress) {
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p class="build-git-adapting"><span class="build-git-spinner" aria-hidden="true"></span>${escapeHtml(ADAPTING)}</p>
      ${progress ? `<p class="note mt-2" id="build-git-progress">${escapeHtml(progress)}</p>` : ""}
      <p class="note mt-2">${escapeHtml(ADAPTING_NOTE)}</p>
    </div>`;
}

function renderAdapted(fileCount) {
  $("build-git-verdict").innerHTML = `
    <div class="card">
      <p><strong>Adapted ✓</strong></p>
      <p class="note">The AI rewrote this repo into a Flagship app (${fileCount} file(s)).</p>
      <button id="build-git-deploy" class="full-width mt-2">Install it</button>
      ${adapterExport()}
      ${journalLink()}
    </div>`;
  $("build-git-deploy").addEventListener("click", deploy);
  wireAdapterExport();
  wireJournalLink();
}

function renderInstalled(url) {
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
    const r = await exportAdapter({ buildId, fetchJson: (path) => screensFetch(path) });
    btn.disabled = false;
    btn.textContent = EXPORT_BUTTON;
    if (!r.ok) toast(r.message, "err");
  });
}

function failAdapt(message) {
  toast(message, "err");
  if (lastVerdict) renderVerdict(lastVerdict, message);
}

function showAdaptOutcome(outcome) {
  if (outcome.phase === "installed") {
    renderInstalled(outcome.url);
    toast("Deployed", "ok");
  } else if (outcome.phase === "adapted") {
    renderAdapted(outcome.fileCount);
    toast("Adapted — review and install", "ok");
  } else {
    failAdapt(outcome.reason);
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
  renderAdapting(null);
  try {
    const body = adaptCredential ? { credential: adaptCredential, background: true } : { background: true };
    const outcome = await startAndFollowAdapt({
      start: () => screensFetch(`${path}/adapt`, { method: "POST", body: JSON.stringify(body) }),
      follow: () => followAdapt({
        fetchState: () => screensFetch(path),
        fetchJournal: () => screensFetch(`${path}/journal`),
        onProgress: (p) => { if (buildId === id) renderAdapting(p); },
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
    failAdapt(boxReason(e) ?? (e instanceof ScreensError ? e.message : String(e)));
  }
}

async function deploy() {
  if (!buildId) return;
  const btn = $("build-git-deploy");
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
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
    btn.textContent = "Install it";
  }
}
