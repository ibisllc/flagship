// Knock-page detection (docs/service-access-gating.md "Web-experience gating"). A classic script, not a module:
// the content script loads it first (content scripts can't be modules), the tests import it for its global.
//
// A box's knock / sign-in page carries the phone's app link https://<control apex>/access#server=&svc=&ref=&page=
// (the "Access site" button, and the same link as a QR). The page is genuine for the site it is on when the link
// names that site: `<svc>.<server>`, or `<server>` itself. A page that shows a sign-in link for ANOTHER site is
// the QR-login relay trick (someone wants your phone to sign their browser in as you), so it gets a warning and
// no sign-in offer. The extension never signs anything: the phone (or the webapp) signs the knock with the
// person's identity for that one app (`flagship/app-aid/v1`).
(function (root) {
  "use strict";
  // Keep in step with src/lib/config.js (a classic script can't import it).
  var CONTROL_APEX = "flagshipserver.com";
  var DATA_APEX = "flagship.services";
  var DIRECT_APEX = "fshp.app";
  var LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  var PAGE = /^[0-9a-f]{32}$/;
  var REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

  function normalizeHost(h) {
    h = String(h == null ? "" : h).trim().toLowerCase();
    while (h.charAt(h.length - 1) === ".") h = h.slice(0, -1);
    return h;
  }

  function isBoxName(host) {
    if (host.length <= DATA_APEX.length + 1 || host.slice(-(DATA_APEX.length + 1)) !== "." + DATA_APEX) return false;
    var labels = host.slice(0, -(DATA_APEX.length + 1)).split(".");
    if (labels.length !== 2) return false;
    return labels.every(function (l) { return LABEL.test(l); });
  }

  /**
   * An access link's fields, or null when `href` isn't one. `trusted` is false for a look-alike: the right path and
   * fields on a host other than the control apex.
   */
  function parseAccessLink(href) {
    var url;
    try { url = new URL(String(href)); } catch (e) { return null; }
    var isScheme = url.protocol === "flagship:" && (url.hostname === "access" || url.pathname.replace(/^\/+/, "") === "access");
    var path = url.pathname.replace(/\/+$/, "");
    if (!isScheme && !(url.protocol === "https:" && path === "/access")) return null;
    var q = url.hash.length > 1 ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
    var server = normalizeHost(q.get("server"));
    var svc = String(q.get("svc") || "").toLowerCase();
    var ref = String(q.get("ref") || "");
    var page = String(q.get("page") || "").toLowerCase();
    if (!server || !page) return null;
    var wellFormed = isBoxName(server) && (svc === "" || LABEL.test(svc)) && REF.test(ref) && PAGE.test(page);
    var trusted = wellFormed && !isScheme && normalizeHost(url.hostname) === CONTROL_APEX && url.port === "";
    return { server: server, svc: svc, ref: ref, page: page, trusted: trusted, href: url.href };
  }

  /** The site an access link signs a browser in to. */
  function siteOf(link) {
    return link.svc ? link.svc + "." + link.server : link.server;
  }

  /**
   * What the page at `host` is, from the links it shows:
   *   null                        no sign-in link here
   *   { kind: "knock", link }     a sign-in page for this very site (`bound: true`), or, on a direct name
   *                               (`*.fshp.app`, whose name doesn't say which server serves it), a sign-in page
   *                               for some server (`bound: false`): the background page then accepts it only
   *                               when this site's certificate is the one that server signed
   *   { kind: "foreign", link }   a sign-in link for another site, or a look-alike link: warn, offer nothing
   */
  function detectKnock(host, hrefs) {
    var here = normalizeHost(host);
    var direct = here.length > DIRECT_APEX.length + 1 && here.slice(-(DIRECT_APEX.length + 1)) === "." + DIRECT_APEX;
    var found = null;
    var list = Array.isArray(hrefs) ? hrefs : [];
    for (var i = 0; i < list.length; i++) {
      var link = parseAccessLink(list[i]);
      if (!link) continue;
      var unbound = direct && link.trusted && link.svc === "";
      if (!link.trusted || (!unbound && siteOf(link) !== here)) return { kind: "foreign", link: link, site: siteOf(link) };
      if (!found) found = link;
      else if (found.page !== link.page || found.ref !== link.ref) return { kind: "foreign", link: link, site: siteOf(link) };
    }
    if (!found) return null;
    return { kind: "knock", link: found, site: siteOf(found), bound: !direct };
  }

  root.FlagshipKnock = { parseAccessLink: parseAccessLink, detectKnock: detectKnock, siteOf: siteOf };
})(globalThis);
