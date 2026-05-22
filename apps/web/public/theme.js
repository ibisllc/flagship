/*
 * Shared light/dark theme controller for every public page.
 *
 * Loaded blocking in <head> (just before </head>) so the theme is applied
 * before first paint — no flash. Pairs with theme-ui.css, which carries the
 * palette + logo + toggle styles. A floating toggle is auto-injected on any
 * page that doesn't already ship its own [data-theme-toggle] control.
 */
(function () {
  "use strict";
  var root = document.documentElement;

  function stored() {
    try {
      var t = localStorage.getItem("fs-theme");
      if (t === "light" || t === "dark") return t;
    } catch (e) {}
    return "light";
  }

  function syncMeta(t) {
    var m = document.querySelector('meta[name="theme-color"]:not([media])');
    if (m) m.setAttribute("content", t === "dark" ? "#0A0A09" : "#FFFFFF");
  }

  function apply(t) {
    root.setAttribute("data-theme", t);
    syncMeta(t);
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
  }

  apply(stored());

  document.addEventListener("click", function (e) {
    var n = e.target;
    var btn = n && n.closest ? n.closest("[data-theme-toggle]") : null;
    if (!btn) return;
    e.preventDefault();
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem("fs-theme", next); } catch (e2) {}
    apply(next);
  });

  function injectFloating() {
    if (document.querySelector("[data-theme-toggle]")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "theme-btn theme-btn--floating";
    b.setAttribute("data-theme-toggle", "");
    b.setAttribute("aria-label", "Switch theme");
    b.innerHTML =
      '<svg class="theme-icon-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"/></svg>' +
      '<svg class="theme-icon-moon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>';
    document.body.appendChild(b);
    apply(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectFloating);
  } else {
    injectFloating();
  }
})();
