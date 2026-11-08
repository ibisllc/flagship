/*
 * Shared light/dark theme controller for every public page.
 *
 * Loaded blocking in <head> (just before </head>) so the theme is applied
 * before first paint — no flash. Palette + logo colours live in tokens.css;
 * theme-ui.css adds the logo + toggle styles. A floating toggle is auto-injected on any
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
    // The button keeps its page's own label ("Switch theme", translated by scripts/i18n-web.mjs);
    // the state is aria-pressed, so no English is written into a translated page.
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", t === "dark" ? "true" : "false");
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
    if (document.querySelector("[data-theme-toggle]")) { apply(root.getAttribute("data-theme") === "dark" ? "dark" : "light"); return; }
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

/*
 * Mirror domains (fshp.tech, fshp.app). Most public pages are answered straight
 * from the assets layer without running the Worker (run_worker_first in
 * apps/com/wrangler.toml), so the Worker's mirror pass (apps/com/src/mirrorDomains.ts)
 * never sees them. This repeats it in the page; keep the two in step.
 */
(function () {
  "use strict";
  var MIRRORS = ["fshp.tech", "fshp.app"];
  var CONTROL = "flagshipserver.com";
  var SERVICES = "flagship.services";
  var CONTROL_SUBHOSTS = { webapp: 1, remote: 1, recovery: 1, boot: 1, web: 1 };

  var host = location.hostname.toLowerCase().replace(/\.$/, "");
  var apex = null;
  var sub = "";
  for (var i = 0; i < MIRRORS.length; i++) {
    var m = MIRRORS[i];
    if (host === m) { apex = m; break; }
    if (host.slice(-(m.length + 1)) === "." + m) { apex = m; sub = host.slice(0, -(m.length + 1)); break; }
  }
  if (!apex) return;

  if (sub) {
    var target = sub === "www" ? apex : CONTROL_SUBHOSTS[sub] ? sub + "." + CONTROL : sub + "." + SERVICES;
    location.replace("https://" + target + location.pathname + location.search + location.hash);
    return;
  }

  // Not after "@" (email addresses: the mirrors have no mail) and not inside a longer label.
  var DOMAINS = /(^|[^@\w-])(flagshipserver\.com|flagship\.services)(?![\w-])/gi;
  function swap(s) { return s.replace(DOMAINS, "$1" + apex); }

  function rewrite() {
    var walker = document.createTreeWalker(document.documentElement, 1 | 4);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) {
        var tag = node.parentNode && node.parentNode.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE") continue;
        var text = swap(node.nodeValue);
        if (text !== node.nodeValue) node.nodeValue = text;
      } else if (node.nodeName !== "SCRIPT" && node.nodeName !== "STYLE") {
        for (var j = 0; j < node.attributes.length; j++) {
          var a = node.attributes[j];
          var value = swap(a.value);
          if (value !== a.value) node.setAttribute(a.name, value);
        }
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rewrite);
  } else {
    rewrite();
  }
})();
