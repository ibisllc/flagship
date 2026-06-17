// Reusable AI-key step.
//
// A build path that drives the BOX's own model (start-from-scratch, the
// git-adapt pass) routes through here BEFORE it runs, so the owner can
// provide or confirm the AI key the box will use. Paths that do NOT use the
// box's model (marketplace install, IDE/MCP — which uses the user's own
// editor AI) skip this entirely.
//
// The credential the user picks is handed back IN MEMORY via onChosen; the
// raw key never touches flagshipserver.com. Saved keys live only in this
// device's IndexedDB (providers.js, AES-GCM wrapped under the UMK seed).
//
// Usage:
//   enterBuildKey({
//     contextLabel: "Start from scratch with AI",
//     onChosen: ({ provider, apiKey, baseUrl }) => { … },
//   });
//
// Built as a standalone view so attaching it to a new path later is a single
// enterBuildKey() call.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { loadProviders, addProvider, PROMO_ID } from "../providers.js";

registerView("view-build-key");

// The caller's callback for the chosen credential + a back target.
let onChosenCb = null;
let backView = "view-build-source";

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

function chooseEntry(e) {
  if (typeof onChosenCb !== "function") return;
  const cb = onChosenCb;
  const credential = { provider: e.provider, apiKey: e.apiKey };
  if (e.baseUrl) credential.baseUrl = e.baseUrl;
  cb(credential);
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
  if (entries.length === 0) {
    box.innerHTML =
      '<div class="card placeholder">No saved keys yet — add one below.</div>';
    return;
  }

  // Pre-select the active key with a clear Confirm affordance; the rest are
  // one-tap recall rows.
  const active = entries.find((e) => e.id === stored.activeId);
  let html = "";
  if (active) {
    html += `
      <div class="card is-active">
        <div class="weight-600">Confirm this key</div>
        <div class="value text-sm mt-1">${slugFor(active)}</div>
        <button class="full-width mt-2" data-confirm-id="${escapeHtml(active.id)}">Use ${slugFor(active)}</button>
      </div>`;
  }
  const others = entries.filter((e) => !active || e.id !== active.id);
  if (others.length > 0) {
    html += others
      .map(
        (e) => `
      <div class="card mt-2">
        <div class="row row-top">
          <div class="value text-sm">${slugFor(e)}</div>
          <button class="secondary" data-confirm-id="${escapeHtml(e.id)}">Use</button>
        </div>
      </div>`,
      )
      .join("");
  }
  box.innerHTML = html;

  box.querySelectorAll("[data-confirm-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-confirm-id");
      const entry = entries.find((e) => e.id === id);
      if (entry) chooseEntry(entry);
    });
  });
}

function showForm(visible) {
  $("build-key-form")?.classList.toggle("hidden", !visible);
}

async function useDifferentKey() {
  const session = getSession();
  if (!session.umk) return toast("unlock first", "err");
  const provider = $("bk-provider").value;
  const apiKey = $("bk-key").value;
  const baseUrl = $("bk-base").value.trim();
  const label = $("bk-label").value.trim();
  if (!apiKey) return toast("API key required", "err");

  // Save on this device (optional) — uses providers.js so it shows up in
  // Settings and at this step next time.
  if ($("bk-save")?.checked) {
    try {
      await addProvider(session.umk, {
        provider,
        label: label || provider,
        apiKey,
        baseUrl: baseUrl || undefined,
      });
      toast("key saved on this device", "ok");
    } catch (e) {
      return toast(e.message, "err");
    }
  }

  const credential = { provider, apiKey };
  if (baseUrl) credential.baseUrl = baseUrl;
  if (typeof onChosenCb === "function") onChosenCb(credential);
}

function clearForm() {
  $("bk-key").value = "";
  $("bk-base").value = "";
  $("bk-label").value = "";
  if ($("bk-save")) $("bk-save").checked = false;
}

export function initBuildKeyView() {
  $("build-key-different")?.addEventListener("click", () => showForm(true));
  $("bk-cancel")?.addEventListener("click", () => {
    clearForm();
    showForm(false);
  });
  $("bk-use")?.addEventListener("click", () => {
    useDifferentKey().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  $("build-key-back")?.addEventListener("click", () => show(backView));
}

// Open the key step.
//   contextLabel — a short line for why a key is needed ("Start from scratch…")
//   onChosen     — called with the in-memory { provider, apiKey, baseUrl? }
//   back         — view id for the back button (default: the chooser)
export function enterBuildKey({ contextLabel, onChosen, back } = {}) {
  onChosenCb = onChosen ?? null;
  backView = back || "view-build-source";
  const ctx = $("build-key-context");
  if (ctx && contextLabel) {
    ctx.textContent = `${contextLabel} uses your box's AI. Provide or confirm the AI key it should use.`;
  }
  clearForm();
  showForm(false);
  show("view-build-key");
  void renderSaved();
}
