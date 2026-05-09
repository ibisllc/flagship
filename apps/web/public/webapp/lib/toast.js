// Unified toast surface for the webapp. P2.14 in the cycle plan calls
// for unifying error handling across views — toast() is that surface.
// Auto-hides after 3s; an `err` kind tints the bubble red.

let toastTimer = null;

export function toast(text, kind) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden", "err");
  if (kind === "err") el.classList.add("err");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}
