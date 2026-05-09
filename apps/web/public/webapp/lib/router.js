// Single-screen-at-a-time router for the webapp.
//
// Views register themselves with `registerView(id)` so the dispatcher
// table stays append-only — adding a P2 screen is a one-line change.
// `show(id)` toggles the `hidden` class on each registered section.

const VIEWS = new Set();

export function registerView(id) {
  VIEWS.add(id);
}

export function show(id) {
  for (const v of VIEWS) {
    const el = document.getElementById(v);
    if (el) el.classList.toggle("hidden", v !== id);
  }
}

export function listViews() {
  return [...VIEWS];
}

export function $(id) {
  return document.getElementById(id);
}

export function setSubtitle(text) {
  const el = $("subtitle");
  if (el) el.textContent = text;
}
