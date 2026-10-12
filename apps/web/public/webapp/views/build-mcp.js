// MCP build mode (webapp). The box hosts an MCP server scoped to this
// build; the user pastes the URL + a per-build key into Cursor/Cline and
// builds from their editor using their OWN AI — no model key on the box.
// The key binds the IDE connection to exactly this one build session.

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, buildEntryError, boxClient } from "../lib/api.js";
import { creationTarget, mountCreationPicker } from "../lib/appPlacement.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { ideEditIntro, serviceSlug } from "../lib/editService.js";
import { enterBuildJournal } from "./build-journal.js";

registerView("view-build-mcp");

let buildId = null;
// Set when the IDE changes an installed service rather than building a new
// one: the build starts from its code and its deploy replaces it.
let editServiceId = null;
let backView = "view-build-source";
let defaultIntro = null;
// The box this build runs on: the server picked for a new app
// (docs/app-placement.md §2), or the current one for an edit (where the
// service is). Every call goes there.
let buildBox = null;

const boxFetch = (path, init) => (buildBox ?? boxClient()).fetch(path, init);

export function initBuildMcpView() {
  $("build-mcp-create").addEventListener("click", createConnection);
  $("build-mcp-back").addEventListener("click", () => show(backView));
}

/** Open the IDE screen; `editServiceId` makes it change that service. */
export function enterBuildMcp({ editServiceId: editId = null, back = "view-build-source" } = {}) {
  buildId = null;
  editServiceId = editId;
  backView = back;
  const intro = $("build-mcp-intro");
  if (intro) {
    defaultIntro ??= intro.textContent;
    intro.textContent = editId ? ideEditIntro(serviceSlug(editId)) : defaultIntro;
  }
  $("build-mcp-conn").classList.add("hidden");
  $("build-mcp-conn").innerHTML = "";
  const picker = $("build-mcp-runs-on");
  show("view-build-mcp");
  if (editId) {
    buildBox = boxClient();
    if (picker) picker.innerHTML = "";
    return Promise.resolve();
  }
  buildBox = boxClient(creationTarget().fqdn);
  return mountCreationPicker(picker, {
    username: getSession()?.username ?? "",
    onChange: (fqdn) => {
      // A connection made on the old server stays there; start afresh.
      buildBox = boxClient(fqdn);
      buildId = null;
      $("build-mcp-conn").classList.add("hidden");
      $("build-mcp-conn").innerHTML = "";
    },
  }).then((fqdn) => {
    if (!buildId) buildBox = boxClient(fqdn);
  });
}

async function createConnection() {
  const btn = $("build-mcp-create");
  btn.disabled = true;
  btn.textContent = "creating…";
  try {
    const body = { label: "webapp" };
    if (editServiceId) body.editServiceId = editServiceId;
    const r = await boxFetch("/api/build/mcp", {
      method: "POST",
      body: JSON.stringify(body),
    });
    buildId = r.buildId;
    renderConnection(r.connection);
  } catch (e) {
    // A 404 on this entry call means the box has no service/build platform;
    // an edit's refusals (service gone, not editable) carry their own words.
    const boxSays = editServiceId && typeof e?.body?.error === "string" ? e.body.error : null;
    toast(boxSays ?? buildEntryError(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create a connection";
  }
}

function renderConnection(conn) {
  const box = $("build-mcp-conn");
  box.classList.remove("hidden");
  const cfg = JSON.stringify(conn.ideConfig, null, 2);
  box.innerHTML = `
    <div class="card">
      <p class="note">Paste this into your IDE's MCP settings (Cursor: Settings → MCP; Cline: MCP servers). The key works only for this build.</p>
      <div class="row mt-2"><span class="label">URL</span><span class="value mono" id="mcp-url">${escapeHtml(conn.url)}</span></div>
      <div class="row"><span class="label">Key</span><span class="value mono" id="mcp-key">${escapeHtml(conn.key)}</span></div>
      <button id="mcp-copy-cfg" class="full-width mt-2">Copy IDE config</button>
      <pre class="vc-transcript mt-2">${escapeHtml(cfg)}</pre>
      <div class="row-2 mt-2">
        <button class="secondary" id="mcp-rotate">Regenerate key</button>
        <button class="secondary" id="mcp-journal">View journal</button>
      </div>
      <p class="note mt-2">Your editor's agent writes files, validates, requests any secrets (value-free), and deploys. You can also deploy here once it's done:</p>
      <button id="mcp-deploy" class="full-width mt-2">Deploy now</button>
      <div id="mcp-env-requests"></div>
    </div>`;
  $("mcp-copy-cfg").addEventListener("click", () => copy(cfg, "config copied"));
  $("mcp-rotate").addEventListener("click", rotate);
  $("mcp-journal").addEventListener("click", () => enterBuildJournal(buildId, { server: (buildBox ?? boxClient()).fqdn }));
  $("mcp-deploy").addEventListener("click", deploy);
  refreshEnvRequests();
}

// Show the env vars the IDE asked for. VALUE-FREE: the IDE/AI never sees or
// sends the value — you set it on your box from the "Configure environment"
// screen after the service is installed. We only ever learn the NAME here.
async function refreshEnvRequests() {
  if (!buildId) return;
  const box = $("mcp-env-requests");
  if (!box) return;
  let requests = [];
  try {
    const r = await boxFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/env-requests`);
    requests = Array.isArray(r.requests) ? r.requests : [];
  } catch {
    box.innerHTML = "";
    return;
  }
  if (requests.length === 0) {
    box.innerHTML = "";
    return;
  }
  const rows = requests
    .map((q) => {
      const why = q.why ? `<span class="note">${escapeHtml(q.why)}</span>` : "";
      const status = q.currentlySet
        ? '<span class="value">set ✓</span>'
        : '<span class="value">needs you</span>';
      return `<div class="row mt-1"><span class="label mono">${escapeHtml(q.name)}</span>${status}</div>${why}`;
    })
    .join("");
  box.innerHTML = `
    <div class="card mt-2">
      <p class="label">Your IDE asked for these secrets</p>
      <p class="note">The editor and its AI never see the value — you set it here on your box. Open <strong>Configure environment</strong> on the service after it's deployed and enter each value there; it never travels through your IDE.</p>
      ${rows}
      <button id="mcp-env-refresh" class="secondary full-width mt-2">Refresh</button>
    </div>`;
  $("mcp-env-refresh").addEventListener("click", refreshEnvRequests);
}

async function rotate() {
  if (!buildId) return;
  try {
    const conn = await boxFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/mcp/rotate`, { method: "POST", body: JSON.stringify({ label: "webapp" }) });
    renderConnection(conn);
    toast("Key regenerated — update your IDE", "ok");
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}

async function deploy() {
  if (!buildId) return;
  const btn = $("mcp-deploy");
  btn.disabled = true;
  btn.textContent = "deploying…";
  try {
    const r = await boxFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
    toast(`Deployed → ${r.url}`, "ok");
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Deploy now";
  }
}

function copy(text, msg) {
  try {
    navigator.clipboard.writeText(text);
    toast(msg, "ok");
  } catch {
    toast("Copy failed — select manually", "err");
  }
}
