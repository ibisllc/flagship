// Reusable AI-key step.
//
// A build path that drives the BOX's own model (start-from-scratch, the
// git-adapt pass) routes through here BEFORE it runs, so the owner can
// provide or confirm the AI key the box will use. Paths that do NOT use the
// box's model (marketplace install, IDE/MCP — which uses the user's own
// editor AI) skip this entirely.
//
// Flagship Inference (free while the promotion runs) is a built-in provider: always the
// first row, never deletable, disabled with the reason when it can't be used.
// A new owner with no saved key builds on it straight away (the step is
// skipped). Adding and choosing are separate: "Add an API key" opens a form that saves
// the key to this device's list (and makes it the last-used one); each saved
// key has "Use this", which hands the credential back IN MEMORY via onChosen
// and moves the flow on, and a confirmed delete. The raw key never touches
// flagshipserver.com. Saved keys live only in this device's IndexedDB
// (providers.js, AES-GCM wrapped under the UMK seed).
//
// Usage:
//   enterBuildKey({
//     contextLabel: "Start from scratch with AI",
//     onChosen: ({ provider, apiKey, baseUrl, relay }) => { … },
//   });
//
// MIRRORS: iOS BuildKeyScreen, Android AiKeyStepScreen.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { inlineConfirm } from "../lib/modal.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  loadProviders,
  addProvider,
  removeProvider,
  setActive,
  setRelay,
  credentialFor,
  PROMO_ID,
} from "../providers.js";
import { relayCaption } from "../lib/aiRelay.js";
import {
  BUILT_IN_LABEL,
  PROVIDER_SUBTITLE,
  PROVIDER_TITLE,
  UNAVAILABLE_MESSAGE,
  fetchFreeAiStatus,
  freeAiEntryView,
  mintFreeAiCredential,
} from "../lib/freeAi.js";

registerView("view-build-key");

// The caller's callback for the chosen credential + a back target.
let onChosenCb = null;
let backView = "view-build-source";
let savedCount = 0;
// The box the build will run on (named in the free AI pass), when known.
let targetFqdn = "";

// Keys are ALWAYS masked in any slug/list — only the typed input ever holds
// the plaintext.
function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "••••";
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

// One-tap recall slug: provider · "label" · masked key. Never the full key.
function slugFor(e) {
  return `${escapeHtml(e.provider)} · “${escapeHtml(e.label)}” · ${escapeHtml(maskKey(e.apiKey))}`;
}

/** The saved keys, the last-used one first. */
export function orderedEntries(entries, activeId) {
  const active = (entries || []).find((e) => e.id === activeId);
  if (!active) return (entries || []).slice();
  return [active, ...entries.filter((e) => e.id !== active.id)];
}

export const DELETE_TITLE = "Delete this key?";

export function deleteMessage(label) {
  return `${label} will be removed from this browser. Builds that are already running keep working.`;
}

async function chooseEntry(e) {
  if (typeof onChosenCb !== "function") return;
  const session = getSession();
  if (session.umk) {
    try {
      await setActive(session.umk, e.id);
    } catch {
      // the last-used marker is a convenience; the choice still stands
    }
  }
  onChosenCb(credentialFor(e));
}

/**
 * What the Flagship Inference row shows for a status read: "use" (with
 * what's left) or "blocked" (used up, busy today, no running server,
 * unavailable, ended) with the reason. Exported for tests.
 */
export function freeAiRowState(status) {
  const view = freeAiEntryView(status);
  return { kind: view.usable ? "use" : "blocked", text: view.text };
}

/** Skip the step and build on free AI: no saved keys, and some credits left. */
export function shouldAutoUseFreeAi(savedEntries, status) {
  return (savedEntries || []).length === 0 && freeAiRowState(status).kind === "use";
}

async function chooseFreeAi() {
  if (typeof onChosenCb !== "function") return;
  try {
    const { credential } = await mintFreeAiCredential(targetFqdn);
    const session = getSession();
    if (session.umk) {
      try {
        await setActive(session.umk, PROMO_ID);
      } catch {
        // the last-used marker is a convenience; the choice still stands
      }
    }
    onChosenCb(credential);
  } catch (e) {
    toast(e.message || UNAVAILABLE_MESSAGE, "err");
    showForm(true);
    await renderSaved({ autoFreeAi: false });
  }
}

/** The built-in Flagship Inference row: no delete, "Use this" only when usable. Exported for tests. */
export function freeAiRowHtml(state, { lastUsed = false } = {}) {
  const use = state.kind === "use";
  return `
      <div class="card mt-2 build-key-row${use ? "" : " is-disabled"}" id="build-key-free-ai" role="group" aria-label="${escapeHtml(BUILT_IN_LABEL)}">
        <div class="build-key-row-body">
          <strong>${escapeHtml(PROVIDER_TITLE)}</strong>
          <span class="note">${escapeHtml(PROVIDER_SUBTITLE)}</span>
          <span class="note" id="build-key-free-ai-status">${escapeHtml(state.text)}</span>
          ${lastUsed ? '<span class="note">Last used</span>' : ""}
        </div>
        ${use ? `<button class="build-key-use" id="build-key-free-ai-use" aria-label="Use ${escapeHtml(PROVIDER_TITLE)}">Use this</button>` : ""}
      </div>`;
}

async function confirmDelete(e) {
  const ok = await inlineConfirm({
    title: DELETE_TITLE,
    message: deleteMessage(e.label),
    okLabel: "Delete key",
    danger: true,
  });
  if (!ok) return;
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  try {
    await removeProvider(session.umk, e.id);
  } catch (err) {
    toast(humanError(err), "err");
  }
  await renderSaved();
}

async function renderSaved({ autoFreeAi = false } = {}) {
  const box = $("build-key-saved");
  if (!box) return;
  box.innerHTML = "";
  const session = getSession();
  if (!session.umk) {
    box.innerHTML = '<div class="card placeholder">Unlock first.</div>';
    return;
  }
  let stored;
  try {
    stored = await loadProviders(session.umk);
  } catch {
    stored = { entries: [], activeId: PROMO_ID };
  }
  const entries = stored.entries || [];
  savedCount = entries.length;
  const status = await fetchFreeAiStatus();
  if (autoFreeAi && shouldAutoUseFreeAi(entries, status)) {
    toast("Using Flagship Inference", "info");
    await chooseFreeAi();
    return;
  }
  const freeRow = freeAiRowHtml(freeAiRowState(status), {
    lastUsed: entries.length > 0 && stored.activeId === PROMO_ID,
  });
  $("bk-cancel")?.classList.toggle("hidden", savedCount === 0);
  if (entries.length === 0) {
    box.innerHTML = freeRow;
    $("build-key-free-ai-use")?.addEventListener("click", () => void chooseFreeAi());
    if (freeAiRowState(status).kind !== "use") showForm(true);
    return;
  }

  box.innerHTML =
    freeRow +
    `<p class="note build-section-caption">Saved keys</p>` +
    orderedEntries(entries, stored.activeId)
      .map(
        (e) => `
      <div class="card mt-2 build-key-row">
        <div class="build-key-row-body">
          <strong>${escapeHtml(e.label)}</strong>
          <span class="value text-sm">${slugFor(e)}</span>
          ${e.id === stored.activeId ? '<span class="note">Last used</span>' : ""}
          ${relaySwitch(e)}
        </div>
        <button class="build-key-delete" data-delete-id="${escapeHtml(e.id)}" aria-label="Delete ${escapeHtml(e.label)}">🗑</button>
        <button class="build-key-use" data-use-id="${escapeHtml(e.id)}">Use this</button>
      </div>`,
      )
      .join("");

  $("build-key-free-ai-use")?.addEventListener("click", () => void chooseFreeAi());
  const byId = (id) => entries.find((e) => e.id === id);
  box.querySelectorAll("[data-use-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = byId(btn.getAttribute("data-use-id"));
      if (entry) void chooseEntry(entry);
    });
  });
  box.querySelectorAll("[data-relay-id]").forEach((input) => {
    input.addEventListener("change", () => {
      void changeRelay(input.getAttribute("data-relay-id"), input.checked);
    });
  });
  box.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = byId(btn.getAttribute("data-delete-id"));
      if (entry) void confirmDelete(entry);
    });
  });
}

/** The row's relay switch, captioned with what the key does now. */
export function relaySwitch(e) {
  const on = e.relay !== false;
  return `<label class="inline-check build-key-relay">
            <input type="checkbox" role="switch" data-relay-id="${escapeHtml(e.id)}"${on ? " checked" : ""} />
            <span class="note">${escapeHtml(relayCaption(on))}</span>
          </label>`;
}

async function changeRelay(id, relay) {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  try {
    await setRelay(session.umk, id, relay);
  } catch (err) {
    toast(humanError(err), "err");
  }
  await renderSaved();
}

function showForm(visible) {
  $("build-key-form")?.classList.toggle("hidden", !visible);
  $("build-key-add")?.classList.toggle("hidden", visible);
}

// Save the form's key to the list and close the form. Choosing a key is a
// separate step, so adding one never moves the flow on.
async function addFromForm() {
  const session = getSession();
  if (!session.umk) return toast("Unlock first", "err");
  const provider = $("bk-provider").value;
  const apiKey = $("bk-key").value.trim();
  const baseUrl = $("bk-base").value.trim();
  const label = $("bk-label").value.trim();
  const relay = $("bk-relay") ? $("bk-relay").checked : true;
  if (!apiKey) return toast("Enter an API key.", "err");
  try {
    const added = await addProvider(session.umk, {
      provider,
      label: label || provider,
      apiKey,
      baseUrl: baseUrl || undefined,
      relay,
    });
    await setActive(session.umk, added.id);
  } catch (e) {
    return toast(humanError(e), "err");
  }
  clearForm();
  showForm(false);
  await renderSaved();
}

function clearForm() {
  $("bk-key").value = "";
  $("bk-base").value = "";
  $("bk-label").value = "";
  if ($("bk-relay")) $("bk-relay").checked = true;
}

export function initBuildKeyView() {
  $("build-key-add")?.addEventListener("click", () => {
    clearForm();
    showForm(true);
  });
  $("bk-cancel")?.addEventListener("click", () => {
    clearForm();
    showForm(false);
  });
  $("bk-add")?.addEventListener("click", () => {
    addFromForm().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  $("build-key-back")?.addEventListener("click", () => show(backView));
}

// Open the key step.
//   onChosen   — called with the in-memory { provider, apiKey, baseUrl?, relay }
//                (a free AI pass also carries source "promo" and model)
//   back       — view id for the back button (default: the chooser)
//   serverFqdn — the box the build runs on, when known
// (contextLabel is still accepted from callers; the page no longer shows it.)
export function enterBuildKey({ onChosen, back, serverFqdn } = {}) {
  onChosenCb = onChosen ?? null;
  backView = back || "view-build-source";
  targetFqdn = serverFqdn || "";
  clearForm();
  showForm(false);
  show("view-build-key");
  void renderSaved({ autoFreeAi: true });
}
