#!/usr/bin/env node
// i18n-web — build-time localisation of the static marketing/docs pages.
//
//   node scripts/i18n-web.mjs extract   rewrite i18n/web/segments.json from the English pages
//   node scripts/i18n-web.mjs build     write apps/web/public/<lang>/... from English + i18n/web/<lang>.json
//   node scripts/i18n-web.mjs check     fail on drift: stale generated pages, broken placeholders, missing keep-terms
//   node scripts/i18n-web.mjs status    per-language translated/missing counts
//
// The English pages stay the hand-written source of truth. Their text is cut into SEGMENTS (one
// paragraph, heading, list item, button, <title>, meta description, alt/title/aria-label ...). A
// segment's id is a hash of its English text, so changing the English makes the old translation
// stale (reported, and the page falls back to English for that segment) instead of silently wrong.
//
// Inside a segment, inline markup is replaced by numbered placeholders so a translator can move
// words but cannot break links or classes:
//     Read the <1>docs</1> first.<2/>      1 = the <a href=...> element, 2 = an atomic element (<br>, <svg>)
// Text inside <code>/<kbd>/<samp> placeholders must stay identical (check enforces it).
//
// A language is built to apps/web/public/<webPath>/ . While its locales.json status is "draft" the
// pages carry noindex and are not offered by the switcher or the Accept-Language redirect.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "parse5";
import { decodeHTML } from "entities";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "apps/web/public");
const DIR = path.join(ROOT, "i18n/web");
const SITE = "https://flagshipserver.com";

const locales = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/locales.json"), "utf8"));
const glossary = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/glossary.json"), "utf8"));
const hasTerm = (str, term) => hasTermRaw(str.replace(/-/g, " "), term.replace(/-/g, " "));
const hasTermRaw = (str, term) =>
  new RegExp(`(?<![A-Za-z0-9\\u00C0-\\u024F])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s)?(?![A-Za-z0-9\\u00C0-\\u024F])`, "u").test(str);
const keepList = glossary.keep.slice().sort((a, b) => b.length - a.length);
const targets = locales.locales.filter((l) => l.code !== locales.source);
const pagesCfg = JSON.parse(fs.readFileSync(path.join(DIR, "pages.json"), "utf8"));

// ---- HTML model ----------------------------------------------------------------------------

const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "button", "cite", "code", "data", "dfn", "em", "i", "img",
  "input", "kbd", "label", "mark", "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup", "svg", "time",
  "u", "var", "wbr"]);
const ATOMIC_TAGS = new Set(["br", "wbr", "img", "input", "svg", "select"]);
const VERBATIM_TAGS = new Set(["code", "kbd", "samp"]);
const SKIP = new Set(["script", "style", "noscript", "template", "pre", "textarea", "svg", "head-skip"]);
const TEXT_ATTRS = ["title", "alt", "aria-label", "placeholder", "aria-description"];
const META_TEXT = [["name", "description"], ["name", "twitter:title"], ["name", "twitter:description"],
  ["property", "og:title"], ["property", "og:description"], ["property", "og:site_name"]];

const isText = (n) => n.nodeName === "#text";
const isEl = (n) => !!n.tagName;
const attr = (el, name) => el.attrs?.find((a) => a.name === name)?.value;
const setAttr = (el, name, value) => {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = value; else el.attrs.push({ name, value });
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const hashId = (kind, text) => crypto.createHash("sha1").update(kind + "\0" + text).digest("hex").slice(0, 10).replace(/^/, "s");

const rawText = (n) => (isText(n) ? n.value : (n.childNodes || []).map(rawText).join(""));
const hasText = (n) => (isText(n) ? /\S/.test(n.value) : (n.childNodes || []).some(hasText));
const hasBlockDescendant = (el) =>
  (el.childNodes || []).some((c) => isEl(c) && !SKIP.has(c.tagName) && (!INLINE.has(c.tagName) || hasBlockDescendant(c)));
const inlineForRun = (n) =>
  !isEl(n) || (INLINE.has(n.tagName) && !hasBlockDescendant(n)) || n.nodeName === "#comment";

/** Visible text of a run, ignoring verbatim (code-like) elements. */
function proseText(n) {
  if (isText(n)) return n.value;
  if (!isEl(n) || SKIP.has(n.tagName) || VERBATIM_TAGS.has(n.tagName)) return "";
  return (n.childNodes || []).map(proseText).join("");
}

// A run is a maximal stretch of sibling text / inline nodes.  It becomes a segment when it holds
// prose of its own.  Returns [{ start, end, nodes }] over el.childNodes.
function runsOf(el) {
  const runs = [];
  let cur = null;
  let prevButtonish = false; // the last element in `cur`, with only whitespace since, was an <a>/<button>
  const buttonish = (c) => isEl(c) && (c.tagName === "a" || c.tagName === "button");
  el.childNodes.forEach((c, i) => {
    const member = (isText(c) || c.nodeName === "#comment" || (isEl(c) && !SKIP.has(c.tagName) && inlineForRun(c)))
      || (isEl(c) && SKIP.has(c.tagName) && ATOMIC_TAGS.has(c.tagName));
    if (!member) { cur = null; prevButtonish = false; return; }
    if (buttonish(c) && prevButtonish) cur = null; // two adjacent links/buttons are two segments
    if (!cur) { cur = { start: i, end: i + 1 }; runs.push(cur); } else cur.end = i + 1;
    if (buttonish(c)) prevButtonish = true;
    else if (!(isText(c) && !/\S/.test(c.value))) prevButtonish = false;
  });
  const keepRe = new RegExp("^(?:" + keepList.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + "|[^\\p{L}\\p{N}]|\\d)*$", "u");
  return runs
    .map((r) => ({ ...r, nodes: el.childNodes.slice(r.start, r.end) }))
    .filter((r) => {
      const t = r.nodes.map(proseText).join("");
      return /[\p{L}\p{N}]/u.test(t) && !keepRe.test(norm(t));
    });
}

/** Encode a run as a placeholder string + the ordered list of original elements. */
function encodeRun(nodes) {
  const refs = [];
  const enc = (n) => {
    if (isText(n)) return esc(n.value);
    if (n.nodeName === "#comment") { refs.push(n); return `<${refs.length}/>`; }
    if (ATOMIC_TAGS.has(n.tagName) || !hasText(n)) { refs.push(n); return `<${refs.length}/>`; }
    refs.push(n);
    const id = refs.length;
    return `<${id}>${(n.childNodes || []).map(enc).join("")}</${id}>`;
  };
  return { text: norm(nodes.map(enc).join("")), refs };
}

// ---- segment collection ---------------------------------------------------------------------

function walk(el, visit) {
  if (!isEl(el) && el.nodeName !== "#document") { return; }
  if (isEl(el) && (SKIP.has(el.tagName) || attr(el, "translate") === "no")) return;
  visit(el);
  (el.childNodes || []).forEach((c) => walk(c, visit));
}

function collect(doc, onText, onAttr) {
  const attrsOf = (el) => {
    for (const a of TEXT_ATTRS) {
      const v = attr(el, a);
      if (v && /[\p{L}]/u.test(v)) onAttr(el, a, v);
    }
    if (el.tagName === "meta") {
      for (const [k, v] of META_TEXT) if (attr(el, k) === v && attr(el, "content")) onAttr(el, "content", attr(el, "content"));
    }
  };
  // Elements inside a segment keep their markup (only their text and alt/title/aria-label are translated).
  const attrsOnly = (n) => {
    if (!isEl(n) || SKIP.has(n.tagName) && n.tagName !== "svg") return;
    attrsOf(n);
    (n.childNodes || []).forEach(attrsOnly);
  };
  const rec = (n) => {
    if (n.nodeName !== "#document" && !isEl(n)) return;
    if (isEl(n) && (SKIP.has(n.tagName) || attr(n, "translate") === "no" || (n.tagName !== "html" && attr(n, "lang") === locales.source))) return;
    if (isEl(n)) attrsOf(n);
    const runs = isEl(n) ? runsOf(n).filter((r) => !r.nodes.some((x) => isEl(x) && attr(x, "translate") === "no")) : [];
    const inRun = new Set();
    for (const r of runs) { r.nodes.forEach((x) => inRun.add(x)); onText(n, r); }
    for (const c of n.childNodes || []) {
      if (inRun.has(c)) attrsOnly(c); else rec(c);
    }
  };
  rec(doc);
}

const pageList = () => pagesCfg.pages.map((p) => p.src);
const readPage = (src) => fs.readFileSync(path.join(PUBLIC, src), "utf8");

function extractAll() {
  const segs = {};
  for (const src of pageList()) {
    const doc = parse(readPage(src));
    const add = (kind, text, ctx, verbatim) => {
      const id = hashId(kind, text);
      const s = (segs[id] ??= { en: text, kind, ctx, ...(verbatim?.length ? { verbatim } : {}), pages: [] });
      if (!s.pages.includes(src)) s.pages.push(src);
    };
    collect(doc,
      (el, run) => {
        const { text, refs } = encodeRun(run.nodes);
        const verbatim = refs.filter((r) => isEl(r) && VERBATIM_TAGS.has(r.tagName)).map((r) => norm(rawText(r)));
        add("text", text, el.tagName, verbatim);
      },
      (el, a, v) => add("attr", norm(v), `${el.tagName}[${a}]`));
  }
  return segs;
}

// ---- translation → nodes --------------------------------------------------------------------

const TOKEN = /<(\/?)(\d+)(\/?)>/g;

function placeholdersOf(s) {
  const out = [];
  for (const m of s.matchAll(TOKEN)) out.push(`${m[1] ? "/" : ""}${m[2]}${m[3] ? "/" : ""}`);
  return out;
}

function textNode(value) { return { nodeName: "#text", value, parentNode: null }; }
function cloneShallow(el) {
  return { nodeName: el.nodeName, tagName: el.tagName, namespaceURI: el.namespaceURI,
    attrs: el.attrs.map((a) => ({ ...a })), childNodes: [], parentNode: null };
}

function decode(s) { return decodeHTML(s); }

/** Build child nodes for a translated placeholder string using the original element refs. */
function decodeRun(translated, refs) {
  const root = { childNodes: [] };
  const stack = [root];
  let last = 0;
  const top = () => stack[stack.length - 1];
  const push = (n) => { n.parentNode = top() === root ? null : top(); top().childNodes.push(n); };
  for (const m of translated.matchAll(TOKEN)) {
    if (m.index > last) push(textNode(decode(translated.slice(last, m.index))));
    last = m.index + m[0].length;
    const ref = refs[Number(m[2]) - 1];
    if (!ref) throw new Error(`placeholder ${m[2]} has no source element`);
    if (m[3]) { push(ref); continue; }
    if (m[1]) { stack.pop(); continue; }
    const c = cloneShallow(ref);
    push(c);
    stack.push(c);
  }
  if (last < translated.length) push(textNode(decode(translated.slice(last))));
  return root.childNodes;
}

// ---- links ----------------------------------------------------------------------------------

const canonPath = (p) => {
  let u = p.replace(/\.html$/, "").replace(/\/index$/, "");
  if (u === "") u = "/";
  if (u.length > 1) u = u.replace(/\/$/, "");
  return u;
};
const srcToUrl = (src) => canonPath("/" + src);
const translatedUrls = new Set(pageList().map(srcToUrl));

function localiseHref(href, prefix) {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const m = href.match(/^([^?#]*)([?#].*)?$/);
  const p = canonPath(m[1]);
  if (!translatedUrls.has(p)) return href;
  const out = p === "/" ? `/${prefix}/` : `/${prefix}${p}`;
  return out + (m[2] || "");
}

// ---- build one page for one language --------------------------------------------------------

function loadTranslations(code) {
  const f = path.join(DIR, `${code}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

function find(doc, tag) {
  let found = null;
  walk(doc, (el) => { if (!found && isEl(el) && el.tagName === tag) found = el; });
  return found;
}
// walk() skips nothing for head/html; helper that does not stop at SKIP for finding <head>.
function findAny(n, tag) {
  if (isEl(n) && n.tagName === tag) return n;
  for (const c of n.childNodes || []) { const r = findAny(c, tag); if (r) return r; }
  return null;
}

function buildPage(src, loc, tr, stats) {
  const doc = parse(readPage(src));
  const html = findAny(doc, "html");
  const head = findAny(doc, "head");
  const prefix = loc.webPath;

  // Collect first, then splice, so node positions stay valid.
  const jobs = [];
  collect(doc,
    (el, run) => jobs.push({ kind: "text", el, run }),
    (el, a, v) => jobs.push({ kind: "attr", el, a, v }));

  for (const j of jobs.filter((x) => x.kind === "text").reverse()) {
    const { text, refs } = encodeRun(j.run.nodes);
    const id = hashId("text", text);
    stats.total++;
    const t = tr[id];
    if (t == null || t === "") { stats.missing.push(id); continue; }
    stats.done++;
    const kids = decodeRun(t, refs);
    kids.forEach((k) => { k.parentNode = j.el; });
    j.el.childNodes.splice(j.run.start, j.run.end - j.run.start, ...kids);
    // spliced indices shift for earlier runs only after later ones are done, hence the reverse order
  }
  for (const j of jobs.filter((x) => x.kind === "attr")) {
    const id = hashId("attr", norm(j.v));
    stats.total++;
    const t = tr[id];
    if (t == null || t === "") { stats.missing.push(id); continue; }
    stats.done++;
    setAttr(j.el, j.a, decode(t));
  }

  // links
  walk(doc, (el) => {
    if (!isEl(el)) return;
    if (el.tagName === "a" && attr(el, "href")) setAttr(el, "href", localiseHref(attr(el, "href"), prefix));
  });
  // head: lang, canonical, alternates, robots
  html.attrs = html.attrs.filter((a) => a.name !== "lang" && a.name !== "dir");
  html.attrs.unshift({ name: "lang", value: loc.code }, { name: "dir", value: loc.dir });
  const self = srcToUrl(src);
  const localUrl = self === "/" ? `/${prefix}/` : `/${prefix}${self}`;
  for (const l of [...head.childNodes]) {
    if (isEl(l) && l.tagName === "link" && attr(l, "rel") === "canonical") head.childNodes.splice(head.childNodes.indexOf(l), 1);
    if (isEl(l) && l.tagName === "meta" && attr(l, "property") === "og:url") head.childNodes.splice(head.childNodes.indexOf(l), 1);
  }
  const mk = (tag, attrs) => ({ nodeName: tag, tagName: tag, namespaceURI: "http://www.w3.org/1999/xhtml",
    attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })), childNodes: [], parentNode: head });
  const add = [
    mk("link", { rel: "canonical", href: SITE + localUrl }),
    mk("meta", { property: "og:url", content: SITE + localUrl }),
    mk("meta", { property: "og:locale", content: loc.code.replace("-", "_") }),
  ];
  if (loc.status !== "ga") add.push(mk("meta", { name: "robots", content: "noindex" }));
  const gaLocs = locales.locales.filter((l) => l.status === "ga");
  if (loc.status === "ga") {
    for (const l of gaLocs) {
      const u = l.code === locales.source ? (self === "/" ? "/" : self) : (self === "/" ? `/${l.webPath}/` : `/${l.webPath}${self}`);
      add.push(mk("link", { rel: "alternate", hreflang: l.code, href: SITE + u }));
    }
    add.push(mk("link", { rel: "alternate", hreflang: "x-default", href: SITE + self }));
  }
  const gen = { nodeName: "#comment", data: ` GENERATED by scripts/i18n-web.mjs from ${src} (${loc.code}); edit the English page or i18n/web/${loc.code}.json `, parentNode: head };
  head.childNodes.unshift(gen, ...add);
  return serialize(doc);
}

function outPath(src, loc) { return path.join(PUBLIC, loc.webPath, src); }

const L10N_NOTE = {
  es: "Traducción automática. El original en inglés es la versión de referencia.",
  fr: "Traduction automatique. L’original en anglais fait foi.",
  de: "Maschinelle Übersetzung. Maßgeblich ist das englische Original.",
  "pt-BR": "Tradução automática. O original em inglês é a versão de referência.",
  ja: "機械翻訳です。英語の原文が正式版です。",
  "zh-Hans": "此为机器翻译，以英文原文为准。",
};

function switcherScript() {
  const table = locales.locales.map((l) => ({ code: l.code, native: l.native, path: l.webPath ?? "", ga: l.status === "ga" }));
  const urls = [...translatedUrls];
  return String.raw`// GENERATED by scripts/i18n-web.mjs build from i18n/locales.json. Do not edit.
// Language switcher for the localised marketing pages. English stays at the site root; every other
// language is a static copy under /<path>/. The choice is remembered in the fs-lang cookie, which the
// Worker reads on "/" to decide whether to send a first-time visitor to their language.
(function () {
  var LOCALES = ${JSON.stringify(table)};
  var PAGES = ${JSON.stringify(urls)};
  var NOTE = ${JSON.stringify(L10N_NOTE)};
  var here = document.documentElement.getAttribute("lang") || "en";
  var preview = /[?&]i18n-preview\b/.test(location.search) || (function () { try { return localStorage.getItem("fs-i18n-preview") === "1"; } catch (e) { return false; } })();
  if (/[?&]i18n-preview\b/.test(location.search)) { try { localStorage.setItem("fs-i18n-preview", "1"); } catch (e) {} }
  function canon(p) { p = p.replace(/\.html$/, "").replace(/\/index$/, ""); if (p === "") p = "/"; if (p.length > 1) p = p.replace(/\/$/, ""); return p; }
  function current() { for (var i = 0; i < LOCALES.length; i++) { var l = LOCALES[i]; if (l.path && (location.pathname === "/" + l.path || location.pathname.indexOf("/" + l.path + "/") === 0)) return l; } return LOCALES[0]; }
  function bare() { var l = current(); return l.path ? canon(location.pathname.slice(l.path.length + 1) || "/") : canon(location.pathname); }
  function target(l) { var p = bare(); if (PAGES.indexOf(p) < 0) p = "/"; return l.path ? "/" + l.path + (p === "/" ? "/" : p) : p; }
  function mount() {
    var host = document.querySelector(".footer-bottom") || document.querySelector("footer") || document.body;
    var wrap = document.createElement("label");
    wrap.className = "lang-switch";
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:8px;font:inherit;color:var(--muted,#667);margin-left:auto";
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    sel.style.cssText = "font:inherit;color:inherit;background:transparent;border:1px solid var(--rule-strong,#8884);border-radius:4px;padding:4px 8px";
    LOCALES.forEach(function (l) {
      if (!l.ga && !preview && l.code !== here) return;
      var o = document.createElement("option");
      o.value = l.code; o.textContent = l.native + (l.ga ? "" : " (draft)");
      if (l.code === here) o.selected = true;
      sel.appendChild(o);
    });
    if (sel.options.length < 2) return;
    sel.addEventListener("change", function () {
      var l = LOCALES.filter(function (x) { return x.code === sel.value; })[0];
      document.cookie = "fs-lang=" + l.code + "; path=/; max-age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
      location.href = target(l) + location.hash;
    });
    wrap.appendChild(sel);
    if (here !== "en" && NOTE[here]) { var n = document.createElement("span"); n.textContent = NOTE[here]; n.style.cssText = "opacity:.8"; wrap.insertBefore(n, sel); }
    host.appendChild(wrap);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
`;
}

function workerLocaleTable() {
  const ga = locales.locales.filter((l) => l.status === "ga" && l.code !== locales.source);
  return `// GENERATED by scripts/i18n-web.mjs build from i18n/locales.json. Do not edit.
// The languages whose pages are live (status "ga"). Empty while every language is a draft.
export const GA_WEB_LOCALES: { code: string; webPath: string }[] = ${JSON.stringify(ga.map((l) => ({ code: l.code, webPath: l.webPath })), null, 2)};
`;
}

function buildAll(write) {
  const results = [];
  for (const loc of targets) {
    const tr = loadTranslations(loc.code);
    for (const src of pageList()) {
      const stats = { total: 0, done: 0, missing: [] };
      const html = buildPage(src, loc, tr, stats);
      results.push({ loc, src, html, stats, file: outPath(src, loc) });
    }
  }
  if (write) {
    for (const r of results) {
      fs.mkdirSync(path.dirname(r.file), { recursive: true });
      fs.writeFileSync(r.file, r.html);
    }
    fs.writeFileSync(path.join(PUBLIC, "i18n.js"), switcherScript());
    fs.writeFileSync(path.join(ROOT, "apps/com/src/localeTable.generated.ts"), workerLocaleTable());
  }
  return results;
}

// ---- lint -----------------------------------------------------------------------------------

function lint(segs) {
  const problems = [];
  const keepTerms = glossary.keep;
  for (const loc of targets) {
    const tr = loadTranslations(loc.code);
    for (const [id, t] of Object.entries(tr)) {
      const s = segs[id];
      if (!s) { problems.push(`${loc.code}: ${id} is not in segments.json (stale; the English changed)`); continue; }
      if (s.kind === "attr") {
        for (const k of keepTerms) if (hasTerm(s.en, k) && !hasTerm(t, k))
          problems.push(`${loc.code}: ${id} drops keep-term "${k}": ${t}`);
        continue;
      }
      const a = placeholdersOf(s.en).join(","), b = placeholdersOf(t).join(",");
      const sa = [...placeholdersOf(s.en)].sort().join(","), sb = [...placeholdersOf(t)].sort().join(",");
      if (sa !== sb) problems.push(`${loc.code}: ${id} placeholders differ (en ${a} / ${loc.code} ${b}): ${t}`);
      // opening/closing balance
      const depth = [];
      for (const m of t.matchAll(TOKEN)) {
        if (m[3]) continue;
        if (!m[1]) depth.push(m[2]); else if (depth.pop() !== m[2]) problems.push(`${loc.code}: ${id} unbalanced placeholder ${m[2]}`);
      }
      if (depth.length) problems.push(`${loc.code}: ${id} unclosed placeholder ${depth.join(",")}`);
      for (const v of s.verbatim || []) if (v && !norm(decodeHTML(t)).includes(v)) problems.push(`${loc.code}: ${id} changed code text "${v}"`);
      for (const k of keepTerms) if (hasTerm(s.en, k) && !hasTerm(t, k))
        problems.push(`${loc.code}: ${id} drops keep-term "${k}": ${t}`);
    }
  }
  return problems;
}

// ---- commands -------------------------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "extract") {
  const segs = extractAll();
  fs.writeFileSync(path.join(DIR, "segments.json"), JSON.stringify(segs, null, 2) + "\n");
  console.log(`${Object.keys(segs).length} segments from ${pageList().length} pages`);
} else if (cmd === "build") {
  const res = buildAll(true);
  console.log(`wrote ${res.length} pages`);
} else if (cmd === "dump") {
  // dump <from> <count>: segments no language has yet, as `id<TAB>ctx<TAB>english`, for a translator.
  const segs = JSON.parse(fs.readFileSync(path.join(DIR, "segments.json"), "utf8"));
  const trs = targets.map((l) => loadTranslations(l.code));
  const todo = Object.entries(segs).filter(([id]) => trs.some((t) => !t[id]));
  const from = Number(process.argv[3] || 0), n = Number(process.argv[4] || 60);
  console.error(`${todo.length} segments still need at least one language`);
  for (const [id, s] of todo.slice(from, from + n)) console.log(`${id}\t${s.ctx}\t${s.en}`);
} else if (cmd === "merge") {
  // merge <file.json>: { "<id>": { "es": "...", "pt-BR": "..." } } into i18n/web/<lang>.json
  const incoming = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const segs = JSON.parse(fs.readFileSync(path.join(DIR, "segments.json"), "utf8"));
  const codes = new Set(targets.map((l) => l.code));
  const byLang = {};
  let n = 0;
  for (const [id, per] of Object.entries(incoming)) {
    if (!segs[id]) { console.error(`unknown id ${id}`); continue; }
    for (const [code, text] of Object.entries(per)) {
      if (!codes.has(code)) { console.error(`unknown language ${code}`); continue; }
      (byLang[code] ??= loadTranslations(code))[id] = text;
      n++;
    }
  }
  for (const [code, tr] of Object.entries(byLang)) {
    const sorted = Object.fromEntries(Object.keys(segs).filter((id) => tr[id] != null).map((id) => [id, tr[id]]));
    fs.writeFileSync(path.join(DIR, `${code}.json`), JSON.stringify(sorted, null, 2) + "\n");
  }
  console.log(`merged ${n} translations`);
  const probs = lint(segs).filter((p) => Object.keys(incoming).some((id) => p.includes(id)));
  if (probs.length) { console.error(probs.join("\n")); process.exit(1); }
} else if (cmd === "status") {
  const segs = JSON.parse(fs.readFileSync(path.join(DIR, "segments.json"), "utf8"));
  const total = Object.keys(segs).length;
  for (const loc of targets) {
    const tr = loadTranslations(loc.code);
    const have = Object.keys(segs).filter((id) => tr[id]).length;
    console.log(`${loc.code.padEnd(8)} ${have}/${total} (${loc.status})`);
  }
} else if (cmd === "check") {
  const problems = [];
  const fresh = extractAll();
  const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, "segments.json"), "utf8"));
  if (JSON.stringify(fresh) !== JSON.stringify(onDisk)) problems.push("i18n/web/segments.json is stale: run `node scripts/i18n-web.mjs extract`");
  problems.push(...lint(fresh));
  for (const [f, want] of [[path.join(PUBLIC, "i18n.js"), switcherScript()], [path.join(ROOT, "apps/com/src/localeTable.generated.ts"), workerLocaleTable()]]) {
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== want) problems.push(`${path.relative(ROOT, f)} is stale: run \`node scripts/i18n-web.mjs build\``);
  }
  for (const r of buildAll(false)) {
    const have = fs.existsSync(r.file) ? fs.readFileSync(r.file, "utf8") : null;
    if (have !== r.html) problems.push(`${path.relative(ROOT, r.file)} is stale: run \`node scripts/i18n-web.mjs build\``);
  }
  if (problems.length) { console.error(problems.join("\n")); console.error(`\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-web: ok");
} else {
  console.error("usage: i18n-web.mjs extract | build | check | status");
  process.exit(2);
}
