// Build sessions (webapp). Sessions still open on the box come first and
// reopen the vibe-code session; below them, the append-only history of how
// each service was built, across every mode. Two entry points:
//   enterBuildJournal()        → open sessions + past builds
//   enterBuildJournal(buildId) → that build's timeline directly

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, buildEntryError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { inlineConfirm } from "../lib/modal.js";
import {
  DISCARD_TITLE,
  buildDisplayName,
  buildMethodLabel,
  canDiscard,
  discardMessage,
  discardSession,
  endedBuilds,
  fetchVibeSessions,
  isActiveSession,
  pastBuildSubtitle,
  sessionPillClass,
  sessionStatusLabel,
  sessionTitle,
  sortSessionsNewestFirst,
} from "../lib/vibeSessions.js";
import { openVibeCodeSession } from "./vibe-code.js";

registerView("view-build-journal");

export function initBuildJournalView() {
  $("build-journal-back").addEventListener("click", () => show("view-build-source"));
}

export async function enterBuildJournal(buildId) {
  $("build-journal-detail").classList.add("hidden");
  $("build-journal-list").innerHTML = "";
  show("view-build-journal");
  if (buildId) {
    await renderDetail(buildId);
  } else {
    await renderList();
  }
}

async function renderList() {
  const sessionsP = fetchVibeSessions({ baseUrl: getPodBaseUrl(), token: getSessionToken() });
  let builds;
  try {
    const r = await screensFetch("/api/build/sessions");
    builds = r.builds || [];
  } catch (e) {
    // The sessions list is a build-platform ENTRY call — a 404 means the box
    // can't build services (unlike renderDetail's session-scoped 404).
    toast(buildEntryError(e), "err");
    return;
  }
  const sessions = sortSessionsNewestFirst(await sessionsP);
  const ended = endedBuilds(builds, sessions);
  const list = $("build-journal-list");
  if (sessions.length === 0 && builds.length === 0) {
    list.innerHTML = `<div class="card placeholder">No builds yet.</div>`;
    return;
  }
  let html = "";
  if (sessions.length > 0) {
    html += `<p class="note build-section-caption">Open on your server</p>`;
    html += sessions
      .map((s) => {
        const active = isActiveSession(s);
        const pill = sessionPillClass(s.status);
        const discard = canDiscard(s)
          ? `<div class="build-session-discard"><button class="linklike" data-discard="${escapeHtml(s.sessionId)}">Discard…</button></div>`
          : "";
        return `
        <button class="card full-width build-session-row${active ? " is-active" : ""}" data-session="${escapeHtml(s.sessionId)}">
          <span class="build-session-body">
            <strong>${escapeHtml(sessionTitle(s, builds))}</strong>
            <span class="note">Started ${escapeHtml(formatDateTime(s.startedAt))}</span>
            <span class="build-session-pills">
              <span class="pill${pill ? ` ${pill}` : ""}">${escapeHtml(sessionStatusLabel(s.status))}</span>
              <span class="pill">${escapeHtml(buildMethodLabel("scratch"))}</span>
            </span>
          </span>
          <span class="build-session-action">${active ? "Resume" : "Open"}</span>
        </button>${discard}`;
      })
      .join("");
  }
  if (ended.length > 0) {
    html += `<p class="note build-section-caption">Past builds</p>`;
    html += ended
      .map(
        (b) => `
        <button class="card full-width build-tile" data-build="${escapeHtml(b.buildId)}">
          <strong>${escapeHtml(buildDisplayName(b))}</strong>
          <span class="note">${escapeHtml(pastBuildSubtitle(b, formatDateTime(b.startedAt)))}</span>
          <span class="pill">${escapeHtml(buildMethodLabel(b.mode))}</span>
        </button>`,
      )
      .join("");
  }
  list.innerHTML = html;
  for (const el of list.querySelectorAll("[data-session]")) {
    el.addEventListener("click", () => openVibeCodeSession(el.getAttribute("data-session")));
  }
  for (const el of list.querySelectorAll("[data-discard]")) {
    const session = sessions.find((s) => s.sessionId === el.getAttribute("data-discard"));
    if (session) el.addEventListener("click", () => void confirmDiscard(session));
  }
  for (const el of list.querySelectorAll("[data-build]")) {
    el.addEventListener("click", () => renderDetail(el.getAttribute("data-build")));
  }
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
    await discardSession({ baseUrl: getPodBaseUrl(), token: getSessionToken(), sessionId: session.sessionId });
  } catch (e) {
    toast(e.message, "err");
    return;
  }
  await renderList();
}

async function renderDetail(buildId) {
  try {
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/journal`);
    const entries = r.entries || [];
    const detail = $("build-journal-detail");
    detail.classList.remove("hidden");
    detail.innerHTML = `
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
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}
