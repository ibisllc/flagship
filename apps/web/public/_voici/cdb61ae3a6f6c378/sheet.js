// One modal sheet at a time: a bottom sheet on phones, a centred dialog on wider screens (design system §8.5).
// Esc and the close button close it; focus moves into it and back to where it came from.

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";

let open = null;

export function closeSheet() {
  open?.close();
}

/** o = {title, wide?, onClose?}. Returns {body, setTitle, close, el}. */
export function openSheet(doc, o) {
  closeSheet();
  const back = doc.activeElement;
  const titleEl = h(doc, "h2", { class: "sheet-title", id: "sheet-title" }, o.title);
  const body = h(doc, "div", { class: "sheet-body" });
  const closeBtn = h(doc, "button", { class: "icon-btn", type: "button", "aria-label": t("Close"), on: { click: () => api.close() } }, icon(doc, "close"));
  const panel = h(
    doc,
    "div",
    { class: o.wide ? "sheet sheet-wide" : "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheet-title", tabindex: "-1" },
    h(doc, "div", { class: "sheet-head" }, o.lead ?? null, titleEl, closeBtn),
    body,
  );
  const scrim = h(doc, "div", { class: "scrim", on: { click: (e) => e.target === scrim && api.close() } }, panel);
  const onKey = (e) => {
    if (e.key === "Escape") api.close();
  };
  const api = {
    el: panel,
    body,
    setTitle: (s) => replace(titleEl, s),
    close() {
      if (open !== api) return;
      open = null;
      doc.removeEventListener("keydown", onKey);
      scrim.remove();
      doc.body.classList.remove("has-sheet");
      o.onClose?.();
      if (back && typeof back.focus === "function") back.focus();
    },
  };
  doc.addEventListener("keydown", onKey);
  doc.body.appendChild(scrim);
  doc.body.classList.add("has-sheet");
  open = api;
  panel.focus();
  return api;
}
