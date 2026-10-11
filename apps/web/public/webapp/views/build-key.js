// Reusable AI-key step.
//
// A build path that drives the BOX's own model (start-from-scratch, the
// git-adapt pass) routes through here BEFORE it runs, so the owner can
// provide or confirm the AI key the box will use. Paths that do NOT use the
// box's model (marketplace install, IDE/MCP — which uses the user's own
// editor AI) skip this entirely.
//
// Adding and choosing are separate: "Add an API key" opens a form that saves
// the key to this device's list (and makes it the last-used one); each saved
// key has "Use this", which hands the credential back IN MEMORY via onChosen
// and moves the flow on, and a confirmed delete. The raw key never touches
// flagshipserver.com. Saved keys live only in this device's IndexedDB
// (providers.js, AES-GCM wrapped under the UMK seed).
//
// Usage:
//   enterBuildKey({
//     contextLabel: "Start from scratch with AI",
//     onChosen: ({ provider, apiKey, baseUrl }) => { … },
//   });
//
// MIRRORS: iOS BuildKeyScreen, Android AiKeyStepScreen.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { inlineConfirm } from "../lib/modal.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { loadProviders, addProvider, removeProvider, setActive, PROMO_ID } from "../providers.js";

registerView("view-build-key");

// The caller's callback for the chosen credential + a back target.
let onChosenCb = null;
let backView = "view-build-source";
let savedCount = 0;

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
  return `${label} will be removed from this phone. Builds that are already running keep working.`;
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
  const credential = { provider: e.provider, apiKey: e.apiKey };
  if (e.baseUrl) credential.baseUrl = e.baseUrl;
  onChosenCb(credential);
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

async function renderSaved() {
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
  $("bk-cancel")?.classList.toggle("hidden", savedCount === 0);
  if (entries.length === 0) {
    showForm(true);
    return;
  }

  box.innerHTML =
    `<p class="note build-section-caption">Saved keys</p>` +
    orderedEntries(entries, stored.activeId)
      .map(
        (e) => `
      <div class="card mt-2 build-key-row">
        <div class="build-key-row-body">
          <strong>${escapeHtml(e.label)}</strong>
          <span class="value text-sm">${slugFor(e)}</span>
          ${e.id === stored.activeId ? '<span class="note">Last used</span>' : ""}
        </div>
        <button class="build-key-delete" data-delete-id="${escapeHtml(e.id)}" aria-label="Delete ${escapeHtml(e.label)}">🗑</button>
        <button class="build-key-use" data-use-id="${escapeHtml(e.id)}">Use this</button>
      </div>`,
      )
      .join("");

  const byId = (id) => entries.find((e) => e.id === id);
  box.querySelectorAll("[data-use-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = byId(btn.getAttribute("data-use-id"));
      if (entry) void chooseEntry(entry);
    });
  });
  box.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = byId(btn.getAttribute("data-delete-id"));
      if (entry) void confirmDelete(entry);
    });
  });
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
  if (!apiKey) return toast("Enter an API key.", "err");
  try {
    const added = await addProvider(session.umk, {
      provider,
      label: label || provider,
      apiKey,
      baseUrl: baseUrl || undefined,
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
//   onChosen — called with the in-memory { provider, apiKey, baseUrl? }
//   back     — view id for the back button (default: the chooser)
// (contextLabel is still accepted from callers; the page no longer shows it.)
export function enterBuildKey({ onChosen, back } = {}) {
  onChosenCb = onChosen ?? null;
  backView = back || "view-build-source";
  clearForm();
  showForm(false);
  show("view-build-key");
  void renderSaved();
}
