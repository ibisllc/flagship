// Build sessions (webapp). Sessions still open on a box come first and
// reopen the vibe-code session; below them, the append-only history of how
// each service was built, across every mode. Every server this device has a
// session for is asked, so a build started on any of them shows up
// (docs/app-placement.md). Two entry points:
//   enterBuildJournal()                    → open sessions + past builds
//   enterBuildJournal(buildId, { server }) → that build's timeline directly

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, buildEntryError, boxClient } from "../lib/api.js";
import { loadAccountPods, sessionServers } from "../lib/appPlacement.js";
import { podShortName } from "../lib/podSwitcher.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { inlineConfirm } from "../lib/modal.js";
import {
  DISCARD_TITLE,
  buildDisplayName,
  buildMethodLabel,
  canDiscard,
  discardBuild,
  discardBuildMessage,
  discardMessage,
  discardSession,
  endedBuilds,
  fetchBuildsOnServers,
  isActiveSession,
  openBuilds,
  pastBuildSubtitle,
  sessionActionLabel,
  sessionPillClass,
  sessionStatusLabel,
  sessionTitle,
  sortSessionsNewestFirst,
} from "../lib/vibeSessions.js";
import { openVibeCodeSession } from "./vibe-code.js";
import { DEPLOY_BUTTON, failedBuild } from "../lib/gitImport.js";
import { resumeBuildGit } from "./build-git.js";

registerView("view-build-journal");

export function initBuildJournalView() {
  $("build-journal-back").addEventListener("click", () => show("view-build-source"));
}

export async function enterBuildJournal(buildId, { server = "" } = {}) {
  $("build-journal-detail").classList.add("hidden");
  $("build-journal-list").innerHTML = "";
  show("view-build-journal");
  if (buildId) {
    await renderDetail(buildId, server);
  } else {
    await renderList();
  }
}

/** A row's server, named when the list spans more than one. */
function serverPill(row, many) {
  return many && row.server ? `<span class="pill">${escapeHtml(podShortName(row.server))}</span>` : "";
}

const clientOf = (server) => boxClient(server || "");

async function renderList() {
  const pods = await loadAccountPods(getSession()?.username ?? "");
  const servers = sessionServers(pods);
  const all = await fetchBuildsOnServers(servers);
  // Every server failed: say why. The builds list is a build-platform ENTRY
  // call — a 404 means the box can't build services (unlike renderDetail's
  // session-scoped 404).
  if (servers.length === 0 || all.failed.length === servers.length) {
    toast(buildEntryError(all.failed[0]?.error ?? new ScreensError("not paired to a server yet", 0)), "err");
    return;
  }
  const builds = all.builds;
  const many = servers.length > 1;
  const sessions = sortSessionsNewestFirst(all.sessions);
  const ended = endedBuilds(builds, sessions);
  const open = openBuilds(builds, sessions);
  const list = $("build-journal-list");
  if (sessions.length === 0 && builds.length === 0) {
    list.innerHTML = `<div class="card placeholder">No builds yet.</div>`;
    return;
  }
  let html = "";
  if (sessions.length > 0 || open.length > 0) {
    html += `<p class="note build-section-caption">Open on your server${many ? "s" : ""}</p>`;
    html += open
      .map(
        (b) => `
        <button class="card full-width build-session-row" data-build="${escapeHtml(b.buildId)}" data-server="${escapeHtml(b.server ?? "")}">
          <span class="build-session-body">
            <strong>${escapeHtml(buildDisplayName(b))}</strong>
            <span class="note">Started ${escapeHtml(formatDateTime(b.startedAt))}</span>
            <span class="build-session-pills">
              <span class="pill">${escapeHtml(buildMethodLabel(b.mode))}</span>
              ${serverPill(b, many)}
            </span>
          </span>
          <span class="build-session-action">Open</span>
        </button><div class="build-session-discard"><button class="linklike" data-discard-build="${escapeHtml(b.buildId)}" data-server="${escapeHtml(b.server ?? "")}">Discard…</button></div>`,
      )
      .join("");
    html += sessions
      .map((s) => {
        const active = isActiveSession(s);
        const pill = sessionPillClass(s.status);
        const discard = canDiscard(s)
          ? `<div class="build-session-discard"><button class="linklike" data-discard="${escapeHtml(s.sessionId)}" data-server="${escapeHtml(s.server ?? "")}">Discard…</button></div>`
          : "";
        return `
        <button class="card full-width build-session-row${active ? " is-active" : ""}" data-session="${escapeHtml(s.sessionId)}" data-server="${escapeHtml(s.server ?? "")}">
          <span class="build-session-body">
            <strong>${escapeHtml(sessionTitle(s, builds))}</strong>
            <span class="note">Started ${escapeHtml(formatDateTime(s.startedAt))}</span>
            <span class="build-session-pills">
              <span class="pill${pill ? ` ${pill}` : ""}">${escapeHtml(sessionStatusLabel(s.status))}</span>
              <span class="pill">${escapeHtml(buildMethodLabel("scratch"))}</span>
              ${serverPill(s, many)}
            </span>
          </span>
          <span class="build-session-action">${escapeHtml(sessionActionLabel(s.status))}</span>
        </button>${discard}`;
      })
      .join("");
  }
  if (ended.length > 0) {
    html += `<p class="note build-section-caption">Past builds</p>`;
    html += ended
      .map(
        (b) => `
        <button class="card full-width build-tile" data-build="${escapeHtml(b.buildId)}" data-server="${escapeHtml(b.server ?? "")}">
          <strong>${escapeHtml(buildDisplayName(b))}</strong>
          <span class="note">${escapeHtml(pastBuildSubtitle(b, formatDateTime(b.startedAt)))}</span>
          <span class="pill">${escapeHtml(buildMethodLabel(b.mode))}</span>
          ${serverPill(b, many)}
        </button>`,
      )
      .join("");
  }
  list.innerHTML = html;
  const on = (el, row) => (row.server ?? "") === (el.getAttribute("data-server") ?? "");
  for (const el of list.querySelectorAll("[data-session]")) {
    el.addEventListener("click", () =>
      openVibeCodeSession(el.getAttribute("data-session"), { server: el.getAttribute("data-server") || "" }));
  }
  for (const el of list.querySelectorAll("[data-discard]")) {
    const session = sessions.find((s) => s.sessionId === el.getAttribute("data-discard") && on(el, s));
    if (session) el.addEventListener("click", () => void confirmDiscard(session));
  }
  for (const el of list.querySelectorAll("[data-discard-build]")) {
    const build = open.find((b) => b.buildId === el.getAttribute("data-discard-build") && on(el, b));
    if (build) el.addEventListener("click", () => void confirmDiscardBuild(build));
  }
  for (const el of list.querySelectorAll("[data-build]")) {
    el.addEventListener("click", () => renderDetail(el.getAttribute("data-build"), el.getAttribute("data-server") || ""));
  }
}

async function confirmDiscardBuild(build) {
  const ok = await inlineConfirm({
    title: DISCARD_TITLE,
    message: discardBuildMessage(build),
    okLabel: "Discard build",
    danger: true,
  });
  if (!ok) return;
  try {
    const c = clientOf(build.server);
    await discardBuild({ baseUrl: c.baseUrl, token: c.token(), buildId: build.buildId });
  } catch (e) {
    toast(e.message, "err");
    return;
  }
  await renderList();
}

async function confirmDiscard(session) {
  const ok = await inlineConfirm({
    title: DISCARD_TITLE,
    message: discardMessage(session),
    okLabel: "Discard build",
    danger: true,
  });
  if (!ok) return;
  try {
    const c = clientOf(session.server);
    await discardSession({ baseUrl: c.baseUrl, token: c.token(), sessionId: session.sessionId });
  } catch (e) {
    toast(e.message, "err");
    return;
  }
  await renderList();
}

async function renderDetail(buildId, server = "") {
  const c = clientOf(server);
  const path = `/api/build/sessions/${encodeURIComponent(buildId)}`;
  // A build the box brought back failed (a restart cut it off) says why and
  // offers the AI again or deploying; an ended build has no state any more.
  const held = await clientOf(server).fetch(path).catch(() => null);
  const failed = failedBuild(held?.state);
  if (failed?.mode === "git") {
    return resumeBuildGit({
      buildId,
      server: c.fqdn,
      state: held.state,
      fileCount: Array.isArray(held.files) ? held.files.length : 0,
      reason: failed.reason,
      canAdapt: failed.canAdapt,
    });
  }
  try {
    const r = await clientOf(server).fetch(`${path}/journal`);
    const entries = r.entries || [];
    const detail = $("build-journal-detail");
    detail.classList.remove("hidden");
    detail.innerHTML = `
      ${failed ? `<div class="card" data-build-failed>
        <p class="err-text">${escapeHtml(failed.reason)}</p>
        <button id="build-journal-deploy" class="full-width mt-2">${escapeHtml(DEPLOY_BUTTON)}</button>
      </div>` : ""}
      <div class="card">
        <h3>Build ${escapeHtml(buildId)}</h3>
        <ol class="build-journal-timeline">
          ${entries
            .map(
              (e) => `<li>
                <span class="note">${escapeHtml(formatDateTime(e.ts))}</span>
                <span class="badge">${escapeHtml(e.kind)}</span>
                <span class="badge">${escapeHtml(e.actor)}</span>
                <div>${escapeHtml(e.summary)}</div>
                ${e.detail ? `<div class="note">${escapeHtml(e.detail)}</div>` : ""}
              </li>`,
            )
            .join("")}
        </ol>
      </div>`;
    $("build-journal-deploy")?.addEventListener("click", () => void deployHeld(buildId, c));
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}

// Put an IDE build the box brought back failed live from the files it holds.
async function deployHeld(buildId, c) {
  const btn = $("build-journal-deploy");
  if (btn) btn.disabled = true;
  try {
    const r = await c.fetch(`/api/build/sessions/${encodeURIComponent(buildId)}/deploy`, { method: "POST" });
    toast(`Deployed → ${r.url}`, "ok");
    await renderList();
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
    if (btn) btn.disabled = false;
  }
}
