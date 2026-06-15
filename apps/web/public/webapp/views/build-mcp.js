// MCP build mode (webapp). The box hosts an MCP server scoped to this
// build; the user pastes the URL + a per-build key into Cursor/Cline and
// builds from their editor using their OWN AI — no model key on the box.
// The key binds the IDE connection to exactly this one build session.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { enterBuildJournal } from "./build-journal.js";

registerView("view-build-mcp");

let buildId = null;

export function initBuildMcpView() {
  $("build-mcp-create").addEventListener("click", createConnection);
  $("build-mcp-back").addEventListener("click", () => show("view-build-source"));
}

export function enterBuildMcp() {
  buildId = null;
  $("build-mcp-conn").classList.add("hidden");
  $("build-mcp-conn").innerHTML = "";
  show("view-build-mcp");
}

async function createConnection() {
  const btn = $("build-mcp-create");
  btn.disabled = true;
  btn.textContent = "creating…";
  try {
    const r = await screensFetch("/api/build/mcp", {
      method: "POST",
      body: JSON.stringify({ label: "webapp" }),
    });
    buildId = r.buildId;
    renderConnection(r.connection);
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
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
    </div>`;
  $("mcp-copy-cfg").addEventListener("click", () => copy(cfg, "config copied"));
  $("mcp-rotate").addEventListener("click", rotate);
  $("mcp-journal").addEventListener("click", () => enterBuildJournal(buildId));
  $("mcp-deploy").addEventListener("click", deploy);
}

async function rotate() {
  if (!buildId) return;
  try {
    const conn = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/mcp/rotate`, { method: "POST", body: JSON.stringify({ label: "webapp" }) });
    renderConnection(conn);
    toast("key regenerated — update your IDE", "ok");
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
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
    toast(`deployed → ${r.url}`, "ok");
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
    toast("copy failed — select manually", "err");
  }
}
