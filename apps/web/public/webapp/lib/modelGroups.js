// The build chat's model menu, grouped by provider: Flagship Inference first
// (when the owner can use it, or the chat already does), then every AI key
// saved on this device, each with its own models. Picking a model from
// another group switches the chat's provider: that group's key rides the
// next message and the box replaces the chat's key with it
// (docs/build-modes.md "Continuing a chat").
//
// MIRRORS: iOS ModelMenu.swift (grouped menu), Android core/AiModelMenu.kt.

import { credentialFor } from "../providers.js";
import {
  FLAGSHIP_TITLE,
  REFUSED_NOTE,
  effortLabel,
  optionFor,
  rowHtml,
  shortName,
  unknownNoteHtml,
  withModel,
} from "./modelMenu.js";
import { escapeHtml } from "./util.js";

export const FLAGSHIP_GROUP = "flagship";
export const CONTEXT_NOTICE = "Older messages will be summarised to fit this model.";
export const CHOOSE_MODEL = "Choose a model";

/** How a saved key is named in the menu. */
export function keyTitle(entry) {
  return `${entry.provider} · ${entry.label}`;
}

/**
 * The groups, in menu order:
 *   { id, title, kind: "flagship"|"own", entry?, menu }  (menu null until loaded)
 * `flagshipMenu` is Flagship Inference's `{kind:"flagship", catalog}`.
 */
export function buildGroups({ entries = [], flagshipUsable = false, flagshipMenu = null, currentProvider = null, unsaved = null } = {}) {
  const groups = [];
  if (flagshipUsable || currentProvider === "flagship") {
    groups.push({ id: FLAGSHIP_GROUP, title: FLAGSHIP_TITLE, kind: "flagship", menu: flagshipMenu });
  }
  for (const e of entries || []) {
    if (!e || e.provider === "flagship") continue;
    groups.push({ id: e.id, title: keyTitle(e), kind: "own", entry: e, menu: null });
  }
  // A key typed for this build but not saved on the device still gets its group.
  if (unsaved && unsaved.provider !== "flagship" && !groupForCredential(groups, unsaved)) {
    const entry = { id: UNSAVED_GROUP, provider: unsaved.provider, label: UNSAVED_LABEL, apiKey: unsaved.apiKey, relay: unsaved.relay !== false };
    if (unsaved.baseUrl) entry.baseUrl = unsaved.baseUrl;
    groups.push({ id: UNSAVED_GROUP, title: keyTitle(entry), kind: "own", entry, menu: null });
  }
  return groups;
}

export const UNSAVED_GROUP = "unsaved";
export const UNSAVED_LABEL = "Unsaved key";

export function groupById(groups, id) {
  return (groups || []).find((g) => g.id === id) ?? null;
}

/** The group a credential belongs to: Flagship Inference, or the saved key it came from. */
export function groupForCredential(groups, credential) {
  if (!credential) return null;
  if (credential.provider === "flagship") return groupById(groups, FLAGSHIP_GROUP);
  return (
    (groups || []).find(
      (g) =>
        g.kind === "own" &&
        g.entry.provider === credential.provider &&
        g.entry.apiKey === credential.apiKey &&
        (g.entry.baseUrl || "") === (credential.baseUrl || ""),
    ) ?? null
  );
}

/** For a reopened chat: the group of the provider the box says it uses (the first key of it). */
export function groupForProvider(groups, provider) {
  if (!provider) return null;
  if (provider === "flagship") return groupById(groups, FLAGSHIP_GROUP);
  return (groups || []).find((g) => g.kind === "own" && g.entry.provider === provider) ?? null;
}

/** The effort levels a model offers in a menu (Flagship: only what its catalog lists). */
export function effortOptions(menu, model) {
  const opt = optionFor(menu, model);
  return Array.isArray(opt?.efforts) ? opt.efforts.filter((e) => typeof e === "string" && e) : [];
}

/** The model's context window in a menu, when known. */
export function contextOf(menu, model) {
  const n = optionFor(menu, model)?.contextTokens;
  return typeof n === "number" && n > 0 ? n : null;
}

/**
 * Whether switching to a model may drop older context: the conversation is
 * past the box's compaction threshold for that model's context (75% of what
 * is left after the reply's room, as `contextCompaction.ts`).
 */
export function mayDropContext(conversationTokens, contextTokens) {
  if (!(conversationTokens > 0) || !(contextTokens > 0)) return false;
  const budget = contextTokens - Math.min(16000, Math.floor(contextTokens / 4));
  return conversationTokens > budget * 0.75;
}

/** The one-line notice under the menu, or null. */
export function contextNotice({ menu, choice, sessionModel, conversationTokens }) {
  if (!choice?.model || choice.model === sessionModel) return null;
  return mayDropContext(conversationTokens, contextOf(menu, choice.model)) ? CONTEXT_NOTICE : null;
}

/** The trigger's text: the model's short name, then the key's name for an own key. */
export function groupedTriggerText(group, choice) {
  if (!group) return choice?.model || CHOOSE_MODEL;
  const model = group.menu ? shortName(group.menu, choice?.model) : choice?.model || group.title;
  return group.kind === "own" ? `${model} · ${group.entry.label}` : model;
}

/**
 * The credential the next message carries, or null to let the box keep the
 * key it holds:
 *   - Flagship Inference: always a fresh pass (`mintFlagship()`).
 *   - an own key: when the owner picked it here (`picked`), when the box has
 *     no key (`needsCredential`), or on the chat's first message (`starting`).
 */
export async function credentialForMessage(group, { picked = false, needsCredential = false, starting = false, mintFlagship } = {}) {
  if (!group) return null;
  if (group.kind === "flagship") return mintFlagship ? mintFlagship() : null;
  if (picked || needsCredential || starting) return credentialFor(group.entry);
  return null;
}

/** The choice after picking `model` in `group`: that model's default effort. */
export function pickIn(group, model) {
  return { group: group?.id ?? null, ...withModel(group?.menu, null, model) };
}

function groupRowsHtml(group, choice) {
  const attrs = ` data-mm-group="${escapeHtml(group.id)}"`;
  const mine = choice?.group === group.id ? choice : null;
  const menu = group.menu;
  if (!menu) return `<div class="mm-loading note">Loading models…</div>`;
  if (menu.kind === "flagship") {
    if (!menu.catalog) return `<p class="note mm-muted mm-note">The models couldn't be listed right now.</p>`;
    return menu.catalog.models.map((m) => rowHtml(menu, m, mine, attrs)).join("");
  }
  if (!menu.listed) {
    return `
      <label class="mm-free">
        <span class="field-label">Model</span>
        <input type="text" data-mm-free${attrs} autocapitalize="none" autocorrect="off" spellcheck="false"
               value="${escapeHtml(mine?.model || menu.defaultModel || "")}" placeholder="model id">
      </label>
      ${menu.reason === "rejected" ? `<p class="note mm-muted">${escapeHtml(REFUSED_NOTE)}</p>` : ""}`;
  }
  return menu.models.map((m) => rowHtml(menu, m, mine, attrs)).join("");
}

/** The open panel: each group's title, then its models. Exported for tests. */
export function groupedPanelHtml(groups, choice) {
  if (!groups || groups.length === 0) return `<p class="note mm-muted mm-note">Add an AI key in Settings to pick a model.</p>`;
  return groups
    .map((g) => `<div class="mm-group" role="group" aria-label="${escapeHtml(g.title)}"><div class="mm-head">${escapeHtml(g.title)}</div>${groupRowsHtml(g, choice)}</div>`)
    .join("");
}

/** The effort picker beside the menu, only for a model that lists effort levels. */
export function groupedEffortHtml(group, choice) {
  const efforts = effortOptions(group?.menu, choice?.model);
  if (efforts.length === 0) return "";
  return `<select class="mm-effort" data-mm-effort aria-label="Effort">${efforts
    .map((e) => `<option value="${escapeHtml(e)}"${e === choice?.effort ? " selected" : ""}>${escapeHtml(effortLabel(e))}</option>`)
    .join("")}</select>`;
}

/**
 * Mount the grouped menu in `host`.
 *   groups    — buildGroups(); a group's `menu` may be null until loaded
 *   choice    — { group, model, effort }
 *   loadGroup — async (group) => menu, for unloaded groups when the panel opens
 *   onChange  — called with the new choice
 *   notice    — the context line, or null
 * Returns { update(groups, choice, notice) }.
 */
export function mountGroupedModelMenu(host, { groups = [], choice = {}, loadGroup = null, onChange = () => {}, notice = null } = {}) {
  let state = { groups, choice: { group: null, model: null, effort: null, ...choice }, notice };
  let open = false;
  const set = (next) => {
    state.choice = next;
    render();
    onChange(next);
  };
  const onDoc = (ev) => {
    if (!host.isConnected) return document.removeEventListener("click", onDoc, true);
    if (open && !host.contains(ev.target)) {
      open = false;
      render();
    }
  };
  document.addEventListener("click", onDoc, true);

  async function loadMissing() {
    if (!loadGroup) return;
    await Promise.all(
      state.groups
        .filter((g) => !g.menu)
        .map(async (g) => {
          g.menu = await loadGroup(g);
          if (open) render();
        }),
    );
  }

  function render() {
    const { groups: gs, choice: c, notice: n } = state;
    const group = groupById(gs, c.group);
    host.innerHTML = `
      <div class="mm${open ? " is-open" : ""}">
        <button type="button" class="mm-trigger" aria-haspopup="listbox" aria-expanded="${open}">
          <span class="mm-trigger-text">${escapeHtml(groupedTriggerText(group, c))}</span><span class="mm-caret" aria-hidden="true">▾</span>
        </button>
        ${groupedEffortHtml(group, c)}
        ${group?.menu ? unknownNoteHtml(group.menu, c) : ""}
        ${n ? `<p class="mm-context" role="status">${escapeHtml(n)}</p>` : ""}
        ${open ? `<div class="mm-panel" role="listbox">${groupedPanelHtml(gs, c)}</div>` : ""}
      </div>`;
    host.querySelector(".mm-trigger")?.addEventListener("click", () => {
      open = !open;
      render();
      if (open) void loadMissing();
    });
    host.querySelectorAll("[data-mm-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        open = false;
        set(pickIn(groupById(state.groups, btn.getAttribute("data-mm-group")), btn.getAttribute("data-mm-model")));
      });
    });
    host.querySelectorAll("[data-mm-free]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        set({ group: input.getAttribute("data-mm-group"), model: ev.target.value.trim() || null, effort: null });
      });
    });
    host.querySelector("[data-mm-effort]")?.addEventListener("change", (ev) => {
      set({ ...state.choice, effort: ev.target.value || null });
    });
    host.querySelector(".mm")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && open) {
        open = false;
        render();
      }
    });
  }
  render();
  return {
    update(nextGroups, nextChoice, nextNotice = null) {
      state = { groups: nextGroups ?? state.groups, choice: { ...state.choice, ...(nextChoice || {}) }, notice: nextNotice };
      render();
    },
  };
}
