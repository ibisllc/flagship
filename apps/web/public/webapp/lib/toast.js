// Unified toast surface for the webapp. P2.14 in the cycle plan calls
// for unifying error handling across views — toast() is that surface.
// Auto-hides after 3s; an `err` / `ok` / `warn` kind tints the bubble
// and prepends the matching Lucide icon (Task #45).

import { TOAST_ICONS } from "./icons.js";

let toastTimer = null;

export function toast(text, kind) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.classList.remove("hidden", "err", "ok", "warn");
  const icon = TOAST_ICONS[kind];
  if (icon) {
    el.innerHTML = `<span class="icon">${icon}</span><span>${escapeText(text)}</span>`;
    el.classList.add(kind);
  } else {
    el.textContent = text;
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
