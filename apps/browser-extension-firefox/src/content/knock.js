// On a Flagship site, look for a knock / sign-in page and say what the extension knows about it, in a bar at the top
// of the page (a closed shadow root, so the page's styles and scripts can't reach into it). The extension never
// signs the visitor in itself: the bar's button opens the page's own app link, which the owner's phone (or the
// webapp) signs with the visitor's identity for that one app.
(function () {
  "use strict";
  var detect = globalThis.FlagshipKnock && globalThis.FlagshipKnock.detectKnock;
  if (typeof detect !== "function") return;
  var shown = false;

  function hrefs() {
    var out = [];
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length && i < 500; i++) out.push(anchors[i].href);
    return out;
  }

  function msg(key, args) {
    return browser.i18n.getMessage(key, args || []) || key;
  }

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function show(found, status) {
    if (shown) return;
    shown = true;
    var host = document.createElement("div");
    host.setAttribute("data-flagship-extension", "");
    var root = host.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent =
      ":host{all:initial}" +
      ".bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;box-sizing:border-box;padding:10px 16px;" +
      "font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;" +
      "box-shadow:0 2px 12px rgba(0,0,0,.18)}" +
      ".ok{background:#ecfdf5;color:#064e3b}.info{background:#f1f5f9;color:#0f172a}.bad{background:#fef2f2;color:#7f1d1d}" +
      "@media (prefers-color-scheme: dark){.ok{background:#052e2b;color:#a7f3d0}.info{background:#1e293b;color:#e2e8f0}.bad{background:#450a0a;color:#fecaca}}" +
      ".txt{flex:1 1 280px}.txt b{display:block}" +
      "a.btn,button{font:inherit;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none}" +
      "a.btn{background:#14b8a6;color:#fff;font-weight:600}button{background:transparent;color:inherit;text-decoration:underline}";
    root.appendChild(style);
    var bar = el("div", null, "bar");
    var txt = el("div", null, "txt");
    var title;
    var body;
    var cls;
    var offer = false;
    if (found.kind === "foreign") {
      cls = "bad";
      title = msg("knockForeignTitle");
      body = msg("knockForeignBody", [found.site, location.hostname]);
    } else if (status && status.verdict === "match" && (found.bound || status.linkServerVerified)) {
      cls = "ok";
      title = msg("knockVerifiedTitle");
      body = msg("knockVerifiedBody", [location.hostname]);
      offer = true;
    } else if (!found.bound) {
      cls = "info";
      title = msg("knockUncheckedTitle");
      body = msg("knockDirectUnboundBody", [found.link.server]);
      offer = true;
    } else if (status && status.serverDomain) {
      cls = "info";
      title = msg("knockUncheckedTitle");
      body = msg("knockStaleBody", [status.serverDomain]);
      offer = true;
    } else {
      cls = "info";
      title = msg("knockUncheckedTitle");
      body = msg(status && status.paired ? "knockNotYourServerBody" : "knockNotPairedBody");
      offer = true;
    }
    bar.className = "bar " + cls;
    txt.appendChild(el("b", title));
    txt.appendChild(el("span", body));
    bar.appendChild(txt);
    if (offer) {
      var a = el("a", msg("knockSignInButton"), "btn");
      a.href = found.link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      bar.appendChild(a);
    }
    var close = el("button", msg("knockDismiss"));
    close.addEventListener("click", function () { host.remove(); });
    bar.appendChild(close);
    root.appendChild(bar);
    document.documentElement.appendChild(host);
  }

  function run() {
    var found = detect(location.hostname, hrefs());
    if (!found) return false;
    browser.runtime
      .sendMessage({ type: "knock", server: found.link.server })
      .then(function (status) { show(found, status); })
      .catch(function () { show(found, null); });
    return true;
  }

  // The knock page sets its button's link from an inline script; look again briefly if it isn't there yet.
  if (!run()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (run() || tries >= 5) clearInterval(timer);
    }, 400);
  }
})();
