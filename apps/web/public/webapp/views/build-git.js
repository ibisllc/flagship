// Git build mode (webapp). One option: paste a repo URL. The box clones
// it and reports whether it's Flagship-ready:
//   - FIT     → install as-is (Deploy), no AI.
//   - NOT FIT → explain, offer "build with AI instead" (scratch).
// Every step is recorded in the build journal.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { enterVibeCode } from "./vibe-code.js";
import { enterBuildJournal } from "./build-journal.js";

registerView("view-build-git");

let buildId = null;

export function initBuildGitView() {
  $("build-git-check").addEventListener("click", checkRepo);
  $("build-git-back").addEventListener("click", () => show("view-build-source"));
}

export function enterBuildGit() {
  buildId = null;
  $("build-git-url").value = "";
  $("build-git-ref").value = "";
  $("build-git-verdict").classList.add("hidden");
  $("build-git-verdict").innerHTML = "";
  show("view-build-git");
}

async function checkRepo() {
  const gitUrl = $("build-git-url").value.trim();
  const ref = $("build-git-ref").value.trim();
  if (!gitUrl) return toast("paste a repo URL first", "err");
  const btn = $("build-git-check");
  btn.disabled = true;
  btn.textContent = "cloning…";
  try {
    const body = { gitUrl };
    if (ref) body.ref = ref;
    const r = await screensFetch("/api/build/git", { method: "POST", body: JSON.stringify(body) });
    buildId = r.buildId;
    renderVerdict(r);
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Check repo";
  }
}

function renderVerdict(r) {
  const box = $("build-git-verdict");
  box.classList.remove("hidden");
  if (r.fit) {
    box.innerHTML = `
      <div class="card">
        <p><strong>Flagship-ready ✓</strong></p>
        <p class="note">${escapeHtml(r.reason)} — ${r.fileCount} file(s).</p>
        <button id="build-git-deploy" class="full-width mt-2">Install it</button>
        <p class="note mt-2"><a id="build-git-journal" href="#">View build journal →</a></p>
      </div>`;
    $("build-git-deploy").addEventListener("click", deploy);
  } else {
    box.innerHTML = `
      <div class="card">
        <p><strong>Not Flagship-ready yet</strong></p>
        <p class="note">${escapeHtml(r.reason)}</p>
        <button id="build-git-adapt" class="full-width mt-2">Build with AI instead</button>
        <p class="note mt-2">The AI can adapt this repo to Flagship from a description of what it does.</p>
        <p class="note mt-2"><a id="build-git-journal" href="#">View build journal →</a></p>
      </div>`;
    $("build-git-adapt").addEventListener("click", () => enterVibeCode());
  }
  const j = $("build-git-journal");
  if (j) j.addEventListener("click", (e) => { e.preventDefault(); enterBuildJournal(buildId); });
}

async function deploy() {
  if (!buildId) return;
  const btn = $("build-git-deploy");
  btn.disabled = true;
  btn.textContent = "installing…";
  try {
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
    $("build-git-verdict").innerHTML = `
      <div class="card">
        <p><strong>Installed ✓</strong></p>
        <p class="note"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a></p>
      </div>`;
    toast("deployed", "ok");
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
    btn.disabled = false;
    btn.textContent = "Install it";
  }
}
