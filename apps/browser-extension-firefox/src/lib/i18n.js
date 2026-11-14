// Every user string comes from _locales (built from i18n/browser-extension by scripts/i18n-browser-extension.mjs).

export function t(key, ...args) {
  return browser.i18n.getMessage(key, args.map((a) => String(a))) || key;
}

/** Fill `data-i18n` (text) and `data-i18n-<attr>` (attributes) under `root` from the catalog. */
export function localize(root = document) {
  document.documentElement.lang = browser.i18n.getUILanguage();
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
  for (const attr of ["title", "aria-label", "alt"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}
