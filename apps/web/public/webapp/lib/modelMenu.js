// The AI model menu: which model (and how hard it thinks) drives a build.
//
// Two sources (docs/ai-inference-costs.md §15, wire types in
// packages/protocol/src/aiModels.ts):
//   - Flagship Inference: `.com`'s public catalog, GET /api/inference/models
//     (no box needed; cached 5 minutes).
//   - The owner's own key: the box asks the provider with the key,
//     POST /api/screens/ai/models { credential } (cached per key for the
//     app session, so a render never calls it).
// The choice rides start and every reply as `model` / `effort`. Settings
// keeps a default model per provider (providers.js), which starts a chat.

import { controlApex } from "./apex.js";
import { escapeHtml } from "./util.js";

export const FLAGSHIP_TITLE = "Flagship Inference";
export const UNKNOWN_NOTE = "capabilities unknown";
export const REFUSED_NOTE = "The key was refused";
export const PROVIDER_DEFAULT = "Provider default";
export const ATTACH_NOTICE = "The AI will see what you attach.";
export const SAMPLE_DATA_NOTICE = "Sample data goes only to the private test copy.";

const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = null;
const ownCache = new Map();

/** Forget cached menus (tests; a key was removed). */
export function clearModelMenuCache() {
  catalogCache = null;
  ownCache.clear();
}

function validCatalog(raw) {
  if (!raw || !Array.isArray(raw.models)) return null;
  const models = raw.models.filter((m) => m && typeof m.id === "string" && typeof m.label === "string");
  if (models.length === 0) return null;
  return { ...raw, models };
}

/** Flagship Inference's catalog, or null when it can't be read. */
export async function fetchInferenceCatalog({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (catalogCache && now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  try {
    const r = await fetchImpl(`${controlApex()}/api/inference/models`);
    if (!r.ok) return null;
    const value = validCatalog(await r.json());
    if (value) catalogCache = { at: now(), value };
    return value;
  } catch {
    return null;
  }
}

export function isFlagshipCredential(c) {
  return !!c && c.provider === "flagship";
}

function cacheKey(c) {
  return `${c.provider}|${c.baseUrl || ""}|${c.apiKey || ""}`;
}

/**
 * The menu for a credential:
 *   { kind: "flagship", catalog }                       catalog null ⇒ unreadable
 *   { kind: "own", listed, models, defaultModel?, reason? }
 * null without a credential. `boxFetch(path, init)` reaches the build's box.
 */
export async function loadModelMenu(credential, boxFetch, opts = {}) {
  if (!credential) return null;
  if (isFlagshipCredential(credential)) {
    return { kind: "flagship", catalog: await fetchInferenceCatalog(opts) };
  }
  const key = cacheKey(credential);
  if (ownCache.has(key)) return ownCache.get(key);
  try {
    const r = await boxFetch("/api/screens/ai/models", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
    if (r?.kind === "own") {
      const menu = {
        kind: "own",
        listed: r.listed === true && Array.isArray(r.models) && r.models.length > 0,
        models: Array.isArray(r.models) ? r.models.filter((m) => m && typeof m.id === "string") : [],
        ...(typeof r.defaultModel === "string" ? { defaultModel: r.defaultModel } : {}),
        ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
      };
      ownCache.set(key, menu);
      return menu;
    }
    if (r?.kind === "flagship") return { kind: "flagship", catalog: validCatalog(r.catalog) };
  } catch {
    // An older box has no model list: a free-text field still works.
  }
  return { kind: "own", listed: false, models: [], reason: "failed" };
}

/** The row for a model id in a menu, or null. */
export function optionFor(menu, id) {
  if (!menu || !id) return null;
  const list = menu.kind === "flagship" ? menu.catalog?.models ?? [] : menu.models ?? [];
  return list.find((m) => m.id === id) ?? null;
}

/** "Low 1× (Qwen3.6-35B-A3B)" → "Low 1×"; an own model's label. */
export function shortName(menu, id) {
  if (menu?.kind === "flagship") {
    const m = optionFor(menu, id);
    return m ? m.label.replace(/\s*\([^)]*\)\s*$/, "") : FLAGSHIP_TITLE;
  }
  const m = optionFor(menu, id);
  return m?.label || id || PROVIDER_DEFAULT;
}

/** A provider's effort word as a menu shows it: "xhigh" → "Extra high". */
export function effortLabel(e) {
  const s = String(e ?? "");
  if (s === "xhigh") return "Extra high";
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** 2 → "2×", 3.5 → "3.5×". */
export function multiplierText(n) {
  return `${Number(n)}×`;
}

/** The muted line under a reply: "used 2.8 credits", "used 1 credit". */
export function creditsUsedText(credits) {
  const n = Math.round(Number(credits) * 10) / 10;
  return `used ${String(n)} credit${n === 1 ? "" : "s"}`;
}

export function effortFor(opt, wanted) {
  if (!opt?.efforts?.length) return null;
  if (wanted && opt.efforts.includes(wanted)) return wanted;
  return opt.defaultEffort && opt.efforts.includes(opt.defaultEffort) ? opt.defaultEffort : null;
}

/**
 * Where a chat starts: the saved default when the menu has it, else the
 * menu's own default. `{ model, effort }`. An effort is offered only for a
 * model that lists effort levels; nothing is assumed for Flagship Inference.
 */
export function initialChoice(menu, saved = {}) {
  const none = { model: null, effort: null };
  if (!menu) return none;
  if (menu.kind === "flagship") {
    if (!menu.catalog) return none;
    const model = optionFor(menu, saved.model) ? saved.model : menu.catalog.defaultModel ?? menu.catalog.models[0]?.id ?? null;
    return { model, effort: effortFor(optionFor(menu, model), saved.effort) };
  }
  if (!menu.listed) return { ...none, model: saved.model || menu.defaultModel || null };
  const opt = optionFor(menu, saved.model) ?? optionFor(menu, menu.defaultModel);
  if (!opt) return { ...none, model: saved.model || menu.defaultModel || null };
  return { model: opt.id, effort: effortFor(opt, saved.effort) };
}

/** The choice after picking another model: effort back to that model's default. */
export function withModel(menu, _choice, id) {
  return { model: id || null, effort: effortFor(optionFor(menu, id), null) };
}

/**
 * The `model` / `effort` fields for start (`reply: false`) or a reply. A
 * reply always says the effort (null = the provider's default); start leaves
 * it out instead.
 */
export function wireChoice(menu, choice, { reply = false } = {}) {
  const out = {};
  if (!menu || !choice?.model) return out;
  if (menu.kind === "flagship" && !menu.catalog) return out;
  out.model = choice.model;
  const effort = choice.effort || null;
  if (effort) out.effort = effort;
  else if (reply) out.effort = null;
  return out;
}

/**
 * Before sending images: can the current model see them?
 *   { kind: "ok" } | { kind: "switch", to, message } | { kind: "blocked", message }
 */
export function visionCheck(menu, choice, attachments) {
  const ok = { kind: "ok" };
  if (!(attachments || []).some((a) => a?.kind === "image")) return ok;
  const opt = optionFor(menu, choice?.model);
  if (!opt) return ok;
  if (menu.kind === "flagship") {
    if ((opt.modalities || []).includes("image")) return ok;
    const alt = optionFor(menu, opt.visionAlternative);
    if (alt) {
      return { kind: "switch", to: alt.id, message: `I'll have to switch to ${alt.model} (${multiplierText(alt.multiplier)}) for this.` };
    }
    return { kind: "blocked", message: `${opt.model} can't see images. Remove them or pick another model.` };
  }
  if (opt.vision !== false) return ok;
  if (opt.visionAlternative) {
    const alt = optionFor(menu, opt.visionAlternative);
    return { kind: "switch", to: opt.visionAlternative, message: `I'll have to switch to ${alt?.label || opt.visionAlternative} for this.` };
  }
  return { kind: "blocked", message: `${opt.label || opt.id} can't see images. Remove them or pick another model.` };
}

// ---- attachments (mirror packages/server-daemon/src/llm/vibeCodeAttachments.ts) ----

export const MAX_ATTACHMENTS = 6;
const MB = 1024 * 1024;
export const ATTACHMENT_LIMITS = {
  image: { bytes: 4 * MB, text: "4 MB", noun: "images" },
  text: { bytes: 256 * 1024, text: "256 KB", noun: "text files" },
  data: { bytes: 2 * MB, text: "2 MB", noun: "CSV and JSON files" },
  document: { bytes: 10 * MB, text: "10 MB", noun: "PDFs" },
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const IMAGE_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "sql", "log",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "php",
  "c", "h", "cpp", "cs", "sh", "html", "css", "scss", "vue", "svelte",
  "yaml", "yml", "toml", "ini", "xml", "conf", "dockerfile",
];

/** The file picker's `accept` list. */
export const ACCEPT = [
  "image/png", "image/jpeg", "image/gif", "image/webp",
  ".csv", ".json", ".pdf",
  ...TEXT_EXTENSIONS.map((e) => `.${e}`),
].join(",");

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * Which attachment a file becomes: `{ kind, mediaType? }`, or `{ error }`
 * worded for the owner (unsupported, or over its kind's limit).
 */
export function classifyFile({ name, type, size }) {
  const e = ext(name);
  const t = String(type || "").toLowerCase();
  let kind = null;
  let mediaType;
  if (IMAGE_TYPES.has(t) || IMAGE_EXT[e]) {
    kind = "image";
    mediaType = IMAGE_TYPES.has(t) ? (t === "image/jpg" ? "image/jpeg" : t) : IMAGE_EXT[e];
  } else if (e === "pdf" || t === "application/pdf") {
    kind = "document";
    mediaType = "application/pdf";
  } else if (e === "csv" || t === "text/csv") {
    kind = "data";
    mediaType = "text/csv";
  } else if (e === "json" || t === "application/json") {
    kind = "data";
    mediaType = "application/json";
  } else if (TEXT_EXTENSIONS.includes(e) || t.startsWith("text/")) {
    kind = "text";
  }
  if (!kind) {
    return { error: `"${name}" can't be attached. Try an image, a text or code file, CSV, JSON or a PDF.` };
  }
  const limit = ATTACHMENT_LIMITS[kind];
  if (Number(size) > limit.bytes) {
    return { error: `"${name}" is too big: ${limit.noun} can be up to ${limit.text}.` };
  }
  return mediaType ? { kind, mediaType } : { kind };
}

/** A JSON sample the box would refuse, worded for the owner; else null. */
export function dataTextError(name, mediaType, text) {
  if (mediaType !== "application/json") return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return `"${name}" isn't valid JSON.`;
  }
}

export function attachmentIcon(kind) {
  if (kind === "data") return "📊";
  if (kind === "document") return "📑";
  return "📄";
}

/** The notice by the staged files. */
export function attachNotice(staged) {
  const lines = [ATTACH_NOTICE];
  if ((staged || []).some((a) => a?.kind === "data")) lines.push(SAMPLE_DATA_NOTICE);
  return lines;
}

// ---- the menu itself -----------------------------------------------------

export function rowSub(menu, m) {
  if (menu.kind === "flagship") return m.descriptor || "";
  if (m.known === false) return UNKNOWN_NOTE;
  const parts = [];
  if (m.contextTokens) parts.push(`${Math.round(m.contextTokens / 1000)}K context`);
  if (m.vision === true) parts.push("sees images");
  else if (m.vision === false) parts.push("text only");
  return parts.join(" · ");
}

/** The trigger's text for a choice. */
export function triggerText(menu, choice, { fallback = PROVIDER_DEFAULT } = {}) {
  if (menu?.kind === "flagship") return menu.catalog ? shortName(menu, choice?.model) : FLAGSHIP_TITLE;
  if (!menu) return choice?.model || fallback;
  return choice?.model ? shortName(menu, choice.model) : fallback;
}

/** The open panel's markup. Exported for tests. */
export function menuPanelHtml(menu, choice) {
  if (!menu) return `<div class="mm-loading note">Loading models…</div>`;
  if (menu.kind === "flagship") {
    if (!menu.catalog) return `<div class="mm-head">${escapeHtml(FLAGSHIP_TITLE)}</div>`;
    return `<div class="mm-head">${escapeHtml(FLAGSHIP_TITLE)}</div>${menu.catalog.models.map((m) => rowHtml(menu, m, choice)).join("")}`;
  }
  if (!menu.listed) {
    return `
      <label class="mm-free">
        <span class="field-label">Model</span>
        <input type="text" data-mm-free autocapitalize="none" autocorrect="off" spellcheck="false"
               value="${escapeHtml(choice?.model || menu.defaultModel || "")}" placeholder="model id">
      </label>
      ${menu.reason === "rejected" ? `<p class="note mm-muted">${escapeHtml(REFUSED_NOTE)}</p>` : ""}`;
  }
  return menu.models.map((m) => rowHtml(menu, m, choice)).join("");
}

export function rowHtml(menu, m, choice, attrs = "") {
  const selected = m.id === choice?.model;
  const sub = rowSub(menu, m);
  return `
    <button type="button" class="mm-row${selected ? " is-selected" : ""}" role="option" aria-selected="${selected}" data-mm-model="${escapeHtml(m.id)}"${attrs}>
      <span class="mm-row-label">${escapeHtml(m.label || m.id)}</span>
      ${sub ? `<span class="mm-row-sub${m.known === false ? " mm-muted" : ""}">${escapeHtml(sub)}</span>` : ""}
    </button>`;
}

/** The effort picker for a model that lists `efforts`, else "". */
export function effortPickerHtml(menu, choice) {
  const opt = optionFor(menu, choice?.model);
  if (!opt?.efforts?.length) return "";
  return `<select class="mm-effort" data-mm-effort aria-label="Effort">${opt.efforts
    .map((e) => `<option value="${escapeHtml(e)}"${e === choice?.effort ? " selected" : ""}>${escapeHtml(effortLabel(e))}</option>`)
    .join("")}</select>`;
}

/** A note under the trigger for an unknown model, else "". */
export function unknownNoteHtml(menu, choice) {
  if (menu?.kind !== "own") return "";
  return optionFor(menu, choice?.model)?.known === false ? `<span class="note mm-muted mm-note">${escapeHtml(UNKNOWN_NOTE)}</span>` : "";
}

/**
 * Mount a compact model menu in `host`.
 *   menu        — a loaded menu, or null with `load` to fetch it on first open
 *   choice      — { model, effort }
 *   onChange    — called with the new choice
 *   effort      — show the effort picker
 *   fallback    — trigger text with no model chosen
 * Returns { update(menu, choice) }.
 */
export function mountModelMenu(host, { menu = null, load = null, choice = {}, onChange = () => {}, effort = true, fallback = PROVIDER_DEFAULT } = {}) {
  let state = { menu, choice: { model: null, effort: null, ...choice } };
  let open = false;
  const set = (next) => {
    state.choice = next;
    render();
    onChange(next);
  };
  const close = () => {
    if (!open) return;
    open = false;
    render();
  };
  const onDoc = (ev) => {
    if (!host.isConnected) return document.removeEventListener("click", onDoc, true);
    if (!host.contains(ev.target)) close();
  };
  document.addEventListener("click", onDoc, true);

  function render() {
    const { menu: m, choice: c } = state;
    const fixed = m?.kind === "flagship" && !m.catalog;
    host.innerHTML = `
      <div class="mm${open ? " is-open" : ""}">
        <button type="button" class="mm-trigger" aria-haspopup="listbox" aria-expanded="${open}"${fixed ? " disabled" : ""}>
          <span class="mm-trigger-text">${escapeHtml(triggerText(m, c, { fallback }))}</span>${fixed ? "" : '<span class="mm-caret" aria-hidden="true">▾</span>'}
        </button>
        ${effort ? effortPickerHtml(m, c) : ""}
        ${unknownNoteHtml(m, c)}
        ${open ? `<div class="mm-panel" role="listbox">${menuPanelHtml(m, c)}</div>` : ""}
      </div>`;
    host.querySelector(".mm-trigger")?.addEventListener("click", async () => {
      open = !open;
      render();
      if (open && !state.menu && load) {
        state.menu = await load();
        if (open) render();
      }
    });
    host.querySelectorAll("[data-mm-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        open = false;
        set(withModel(state.menu, state.choice, btn.getAttribute("data-mm-model")));
      });
    });
    host.querySelector("[data-mm-free]")?.addEventListener("change", (ev) => {
      set({ model: ev.target.value.trim() || null, effort: null });
    });
    host.querySelector("[data-mm-effort]")?.addEventListener("change", (ev) => {
      set({ ...state.choice, effort: ev.target.value || null });
    });
    host.querySelector(".mm")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
  }
  render();
  return {
    update(nextMenu, nextChoice) {
      state = { menu: nextMenu, choice: { ...state.choice, ...(nextChoice || {}) } };
      render();
    },
  };
}
