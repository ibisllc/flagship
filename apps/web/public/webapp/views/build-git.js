// Git build mode (webapp). One option: paste a repo URL. The box clones
// it and reports whether it's Flagship-ready:
//   - FIT     → install as-is (Deploy), no AI.
//   - NOT FIT → explain, offer "build with AI instead" (scratch).
// Every step is recorded in the build journal.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, buildEntryError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { enterVibeCode } from "./vibe-code.js";
import { enterBuildJournal } from "./build-journal.js";
import { enterBuildKey } from "./build-key.js";

registerView("view-build-git");

let buildId = null;
// The in-memory BYOK credential for the adapt pass, set from the AI-key step.
let adaptCredential = null;

export function initBuildGitView() {
  $("build-git-check").addEventListener("click", checkRepo);
  $("build-git-back").addEventListener("click", () => show("view-build-source"));
}

export function enterBuildGit() {
  buildId = null;
  adaptCredential = null;
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
    // A 404 here means the box has no service/build platform wired.
    toast(buildEntryError(e), "err");
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
        <p class="note mt-2">The AI rewrites this repo into a Flagship app — adds the manifest, removes its own login, and wires it to your box's data layer.</p>
        <p class="note mt-2"><a id="build-git-journal" href="#">View build journal →</a></p>
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
  const j = $("build-git-journal");
  if (j) j.addEventListener("click", (e) => { e.preventDefault(); enterBuildJournal(buildId); });
}

// Run the AI adapt pass on a non-fit repo. On success, reveal an
// "Install it" button reusing the same deploy call as the fit path. If
// the box has no model wired (503), fall back to the from-scratch flow
// with a friendly note.
async function adapt() {
  if (!buildId) return;
  const btn = $("build-git-adapt");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "adapting…";
  }
  try {
    const body = adaptCredential ? JSON.stringify({ credential: adaptCredential }) : undefined;
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/adapt`, {
      method: "POST",
      ...(body ? { body } : {}),
    });
    $("build-git-verdict").innerHTML = `
      <div class="card">
        <p><strong>Adapted ✓</strong></p>
        <p class="note">The AI rewrote this repo into a Flagship app (${r.fileCount} file(s)).</p>
        <button id="build-git-deploy" class="full-width mt-2">Install it</button>
        <p class="note mt-2"><a id="build-git-journal" href="#">View build journal →</a></p>
      </div>`;
    $("build-git-deploy").addEventListener("click", deploy);
    const j = $("build-git-journal");
    if (j) j.addEventListener("click", (e) => { e.preventDefault(); enterBuildJournal(buildId); });
    toast("adapted — review and install", "ok");
  } catch (e) {
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
    toast(e instanceof ScreensError ? e.message : String(e), "err");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Build with AI instead";
    }
  }
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
