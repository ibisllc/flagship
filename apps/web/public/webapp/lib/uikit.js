// WhatsApp-inspired list/settings/chip primitives for the webapp,
// mirroring the iOS FlagshipUI names + semantics
// (apps/mobile/ios/Sources/FlagshipUI/Components/ComponentsList.swift)
// and built entirely on the shared design tokens (/tokens.css, the
// webapp restyles them in /style.css):
//
//   - fsInitials                  — first two alphanumerics, uppercased ("?")
//   - chipRow / chip              — horizontal scrollable filter pills
//   - searchField                 — rounded sunken input (magnifier + clear)
//   - monogram                    — teal circle with initials
//   - profileCard                 — account hero (monogram + name + chevron)
//   - announcementCard            — dismissible teal-tinted nudge (danger variant)
//   - settingsGroup / settingsRow — grouped rounded card + icon-square row
//   - listRow                     — leading status icon/monogram + title + meta
//
// Every helper is a PURE STRING BUILDER: it takes plain data and returns an
// HTML string with all caller-supplied (server-derived) text run through
// escapeHtml — never interpolated raw. The DOM is constructed by the views
// that assign the result to a container's innerHTML; the strings themselves
// carry no event handlers, so views attach behaviour by delegating off the
// data-* hooks below (data-chip, data-search-clear, data-row-action, …).
//
// Selected chip = teal-filled (--accent); unselected = surface + hairline
// border. One accent hue per surface, matching the design system.

import { escapeHtml } from "./util.js";
import { searchIcon, chevronRightIcon, xIcon } from "./icons.js";

/**
 * The initials shown in a monogram: the first two alphanumeric characters
 * of `name`, uppercased; `?` when the name has no alphanumerics. Byte-for-
 * byte the iOS `fsInitials` rule (Theme.swift) so the avatar reads the same
 * on every surface.
 * @param {string} name
 * @returns {string}
 */
export function fsInitials(name) {
  const letters = String(name ?? "").match(/[a-z0-9]/gi) ?? [];
  const prefix = letters.slice(0, 2).join("");
  return prefix ? prefix.toUpperCase() : "?";
}

// ── Chips ────────────────────────────────────────────────────────────

/**
 * One filter pill. Selected → teal-filled with on-accent text; unselected →
 * surface with a hairline border. The view binds clicks by delegating off
 * `[data-chip]` (value carried in `data-chip-value`).
 *
 * @param {{ value:string, label:string, selected?:boolean, count?:number|null }} opt
 * @returns {string}
 */
export function chip({ value, label, selected = false, count = null }) {
  const countHtml =
    count != null
      ? ` <span class="fs-chip-count">${escapeHtml(String(count))}</span>`
      : "";
  return `<button type="button" class="fs-chip${selected ? " is-selected" : ""}" ` +
    `data-chip data-chip-value="${escapeHtml(String(value))}" ` +
    `role="tab" aria-selected="${selected ? "true" : "false"}">` +
    `${escapeHtml(String(label))}${countHtml}</button>`;
}

/**
 * A horizontal, scrollable row of filter pills. `items` is an array of
 * `{ value, label, count? }`; `selected` is the currently-active value.
 *
 * @param {{ items: Array<{value:string,label:string,count?:number|null}>, selected:string, ariaLabel?:string }} opt
 * @returns {string}
 */
export function chipRow({ items, selected, ariaLabel = "Filter" }) {
  const pills = (items ?? [])
    .map((it) => chip({ ...it, selected: it.value === selected }))
    .join("");
  return `<div class="fs-chip-row" role="tablist" aria-label="${escapeHtml(ariaLabel)}">${pills}</div>`;
}

// ── Search field ─────────────────────────────────────────────────────

/**
 * A rounded, sunken search input: a magnifier glyph, the text field, and a
 * clear ("x") button. The view reads the value off the `<input data-search>`
 * and clears it by delegating off `[data-search-clear]`.
 *
 * @param {{ value?:string, placeholder?:string, id?:string }} [opt]
 * @returns {string}
 */
export function searchField({ value = "", placeholder = "Search", id } = {}) {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  const hasText = String(value).length > 0;
  return `
    <div class="fs-search">
      <span class="fs-search-icon icon" aria-hidden="true">${searchIcon}</span>
      <input${idAttr} class="fs-search-input" type="search" data-search
             value="${escapeHtml(String(value))}"
             placeholder="${escapeHtml(placeholder)}"
             autocomplete="off" autocapitalize="none" autocorrect="off"
             aria-label="${escapeHtml(placeholder)}" />
      <button type="button" class="fs-search-clear${hasText ? "" : " hidden"}"
              data-search-clear aria-label="Clear search">${xIcon}</button>
    </div>
  `;
}

// ── Monogram ─────────────────────────────────────────────────────────

/**
 * A circular teal monogram: the initials of `name` on a soft-teal fill.
 * `size` is a CSS length variant ("md" default, "lg" for the profile hero).
 *
 * @param {string} name
 * @param {{ size?: "sm"|"md"|"lg" }} [opt]
 * @returns {string}
 */
export function monogram(name, { size = "md" } = {}) {
  return `<span class="fs-monogram fs-monogram--${escapeHtml(size)}" aria-hidden="true">${escapeHtml(
    fsInitials(name),
  )}</span>`;
}

// ── Profile hero ─────────────────────────────────────────────────────

/**
 * A prominent account hero card: a teal monogram, the username (bold), a
 * subtitle (tier / status), and a trailing chevron. The view makes it
 * tappable by delegating off `[data-profile-card]`.
 *
 * @param {{ name:string, subtitle:string }} opt
 * @returns {string}
 */
export function profileCard({ name, subtitle }) {
  const display = name && String(name).length ? name : "Your account";
  return `
    <button type="button" class="fs-profile-card" data-profile-card>
      ${monogram(name, { size: "lg" })}
      <span class="fs-profile-body">
        <span class="fs-profile-name">${escapeHtml(String(display))}</span>
        <span class="fs-profile-subtitle">${escapeHtml(String(subtitle ?? ""))}</span>
      </span>
      <span class="fs-row-chevron icon" aria-hidden="true">${chevronRightIcon}</span>
    </button>
  `;
}

// ── Announcement ─────────────────────────────────────────────────────

/**
 * A dismissible, tinted rounded card: a leading icon (raw SVG body string),
 * a title, a body, an optional CTA, and an "x" to dismiss. The default tint
 * is the brand teal; `tone:"danger"` reuses the same shape in red for an
 * account-reset-class alert. The view wires the CTA off `[data-ann-cta]` and
 * the dismiss off `[data-ann-dismiss]`.
 *
 * @param {{ icon:string, title:string, message:string, ctaLabel?:string|null, dismissible?:boolean, tone?:"teal"|"danger", id?:string }} opt
 * @returns {string}
 */
export function announcementCard({
  icon,
  title,
  message,
  ctaLabel = null,
  dismissible = true,
  tone = "teal",
  id,
}) {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  const toneClass = tone === "danger" ? " fs-announcement--danger" : "";
  const cta = ctaLabel
    ? `<button type="button" class="fs-announcement-cta" data-ann-cta>${escapeHtml(
        String(ctaLabel),
      )}</button>`
    : "";
  const dismiss = dismissible
    ? `<button type="button" class="fs-announcement-dismiss" data-ann-dismiss aria-label="Dismiss">${xIcon}</button>`
    : "";
  return `
    <div${idAttr} class="fs-announcement${toneClass}">
      <div class="fs-announcement-head">
        <span class="fs-announcement-icon icon" aria-hidden="true">${icon ?? ""}</span>
        <span class="fs-announcement-text">
          <span class="fs-announcement-title">${escapeHtml(String(title))}</span>
          <span class="fs-announcement-message">${escapeHtml(String(message))}</span>
        </span>
        ${dismiss}
      </div>
      ${cta}
    </div>
  `;
}

// ── Settings group + row ─────────────────────────────────────────────

/**
 * One settings row: a leading icon (raw SVG body) inside a soft-tinted
 * rounded square, a label, an optional subtitle, an optional trailing value
 * or numeric badge, and a chevron. The whole row is one tap target — the
 * view delegates off `[data-row-action]` (the action id is carried there).
 *
 * @param {{ icon:string, title:string, subtitle?:string, value?:string|null, badge?:number|null, action?:string|null, tone?:"teal"|"danger", chevron?:boolean }} opt
 * @returns {string}
 */
export function settingsRow({
  icon,
  title,
  subtitle = "",
  value = null,
  badge = null,
  action = null,
  tone = "teal",
  chevron = true,
}) {
  const actionAttr = action ? ` data-row-action="${escapeHtml(action)}"` : "";
  const toneClass = tone === "danger" ? " fs-row-icon--danger" : "";
  const sub = subtitle
    ? `<span class="fs-row-subtitle">${escapeHtml(String(subtitle))}</span>`
    : "";
  const val =
    value != null && String(value).length
      ? `<span class="fs-row-value">${escapeHtml(String(value))}</span>`
      : "";
  const badgeHtml =
    badge != null && Number(badge) > 0
      ? `<span class="fs-row-badge">${escapeHtml(String(badge))}</span>`
      : "";
  const chev = chevron
    ? `<span class="fs-row-chevron icon" aria-hidden="true">${chevronRightIcon}</span>`
    : "";
  return `
    <button type="button" class="fs-row"${actionAttr}>
      <span class="fs-row-icon${toneClass} icon" aria-hidden="true">${icon ?? ""}</span>
      <span class="fs-row-body">
        <span class="fs-row-title">${escapeHtml(String(title))}</span>
        ${sub}
      </span>
      ${val}
      ${badgeHtml}
      ${chev}
    </button>
  `;
}

/**
 * A grouped, rounded settings section: an optional small-caps header label
 * and a stack of `settingsRow(...)` strings stitched into one rounded card
 * (the CSS draws an inset hairline divider between rows).
 *
 * @param {{ header?:string|null, rows: string[] }} opt
 * @returns {string}
 */
export function settingsGroup({ header = null, rows }) {
  const head = header
    ? `<div class="fs-group-header">${escapeHtml(String(header))}</div>`
    : "";
  return `
    <div class="fs-group-section">
      ${head}
      <div class="fs-group">${(rows ?? []).join("")}</div>
    </div>
  `;
}

// ── Clean list row ───────────────────────────────────────────────────

/**
 * A clean, full-width list row: a leading status-tinted rounded-square icon
 * (or a monogram), a bold title, a muted subtitle, an optional mono detail
 * line, and a trailing accessory (a status pill / meta HTML string). The
 * view makes it tappable by delegating off `[data-row-action]`.
 *
 * `leading` is one of:
 *   { kind:"icon", svg, tone }   — SVG body on a soft tint of `tone`
 *   { kind:"monogram", name }    — a teal monogram
 *
 * `tone` selects the icon-square tint + dot semantics:
 *   "teal" | "success" | "warning" | "danger" | "muted".
 *
 * @param {{ leading:object, title:string, subtitle?:string, detail?:string, trailing?:string, action?:string|null }} opt
 * @returns {string}
 */
export function listRow({
  leading,
  title,
  subtitle = "",
  detail = "",
  trailing = "",
  action = null,
}) {
  const actionAttr = action ? ` data-row-action="${escapeHtml(action)}"` : "";
  let lead = "";
  if (leading?.kind === "monogram") {
    lead = monogram(leading.name, { size: "md" });
  } else {
    const tone = leading?.tone ?? "teal";
    lead = `<span class="fs-listrow-icon fs-listrow-icon--${escapeHtml(
      tone,
    )} icon" aria-hidden="true">${leading?.svg ?? ""}</span>`;
  }
  const sub = subtitle
    ? `<span class="fs-listrow-subtitle">${escapeHtml(String(subtitle))}</span>`
    : "";
  const det = detail
    ? `<span class="fs-listrow-detail mono">${escapeHtml(String(detail))}</span>`
    : "";
  // `trailing` is caller-built HTML (e.g. a .pill from the existing status
  // vocabulary), NOT user-derived text — callers must escape any dynamic
  // label they fold into it (renderServerCard does, via escapeHtml on c.label).
  const trail = trailing ? `<span class="fs-listrow-trailing">${trailing}</span>` : "";
  return `
    <div class="fs-listrow${action ? " fs-listrow--tappable" : ""}"${actionAttr}>
      ${lead}
      <span class="fs-listrow-body">
        <span class="fs-listrow-title">${escapeHtml(String(title))}</span>
        ${sub}
        ${det}
      </span>
      ${trail}
    </div>
  `;
}
