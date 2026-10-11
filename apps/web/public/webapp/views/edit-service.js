// "Edit this service": change an installed service's code, either by
// describing the change to the AI chat or from the owner's own IDE. Either
// way the new version replaces the running one in place (same address, same
// data).
//
// Flow: service detail → chooser → (AI) AI-key step → "What should change?"
// → the usual build session, whose Back returns to the service; or (IDE) the
// "Connect your IDE" screen, creating a build that starts from its code.
//
// MIRRORS: iOS EditServiceScreens.swift, Android EditServiceScreens.kt.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch } from "../lib/api.js";
import { inlineAlert, inlineConfirm } from "../lib/modal.js";
import { monitorIcon, sparklesIcon } from "../lib/icons.js";
import { escapeHtml } from "../lib/util.js";
import {
  AI_OPTION,
  IDE_OPTION,
  REPLACE_NOTE,
  canStart,
  editRefusal,
  editTitle,
  refusalMessage,
  refusalTitle,
  serviceSlug,
} from "../lib/editService.js";
import { enterBuildKey } from "./build-key.js";
import { enterBuildMcp } from "./build-mcp.js";
import { enterBuildJournal } from "./build-journal.js";
import { openVibeCodeSession } from "./vibe-code.js";

registerView("view-edit-service");
registerView("view-edit-describe");

let serviceId = null;
// The in-memory AI key from the key step; never persisted here.
let credential = null;
let starting = false;

function optionMarkup(id, icon, { title, subtitle }) {
  return `
    <button class="card full-width edit-row" id="${id}">
      <span class="edit-row-icon" aria-hidden="true">${icon}</span>
      <span class="edit-row-body">
        <strong>${escapeHtml(title)}</strong>
        <span class="note">${escapeHtml(subtitle)}</span>
      </span>
      <span class="build-resume-chevron" aria-hidden="true">›</span>
    </button>`;
}

async function openService(id) {
  const { enterServiceDetail } = await import("./service-detail.js");
  await enterServiceDetail(id);
}

function chooseAI() {
  const id = serviceId;
  enterBuildKey({
    contextLabel: "Changing a service with AI",
    back: "view-edit-service",
    onChosen: (cred) => enterEditDescribe(id, cred),
  });
}

function useIDE(back) {
  enterBuildMcp({ editServiceId: serviceId, back });
}

function updateStartButton() {
  const btn = $("edit-describe-start");
  if (!btn) return;
  btn.textContent = starting ? "Starting…" : "Start";
  btn.disabled = !canStart($("edit-describe-prompt")?.value, starting);
}

async function showRefusal(r, name) {
  const title = refusalTitle(r);
  const message = refusalMessage(r, name);
  if (r.kind === "session") {
    const open = await inlineConfirm({ title, message, okLabel: "Open build sessions", cancelLabel: "OK" });
    if (open) void enterBuildJournal();
  } else if (r.kind === "tooBig") {
    const ide = await inlineConfirm({ title, message, okLabel: "Use your IDE", cancelLabel: "OK" });
    if (ide) useIDE("view-edit-describe");
  } else {
    await inlineAlert({ title, message, okLabel: "OK" });
  }
}

async function start() {
  const promptEl = $("edit-describe-prompt");
  const prompt = promptEl.value;
  if (!canStart(prompt, starting)) return;
  const id = serviceId;
  starting = true;
  updateStartButton();
  try {
    const body = { prompt, editServiceId: id };
    if (credential) body.credential = credential;
    let r;
    try {
      r = await screensFetch("/api/screens/vibe-code/start", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      await showRefusal(editRefusal(e), serviceSlug(id));
      return;
    }
    if (r.needsCredential) {
      enterBuildKey({
        contextLabel: "Changing a service with AI",
        back: "view-edit-describe",
        onChosen: (cred) => enterEditDescribe(id, cred),
      });
      return;
    }
    promptEl.value = "";
    await openVibeCodeSession(r.sessionId, { credential, back: () => openService(id) });
  } finally {
    starting = false;
    updateStartButton();
  }
}

export function initEditServiceView() {
  const options = $("edit-service-options");
  if (options) {
    options.innerHTML =
      optionMarkup("edit-service-ai", sparklesIcon, AI_OPTION) +
      `<div class="mt-2"></div>` +
      optionMarkup("edit-service-ide", monitorIcon, IDE_OPTION);
  }
  const note = $("edit-service-note");
  if (note) note.textContent = REPLACE_NOTE;
  $("edit-service-ai")?.addEventListener("click", chooseAI);
  $("edit-service-ide")?.addEventListener("click", () => useIDE("view-edit-service"));
  $("edit-service-back")?.addEventListener("click", () => void openService(serviceId));
  $("edit-describe-prompt")?.addEventListener("input", updateStartButton);
  $("edit-describe-start")?.addEventListener("click", () => void start());
  $("edit-describe-back")?.addEventListener("click", () => show("view-edit-service"));
}

/** The chooser for `<creator>--<slug>`. */
export function enterEditService(id) {
  serviceId = id;
  credential = null;
  const prompt = $("edit-describe-prompt");
  if (prompt) prompt.value = "";
  $("edit-service-title").textContent = editTitle(serviceSlug(id));
  show("view-edit-service");
}

/** "What should change?", with the AI key the box should use. */
export function enterEditDescribe(id, cred) {
  serviceId = id;
  credential = cred ?? null;
  starting = false;
  $("edit-describe-title").textContent = editTitle(serviceSlug(id));
  show("view-edit-describe");
  updateStartButton();
  $("edit-describe-prompt")?.focus();
}
