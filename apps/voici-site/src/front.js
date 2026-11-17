// voi.ci's front door (docs/voici-front-door.md): the page at https://voi.ci/ for someone who starts there. Rendered
// once per language at BUILD time (build.mjs) into plain HTML the Worker serves from its own bundle, so it needs no
// script, no D1, no R2 and no API: it loads even when the rest of `.com` is failing. Not one of the site's browser
// modules (build.mjs leaves it out of the files it serves).
//
// Every string a person reads goes through the translator, always with a literal (apps/voici-site/i18n.mjs extracts them); `t` is the build's
// translator for one language. Two tokens stay in the output and the Worker fills them per environment:
// %ORIGIN% (https://voi.ci, gym https://gym.voi.ci) and %APEX% (flagshipserver.com, gym gym.flagshipserver.com).

import { ICON_PATHS } from "./icons.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function icon(name, cls = "icon") {
  const d = ICON_PATHS[name] ?? ICON_PATHS.link;
  return (
    `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    d.map((p) => `<path d="${p}"/>`).join("") +
    "</svg>"
  );
}

const MARK =
  '<svg class="mark" viewBox="0 0 64 64" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<rect x="7" y="7" width="50" height="50" rx="7" fill="currentColor"/><circle cx="32" cy="32" r="17" class="mark-core"/></svg>';

/** The two store buttons and the browser link. `stores`: {ios, android} URLs from apps/web/public/app-stores.js. */
function getTheApp(t, stores, where) {
  const store = (id, url, platform, name, aria) =>
    `<a class="fd-store" href="${esc(url)}" rel="noopener" aria-label="${esc(aria)}" data-store="${id}">` +
    icon("phone", "icon fd-store-icon") +
    `<span class="fd-store-text"><span class="fd-store-platform">${esc(platform)}</span><span class="fd-store-name">${esc(name)}</span></span></a>`;
  return (
    `<div class="fd-get" data-get="${where}">` +
    '<div class="fd-stores">' +
    store("ios", stores.ios, t("iPhone and iPad"), "App Store", t("Download Flagship on the App Store")) +
    store("android", stores.android, t("Android phones"), "Google Play", t("Get Flagship on Google Play")) +
    "</div>" +
    `<a class="fd-web" href="https://webapp.%APEX%/">${icon("globe", "icon icon-sm")}<span>${esc(t("Or use Flagship in your browser"))}</span></a>` +
    "</div>"
  );
}

/** The illustration beside the headline: a page as voi.ci draws one, with sample content. Decorative only. */
function samplePage(t) {
  return (
    '<figure class="fd-sample" aria-hidden="true">' +
    '<div class="fd-sample-card">' +
    '<div class="fd-sample-head">' +
    '<span class="fd-sample-avatar">A</span>' +
    `<span class="fd-sample-name">Aya</span>` +
    '<span class="fd-sample-handle">voi.ci/aya</span>' +
    `<span class="fd-sample-bio">${esc(t("Photographer in Abidjan. Weddings, portraits, street life."))}</span>` +
    "</div>" +
    '<div class="fd-sample-actions">' +
    `<span class="fd-sample-btn is-primary">${icon("message", "icon icon-sm")}${esc(t("Send me a message"))}</span>` +
    `<span class="fd-sample-btn">${icon("call", "icon icon-sm")}${esc(t("Call"))}</span>` +
    "</div>" +
    '<div class="fd-sample-post">' +
    `<span class="fd-sample-meta">${esc(t("Latest post"))}</span>` +
    `<span class="fd-sample-text">${esc(t("New series out this week: the markets of Treichville at dawn. Write to me if you'd like a print."))}</span>` +
    "</div>" +
    "</div>" +
    "</figure>"
  );
}

function feature(iconName, title, body) {
  return `<li class="fd-feature">${icon(iconName, "icon fd-feature-icon")}<h3>${esc(title)}</h3><p>${esc(body)}</p></li>`;
}

function step(n, title, body) {
  return `<li class="fd-step"><span class="fd-step-n" aria-hidden="true">${n}</span><div><h3>${esc(title)}</h3><p>${esc(body)}</p></div></li>`;
}

/**
 * The whole front door in one language. o = {t, lang, dir, locales: [{code, native}], base ("/-/<dir>"), styleSri,
 * stores: {ios, android}}. Returns the HTML document as a string.
 */
export function renderFrontDoor(o) {
  const { t, lang, locales, base } = o;
  const self = `%ORIGIN%/?lang=${encodeURIComponent(lang)}`;
  const alternates = locales.map((l) => `<link rel="alternate" hreflang="${esc(l.code)}" href="%ORIGIN%/?lang=${encodeURIComponent(l.code)}">\n`).join("");
  const title = t("voi.ci · A page of your own");
  const description = t("Your own page, your posts. People can message you and call you, and nobody reads those messages but you. Made with the Flagship app.");
  const languages = locales
    .map((l) => `<a href="/?lang=${encodeURIComponent(l.code)}" hreflang="${esc(l.code)}" lang="${esc(l.code)}"${l.code === lang ? ' aria-current="true"' : ""}>${esc(l.native)}</a>`)
    .join("");
  return (
    "<!doctype html>\n" +
    `<html lang="${esc(lang)}" dir="${esc(o.dir ?? "ltr")}" data-theme="classic">\n` +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(description)}">\n` +
    '<meta name="robots" content="index, follow">\n' +
    `<link rel="canonical" href="${self}">\n` +
    alternates +
    '<link rel="alternate" hreflang="x-default" href="%ORIGIN%/">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:site_name" content="voi.ci">\n' +
    `<meta property="og:title" content="${esc(title)}">\n` +
    `<meta property="og:description" content="${esc(description)}">\n` +
    `<meta property="og:url" content="${self}">\n` +
    `<meta property="og:locale" content="${esc(lang.replace("-", "_"))}">\n` +
    `<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">\n` +
    `<link rel="preload" href="${base}/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>\n` +
    `<link rel="stylesheet" href="${base}/style.css" integrity="${o.styleSri}">\n` +
    "</head>\n" +
    '<body class="fd">\n' +
    '<header class="fd-bar">' +
    '<a class="fd-wordmark" href="/" aria-label="voi.ci">voi<span class="fd-dot">.</span>ci</a>' +
    `<a class="made-with" href="https://%APEX%/">${MARK}${esc(t("Made with Flagship"))}</a>` +
    "</header>\n" +
    '<main class="fd-main">\n' +
    '<section class="fd-hero">' +
    '<div class="fd-hero-text">' +
    `<p class="eyebrow">${esc(t("Your page on voi.ci"))}</p>` +
    `<h1 class="fd-title">${esc(t("A page of your own."))}</h1>` +
    `<p class="fd-lede">${esc(t("Post what you have to say. People can write to you and call you from your page, and nobody reads those messages but you."))}</p>` +
    getTheApp(t, o.stores, "top") +
    `<p class="fd-note">${esc(t("Flagship is free. There's no account to create here: your page is made in the app."))}</p>` +
    "</div>" +
    samplePage(t) +
    "</section>\n" +
    '<section class="fd-section" aria-labelledby="fd-what">' +
    `<h2 class="eyebrow" id="fd-what">${esc(t("What your page does"))}</h2>` +
    '<ul class="fd-features">' +
    feature("link", t("Your posts, in order"), t("Short posts and links. They appear on your page newest first, for anyone with the link. No algorithm decides who sees them.")) +
    feature("message", t("Messages that stay private"), t("People write to you from your page. Messages are encrypted end to end and arrive on your phone: we deliver them, we can't read them.")) +
    feature("call", t("Calls from your page"), t("People can call you from your page, voice or video, encrypted end to end. You choose when you pick up.")) +
    feature("moon", t("Quiet by design"), t("No ads, no follower counts, no feed built to keep you scrolling. Your page says what you put on it, nothing more.")) +
    "</ul>" +
    "</section>\n" +
    '<section class="fd-section" aria-labelledby="fd-how">' +
    `<h2 class="eyebrow" id="fd-how">${esc(t("Make your page in three steps"))}</h2>` +
    '<ol class="fd-steps">' +
    step(1, t("Get the Flagship app"), t("Free on iPhone and Android, or in your browser. Your account takes a minute to make, and its name becomes your address.")) +
    step(2, t("Open the Social tab"), t("Your page is waiting there. Add a photo, your name, a few words about yourself and your links.")) +
    step(3, t("Make it public"), t("Turn on Public and your page is live at voi.ci/yourname. Share the link wherever you like.")) +
    "</ol>" +
    '<div class="fd-open">' +
    `<a class="btn btn-secondary" href="https://%APEX%/app/page-editor">${esc(t("Open Flagship"))}</a>` +
    `<span class="fd-open-note">${esc(t("Already have the app? This takes you straight to your page."))}</span>` +
    "</div>" +
    "</section>\n" +
    '<section class="fd-section fd-honest" aria-labelledby="fd-see">' +
    `<h2 class="eyebrow" id="fd-see">${esc(t("What we can see"))}</h2>` +
    '<ul class="fd-facts">' +
    `<li>${icon("globe", "icon icon-sm")}<p>${esc(t("Your page is public: anyone with the link can read it. Each visitor's browser checks it against your signature, so nobody can change it on the way."))}</p></li>` +
    `<li>${icon("lock", "icon icon-sm")}<p>${esc(t("Your messages and calls are not public. They are encrypted on the devices at each end, and nobody else can read them, not even us."))}</p></li>` +
    `<li>${icon("flag", "icon icon-sm")}<p>${esc(t("If someone reports a message to us, we learn which account sent it. We see what it says only if the person reporting chooses to show us."))}</p></li>` +
    "</ul>" +
    "</section>\n" +
    '<section class="fd-final">' +
    `<h2 class="fd-final-title">${esc(t("Your page, your words."))}</h2>` +
    getTheApp(t, o.stores, "bottom") +
    "</section>\n" +
    "</main>\n" +
    '<footer class="fd-footer">' +
    `<nav class="footer-links" aria-label="${esc(t("Rules and reports"))}">` +
    `<a href="https://%APEX%/terms">${esc(t("Terms"))}</a>` +
    `<a href="https://%APEX%/abuse#voici">${esc(t("Report abuse"))}</a>` +
    `<a href="/-/about">${esc(t("About voi.ci"))}</a>` +
    "</nav>" +
    `<nav class="fd-langs" aria-label="${esc(t("Language"))}">${languages}</nav>` +
    "</footer>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
