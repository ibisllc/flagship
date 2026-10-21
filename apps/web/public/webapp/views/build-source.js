// Build-a-service source chooser — the first screen of the create-a-service
// flow. Resuming comes first, so an unfinished build isn't abandoned for a
// new one; the help dialog carries the explanations the tiles leave out.
// Fans out to the build modes; each converges on the same deploy + journal:
//
//   - scratch     → describe it, the AI writes + deploys it (existing vibe flow)
//   - git         → import a repo; if Flagship-ready install as-is, else AI-adapt
//   - mcp         → connect Cursor/Cline; build from your editor with your own AI

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { countActiveSessions, fetchVibeSessions } from "../lib/vibeSessions.js";
import { getSession } from "../lib/state.js";
import { enterVibeCode } from "./vibe-code.js";
import { enterBuildGit } from "./build-git.js";
import { enterBuildMcp } from "./build-mcp.js";
import { enterBuildJournal } from "./build-journal.js";
import { enterBuildKey } from "./build-key.js";
import { loadAccountPods, sessionServers, startCreation } from "../lib/appPlacement.js";

import { tr } from "../lib/i18n.js";
registerView("view-build-source");

// Where Back goes: the services list, or the server page a "Create app here"
// came from.
let backView = "view-services-list";

const HELP_ITEMS = [
  [tr("Resume or view past builds"),
    tr("Builds still open on your server can be picked up where you left off: answer the AI, deploy, or retry a failed deploy. Older builds keep a timeline of what happened. A build stays open until your server restarts.")],
  [tr("Start from scratch with AI"),
    tr("Describe the app you want in plain English. An AI model writes the code on your server, asks you questions when it needs to, and you deploy it with one tap. You need a key from an AI provider (OpenAI, Anthropic, OpenRouter…); it is sent only to your server.")],
  [tr("Import from a Git repo"),
    tr("Paste the address of a code repository, for example on GitHub. If it is already set up for Flagship it installs as-is; otherwise the AI can adapt it for you.")],
  [tr("Connect your IDE"),
    tr("For developers: work in your own IDE (Claude Code, Cursor, VS Code or Cline) with your own AI, connected to your server over MCP. No AI key is stored on the server.")],
];

export function initBuildSourceView() {
  // Scratch uses the box's model — the next screen asks for / confirms the
  // AI key, then opens the chat seeded with the in-memory credential.
  $("build-src-scratch").addEventListener("click", () =>
    enterBuildKey({
      contextLabel: tr("Start from scratch with AI"),
      onChosen: (credential) => enterVibeCode({ credential }),
    }),
  );
  $("build-src-git").addEventListener("click", () => enterBuildGit());
  $("build-src-mcp").addEventListener("click", () => enterBuildMcp());
  $("build-source-journal-link").addEventListener("click", (e) => {
    e.preventDefault();
    enterBuildJournal();
  });
  $("build-source-help").addEventListener("click", openBuildHelp);
  $("build-source-back").addEventListener("click", () => show(backView));
  // Re-counted every time the chooser shows (e.g. Back from a session).
  document.addEventListener("flagship:view-shown", (e) => {
    if (e.detail?.id === "view-build-source") void refreshActiveCount();
  });
}

/** Open the chooser. From a server's page `server` fixes where the new app
 *  runs (docs/app-placement.md §2); otherwise each flow offers the choice. */
export function enterBuildSource(opts = {}) {
  const server = typeof opts?.server === "string" ? opts.server : "";
  startCreation({ server, pinned: !!server });
  backView = server ? "view-server-detail" : "view-services-list";
  show("view-build-source");
}

async function refreshActiveCount() {
  // Open sessions on every server this device can ask.
  const servers = sessionServers(await loadAccountPods(getSession()?.username ?? ""));
  const lists = await Promise.all(servers.map((s) => fetchVibeSessions({ baseUrl: s.baseUrl, token: s.token })));
  const n = countActiveSessions(lists.flat());
  const badge = $("build-source-active-count");
  badge.textContent = n > 0 ? String(n) : "";
  badge.setAttribute("aria-label", `${n} active`);
  badge.classList.toggle("hidden", n === 0);
  $("build-source-journal-link").classList.toggle("has-active", n > 0);
}

function openBuildHelp() {
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", tr("How building works"));
  dlg.innerHTML = `
    <h3 class="modal-title">${tr("How building works")}</h3>
    <p class="modal-message">${tr("Every option ends the same way: the app is installed and running on your own server, at its own web address.")}</p>
    <div class="build-help-list">
      ${HELP_ITEMS.map(([title, body]) => `<div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(body)}</p></div>`).join("")}
    </div>
    <button class="full-width" data-help-done>${tr("Done")}</button>
  `;
  document.body.appendChild(dlg);
  const close = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  dlg.querySelector("[data-help-done]").addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dlg.showModal();
}
