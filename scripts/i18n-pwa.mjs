#!/usr/bin/env node
// i18n-pwa — localisation for the webapp (apps/web/public/webapp). Runtime: lib/i18n.js (tr / trn).
//
//   node scripts/i18n-pwa.mjs extract [--dry] [file…]
//        Reads the webapp's JavaScript with the TypeScript parser and rewrites user-facing text:
//          * string literals and template literals that are shown to a person -> tr("English", args…)
//          * the text runs (and placeholder / title / aria-label / alt attributes) of HTML templates
//            -> ${tr("English with {0}", expr)} spliced into the template
//          * `n === 1 ? "" : "s"` plural idioms -> trn(n, "{0} app", "{0} apps")
//        and records every English key in i18n/webapp/en.json. Static text of index.html is recorded too
//        (lib/i18n.js translates that subtree at start-up). Idempotent: wrapped text is skipped.
//        Skipped candidates go to /tmp/i18n-pwa-skipped.txt.
//   node scripts/i18n-pwa.mjs build     i18n/webapp/<lang>.json -> webapp/i18n/<lang>.json (ga languages only; --drafts for all)
//                                       and lib/i18nLocales.js
//   node scripts/i18n-pwa.mjs check     fail on drift or a ga language that lacks strings
//   node scripts/i18n-pwa.mjs dump|merge|midx|status|lint

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse, serialize } from "parse5";
import { ROOT, locales, targets, readEn, writeEn, readTr, runCommon, lintSurface } from "./lib/i18n-kv.mjs";

const SURFACE = "webapp";
const WEBAPP = path.join(ROOT, "apps/web/public/webapp");
const args = process.argv.slice(2);
const cmd = args[0];
const dry = args.includes("--dry");

const EXCLUDE = [/\/vendor\//, /\/service-worker\.js$/, /\/lib\/i18n\.js$/, /\/lib\/i18nLocales\.js$/, /\/i18n\//];

function listJs(dir = WEBAPP, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.name.endsWith(".js") && !EXCLUDE.some((r) => r.test(p))) out.push(p);
  }
  return out.sort();
}

// ---- what counts as text a person reads ---------------------------------------------------------

const EXPLICIT_PROPS = new Set(["textContent", "innerText", "placeholder", "title", "alt", "ariaLabel", "label"]);
const EXPLICIT_KEYS = new Set(["label", "title", "text", "message", "description", "placeholder", "heading", "subtitle", "caption", "hint", "note", "help", "error", "reason", "summary", "body", "buttonLabel", "confirmLabel", "cancelLabel", "okLabel", "emptyText", "tooltip", "ariaLabel", "detail", "headline", "name"]);
// plain strings that read as a phrase to a person even though looksProse() says no (lower-case fragments of a
// sentence, validation hints, status words); kept English where the same text is thrown as an Error.
const FORCE = new Set(JSON.parse(fs.readFileSync(new URL("./i18n-pwa.force.json", import.meta.url), "utf8")));
// emails to Flagship staff stay English
const NO_TEMPLATE_FILES = /(^|\/)lib\/trademarkClaim\.js$/;
/** A template whose fixed text holds a word next to a value or a space and nothing URL-, path- or protocol-like. */
// diagnostics, identifiers and units stay as written (errors are English by decision)
const DIAGNOSTIC = /\b(failed|invalid|must be|must list|must|bad|malformed|unsupported|contains|empty|expected|required|not relayable|reserved)\b|^\{\d+\}(px| KB| MB| GB)$|-backup-|^ tone-|is-tappable|^\.flagship|^[a-z-]+: [a-z{]/i;
const inError = (n) => { for (let p = n.parent; p && !ts.isBlock(p) && !ts.isSourceFile(p); p = p.parent) if (ts.isThrowStatement(p) || ((ts.isNewExpression(p) || ts.isCallExpression(p)) && /(^|\.)(\w*Error|reject)$/.test(p.expression.getText())) ) return true; return false; };
function looksUiTemplate(raw) {
  const st = raw.replace(/\u0001\d+\u0001/g, "\u0000");
  if (/[\/=?<>@\\]|:\/\/|Bearer|HTTP |^status |Flagship-Boot|^[a-z]+\./.test(st)) return false;
  return /[A-Za-z]{2,}/.test(st) && /[A-Za-z]+[\s\u0000]|[\s\u0000][A-Za-z]+/.test(st);
}
const UI_CALLS = /^(toast|showToast|alert|confirm|prompt|notify|announce|setStatus|showStatus|setError|showError|inlinePrompt|confirmModal|modal|openModal|banner|setNote|flash|sheet|confirmSheet)$/i;
const NEVER_CALLS = /^(console\.\w+|require|import|fetch|URL|RegExp|Symbol|\$|getElementById|querySelector(All)?|closest|matches|addEventListener|removeEventListener|dispatchEvent|CustomEvent|Event|setAttribute|getAttribute|removeAttribute|hasAttribute|localStorage\.\w+|sessionStorage\.\w+|JSON\.\w+|Object\.\w+|classList\.\w+|\w+\.(includes|indexOf|lastIndexOf|startsWith|endsWith|match|matchAll|test|replace|replaceAll|split|join|localeCompare|normalize|padStart|padEnd|at|charAt|get|set|has|delete|add|append|push|concat|slice|substring|toLowerCase|toUpperCase|encode|decode|fromCharCode|log|warn|error|info|debug)|btoa|atob|parseInt|parseFloat|Number|String|Boolean|Array\.\w+|Math\.\w+|Date\.\w+|Intl\.\w+|encodeURIComponent|decodeURIComponent|escapeHtml|esc|bytesToHex|hexToBytes|utf8|new TextEncoder|signWith\w+|canonical\w*|hash\w*|sha256|derive\w+|fsEvent|postMessage|importScripts|caches\.\w+|navigator\.\w+)$/;
const INLINE_TAGS = new Set(["a", "b", "i", "em", "strong", "code", "kbd", "small", "u", "mark", "sup", "sub", "br", "abbr", "s", "wbr"]);

function lettersIn(s) { return (s.match(/[A-Za-zÀ-ɏ]/g) || []).length; }

/** A literal that reads as a sentence or label rather than an identifier, path or protocol token. */
function looksCode(t) {
  const x = t.trim();
  if (!lettersIn(x)) return true;
  if (/^[a-z0-9_.\-/:+@#%&=?~*[\]{}()<>|^$\\,;'"` ]+$/.test(x) && !/ [a-z]+ [a-z]+ /.test(x) && !/[.!?…]$/.test(x)) return true; // all lowercase, no spaces-sentences
  if (/^[a-z]+([A-Z][a-z0-9]+)+$/.test(x)) return true; // camelCase
  if (/^[A-Z0-9_]+$/.test(x)) return true; // SHOUTING_CONSTANT
  if (/^(https?:|\/|\.\/|\.\.\/|#|~)/.test(x)) return true;
  if (/^[\w.-]+\/[\w./-]+$/.test(x)) return true; // a/b/c
  if (/flagship\/[a-z-]+\/v\d/.test(x)) return true; // canonical-bytes tags
  if (/^[0-9a-f]{8,}$/i.test(x)) return true;
  if (/^(application|text|image|audio|video)\//.test(x)) return true; // mime
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Bearer|Basic)\b/.test(x)) return true;
  if (/^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/.test(x)) return true;
  if (/^(sk-|ssh-|-----BEGIN)/.test(x)) return true;
  return false;
}
function looksProse(t) {
  const x = t.trim();
  if (looksCode(x)) return false;
  if (lettersIn(x) < 2) return false;
  const startsUpper = /^[A-ZÀ-Þ“‘("'¿¡0-9]/.test(x);
  return startsUpper && (/\s/.test(x) || /[.!?…:]$/.test(x));
}
/** In an explicit UI context even one word ("Save", "creating…") is text. */
function looksLabel(t) {
  const x = t.trim();
  if (x === "OK") return true;
  if (looksCode(x) && !/^[A-Z][a-z]{2,}/.test(x)) return false;
  if (x === "OK") return true;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(x)) return false;
  if (/^[a-z]+([A-Z][a-z0-9]+)+$/.test(x)) return false;
  if (/^(https?:|\/|\.|#)/.test(x)) return false;
  return lettersIn(x) >= 2;
}

// ---- the file transformer -----------------------------------------------------------------------

const entries = {}; // key -> ctx
const skipped = [];

function transformFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(WEBAPP, file);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const edits = []; // {start,end,text}
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  let usedTr = false, usedTrn = false;
  const trName = /\btr\b/.test(src) && !/import \{[^}]*\btr\b[^}]*\} from "[^"]*i18n\.js"/.test(src) ? "tr_" : "tr";
  const trnName = "trn";

  const addEdit = (start, end, text) => edits.push({ start, end, text });

  /** Source of [start,end) with the (maximal) edits inside it applied. */
  function renderRange(start, end) {
    const inside = edits.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start || b.end - a.end);
    const maximal = [];
    let last = -1;
    for (const e of inside) { if (e.start >= last) { maximal.push(e); last = e.end; } }
    let out = "", at = start;
    for (const e of maximal) { out += src.slice(at, e.start) + e.text; at = e.end; }
    return out + src.slice(at, end);
  }
  const renderNode = (n) => renderRange(n.getStart(sf), n.getEnd());
  const alreadyEdited = (n) => edits.some((e) => e.start <= n.getStart(sf) && e.end >= n.getEnd());

  const skip = (n, why) => { skipped.push(`${rel}:${lineOf(n.getStart(sf))} [${why}] ${n.getText(sf).slice(0, 100).replace(/\n/g, " ")}`); };

  function note(key, n) {
    if (!(key in entries)) entries[key] = { en: key, ctx: `webapp/${rel}:${lineOf(n.getStart(sf))}` };
  }
  const q = (s) => JSON.stringify(s);

  function callName(call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return (ts.isIdentifier(e.expression) ? e.expression.text + "." : e.expression.kind === ts.SyntaxKind.ThisKeyword ? "this." : "") + e.name.text;
    return "";
  }

  // --- context: is this expression's value shown to a person? Returns "explicit" | "generic" | null
  function contextOf(n) {
    let p = n.parent, child = n;
    // climb through parentheses, conditional branches, || / ?? / && fallbacks, awaits
    while (p && (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== child) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind) && p.right === child) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) { child = p; p = p.parent; }
    if (!p) return null;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p) || ts.isTaggedTemplateExpression(p) || ts.isDecorator(p)) return null;
    if (ts.isPropertyAssignment(p) && p.initializer === child) {
      const k = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "";
      if (EXPLICIT_KEYS.has(k)) return "explicit";
      return "generic";
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(op)) return null;
      if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(p.left) && p.right === child) {
        const name = p.left.name.text;
        if (EXPLICIT_PROPS.has(name) || name === "innerHTML" || name === "outerHTML") return "explicit";
        if (["className", "id", "type", "href", "src", "value", "name", "htmlFor", "download", "rel", "target", "cssText", "role", "dataset", "accept", "pattern", "autocomplete", "inputMode", "for"].includes(name)) return null;
        return "generic";
      }
      if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) return "generic";
      return null;
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (p.expression === child) return null;
      const nm = ts.isCallExpression(p) ? callName(p) : (ts.isIdentifier(p.expression) ? "new " + p.expression.text : "");
      if (nm === "setAttribute" || nm === "el.setAttribute" || /\.setAttribute$/.test(nm)) {
        const first = p.arguments[0];
        if (first && ts.isStringLiteral(first) && ["placeholder", "title", "aria-label", "alt", "aria-description"].includes(first.text) && p.arguments[1] === child) return "explicit";
        return null;
      }
      if (nm.endsWith("insertAdjacentHTML") && p.arguments[1] === child) return "explicit";
      if (NEVER_CALLS.test(nm)) return null;
      if (/^new (Error|TypeError|RangeError)$/.test(nm)) return "generic";
      if (UI_CALLS.test(nm.split(".").pop() || "") || UI_CALLS.test(nm)) return "explicit";
      // our own helpers: err("message", "code"): only the first argument is prose
      return "generic";
    }
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isArrayLiteralExpression(p) || ts.isVariableDeclaration(p) || ts.isThrowStatement(p) || ts.isTemplateSpan(p) || ts.isSpreadElement(p) || ts.isJsxExpression?.(p)) {
      if (ts.isVariableDeclaration(p) && p.initializer !== child) return null;
      if (ts.isArrowFunction(p) && p.body !== child) return null;
      return "generic";
    }
    if (ts.isPropertyDeclaration(p) || ts.isExportAssignment(p)) return "generic";
    return null;
  }

  // --- key/args from a template or concatenation -------------------------------------------------

  function flatTemplate(n) {
    // returns { raw, exprs: [Expression nodes] } where raw has \u0001i\u0001 markers
    if (ts.isNoSubstitutionTemplateLiteral(n)) return { raw: src.slice(n.getStart(sf) + 1, n.getEnd() - 1), exprs: [] };
    const exprs = [];
    let raw = src.slice(n.head.getStart(sf) + 1, n.head.getEnd() - 2);
    for (const span of n.templateSpans) {
      raw += `\u0001${exprs.length}\u0001`;
      exprs.push(span.expression);
      const lit = span.literal;
      raw += src.slice(lit.getStart(sf) + 1, lit.getEnd() - (ts.isTemplateTail(lit) ? 1 : 2));
    }
    return { raw, exprs };
  }
  function flatConcat(n) {
    // `+` chain of string literals / expressions -> same shape; null when no literal part
    const parts = [];
    const walk = (x) => {
      if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) { walk(x.left); walk(x.right); }
      else if (ts.isParenthesizedExpression(x) && ts.isBinaryExpression(x.expression) && x.expression.operatorToken.kind === ts.SyntaxKind.PlusToken) walk(x.expression);
      else parts.push(x);
    };
    walk(n);
    if (!parts.some((p) => ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p))) return null;
    const exprs = [];
    let raw = "";
    for (const p of parts) {
      if (ts.isStringLiteral(p)) raw += p.text.replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\\/g, "\\\\").replace(/\\\\`/g, "\\`").replace(/\\\\\$\{/g, "\\${");
      else if (ts.isNoSubstitutionTemplateLiteral(p)) raw += src.slice(p.getStart(sf) + 1, p.getEnd() - 1);
      else { raw += `\u0001${exprs.length}\u0001`; exprs.push(p); }
    }
    return { raw, exprs };
  }

  const unesc = (s) => s.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\$/g, "$");
  /** raw text with markers -> key with {i} (renumbered by appearance) and the ordered expression list */
  function toKey(raw, exprs) {
    const order = [];
    const text = raw.replace(/\u0001(\d+)\u0001/g, (_m, i) => { const idx = Number(i); let k = order.indexOf(idx); if (k < 0) { order.push(idx); k = order.length - 1; } return `{${k}}`; });
    return { key: unesc(text).replace(/\s*\n\s*/g, " "), argExprs: order.map((i) => exprs[i]) };
  }

  /** plural idiom: marker whose expression is `c === 1 ? "" : "s"` (or the reverse / !==, or two words). */
  function pluralOf(expr) {
    if (!ts.isConditionalExpression(expr)) return null;
    const c = expr.condition;
    if (!ts.isBinaryExpression(c)) return null;
    const op = c.operatorToken.kind;
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!eq && !ne) return null;
    let count = null;
    if (ts.isNumericLiteral(c.right) && c.right.text === "1") count = c.left;
    else if (ts.isNumericLiteral(c.left) && c.left.text === "1") count = c.right;
    if (!count) return null;
    const a = expr.whenTrue, b = expr.whenFalse;
    const str = (x) => (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null);
    if (str(a) === null || str(b) === null) return null;
    const one = eq ? str(a) : str(b), other = eq ? str(b) : str(a);
    return { count, one, other };
  }

  /** Build the call text for a run of raw text (with markers) or null when it should stay as is. */
  function callFor(raw, exprs, n, opts = {}) {
    // plural?
    const pl = [];
    raw.replace(/\u0001(\d+)\u0001/g, (_m, i) => { const p = pluralOf(exprs[Number(i)]); if (p) pl.push({ i: Number(i), ...p }); return _m; });
    if (pl.length === 1) {
      const { i, count, one, other } = pl[0];
      const countSrc = count.getText(sf);
      const mk = (form) => {
        // the count's own marker(s) become {0}; the plural marker becomes its branch text; others {1..}
        const rest = [];
        const text = raw.replace(/\u0001(\d+)\u0001/g, (_m, j) => {
          const idx = Number(j);
          if (idx === i) return form;
          if (exprs[idx].getText(sf) === countSrc) return "{0}";
          let k = rest.indexOf(idx); if (k < 0) { rest.push(idx); k = rest.length - 1; }
          return `{${k + 1}}`;
        });
        return { text: unesc(text).replace(/\s*\n\s*/g, " "), rest };
      };
      const one_ = mk(one), other_ = mk(other);
      if (lettersIn(one_.text.replace(/\{\d+\}/g, "")) >= 2) {
        note(one_.text, n); note(other_.text, n);
        usedTrn = true;
        const argsSrc = other_.rest.map((j) => renderNode(exprs[j]));
        return `${trnName}(${renderNode(count)}, ${q(one_.text)}, ${q(other_.text)}${argsSrc.length ? ", " + argsSrc.join(", ") : ""})`;
      }
    }
    const { key, argExprs } = toKey(raw, exprs);
    const bare = key.replace(/\{\d+\}/g, "").trim();
    if (!bare) return null;
    if (!opts.html && !(opts.explicit ? looksLabel(bare) : looksProse(bare))) return null;
    if (opts.html && lettersIn(bare) < 2) return null;
    note(key, n);
    usedTr = true;
    const argsSrc = argExprs.map(renderNode);
    return `${trName}(${q(key)}${argsSrc.length ? ", " + argsSrc.join(", ") : ""})`;
  }

  // --- HTML templates ----------------------------------------------------------------------------

  const HTML_RE = /<\/?[a-zA-Z][^<>]*>/;
  function transformHtml(raw, exprs, n) {
    // split into tags and text runs; inline tags join a run
    const tokens = [];
    let i = 0;
    const TAG = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s(?:[^>"'\u0001]|"[^"]*"|'[^']*'|\u0001\d+\u0001)*)?\/?>/y;
    while (i < raw.length) {
      if (raw[i] === "<") {
        TAG.lastIndex = i;
        const m = TAG.exec(raw);
        if (m) { tokens.push({ tag: true, text: m[0] }); i = TAG.lastIndex; continue; }
      }
      let j = i + 1;
      while (j < raw.length && raw[j] !== "<") j++;
      tokens.push({ tag: false, text: raw.slice(i, j) });
      i = j;
    }
    const tagName = (t) => (t.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase() ?? "";
    // group consecutive text + inline tags into runs
    const out = [];
    let run = null;
    let rawBlock = false; // inside <script>/<style>
    const flush = () => {
      if (!run) return;
      const text = run.map((r) => r.text).join("");
      const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
      const core = text.slice(lead.length, text.length - (trail.length || 0) || undefined);
      const coreText = trail.length ? text.slice(lead.length, text.length - trail.length) : text.slice(lead.length);
      const plain = coreText.replace(/\u0001\d+\u0001/g, "").replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ");
      let replaced = null;
      if (lettersIn(plain) >= 2 && !/^\s*$/.test(plain)) {
        // one wrapped element (<a href="{0}">Save</a>): the tags stay outside the key, only the words move
        let lo = 0, hi = run.length;
        while (lo < hi && !run[lo].tag && /^\s*$/.test(run[lo].text)) lo++;
        while (hi > lo && !run[hi - 1].tag && /^\s*$/.test(run[hi - 1].text)) hi--;
        const core_ = run.slice(lo, hi);
        const first = core_[0], lastTk = core_[core_.length - 1];
        if (core_.length >= 3 && first.tag && lastTk.tag && !first.text.startsWith("</") && lastTk.text.startsWith("</") && tagName(first.text) === tagName(lastTk.text) && core_.slice(1, -1).every((r) => !r.tag)) {
          const inner = core_.slice(1, -1).map((r) => r.text).join("");
          const il = inner.match(/^\s*/)[0], it = inner.match(/\s*$/)[0];
          const innerCore = inner.slice(il.length, inner.length - it.length);
          const call = lettersIn(innerCore.replace(/\u0001\d+\u0001/g, "")) >= 2 ? callFor(innerCore, exprs, n, { html: true }) : null;
          if (call) { out.push(run.slice(0, lo).map((r) => r.text).join("") + attrTranslate(first.text) + il + "${" + call + "}" + it + lastTk.text + run.slice(hi).map((r) => r.text).join("")); run = null; return; }
        }
        const call = callFor(coreText, exprs, n, { html: true });
        if (call) replaced = lead + "${" + call + "}" + trail;
      }
      out.push(replaced ?? text);
      run = null;
    };
    for (const tk of tokens) {
      if (rawBlock) {
        out.push(tk.text);
        if (tk.tag && /^<\/(script|style)/i.test(tk.text)) rawBlock = false;
        continue;
      }
      if (tk.tag) {
        const nm = tagName(tk.text);
        if (/^<(script|style)/i.test(tk.text)) { flush(); out.push(attrTranslate(tk.text)); rawBlock = !/\/>$/.test(tk.text); continue; }
        if (nm && INLINE_TAGS.has(nm) && run) { run.push(tk); continue; }
        if (nm && INLINE_TAGS.has(nm) && !tk.text.startsWith("</")) { run = []; run.push(tk); continue; }
        flush();
        out.push(attrTranslate(tk.text));
      } else {
        if (!run) run = [];
        run.push(tk);
      }
    }
    flush();
    // a run that began with an inline tag but holds no text must be emitted as written
    const rebuilt = out.join("");
    return rebuilt;

    function attrTranslate(tag) {
      return tag.replace(/(\s)(placeholder|title|aria-label|alt)=("([^"]*)"|'([^']*)')/g, (m, sp, name, quoted, dq, sq) => {
        const val = dq ?? sq ?? "";
        const plain = val.replace(/\u0001\d+\u0001/g, "");
        if (lettersIn(plain) < 2 || looksCode(plain) && !/^[A-Z]/.test(plain)) return m;
        const call = callFor(val, exprs, n, { html: true });
        return call ? `${sp}${name}="\${${call}}"` : m;
      });
    }
  }

  function rebuildTemplate(newRaw, exprs) {
    // newRaw still carries \u0001i\u0001 markers for expressions that were not consumed by a tr() call
    return "`" + newRaw.replace(/\u0001(\d+)\u0001/g, (_m, i) => "${" + renderNode(exprs[Number(i)]) + "}") + "`";
  }

  // --- the walk ------------------------------------------------------------------------------------

  function alreadyWrapped(n) {
    let p = n.parent;
    while (p && (ts.isParenthesizedExpression(p))) p = p.parent;
    return p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && (p.expression.text === "tr" || p.expression.text === "tr_" || p.expression.text === "trn");
  }

  function visit(n) {
    ts.forEachChild(n, visit); // children first, so nested edits exist when the parent renders

    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (alreadyWrapped(n) || alreadyEdited(n)) return;
      if (n.parent && (ts.isTemplateSpan(n.parent) && false)) return;
      // a template that is an argument to a tagged template or a `String.raw` is code
      if (n.parent && ts.isTaggedTemplateExpression(n.parent)) return;
      const { raw, exprs } = flatTemplate(n);
      if (HTML_RE.test(raw.replace(/\u0001\d+\u0001/g, ""))) {
        const ctx = contextOf(n);
        const rebuilt = transformHtml(raw, exprs, n);
        if (rebuilt !== raw) addEdit(n.getStart(sf), n.getEnd(), rebuildTemplate(rebuilt, exprs));
        return;
      }
      const ctx = contextOf(n);
      if (!ctx) return;
      const call = callFor(raw, exprs, n, { explicit: ctx === "explicit" });
      if (call) addEdit(n.getStart(sf), n.getEnd(), call);
      else if (looksUiTemplate(raw) && !NO_TEMPLATE_FILES.test(rel) && !inError(n) && !DIAGNOSTIC.test(toKey(raw, exprs).key)) {
        const forced = callFor(raw, exprs, n, { html: true });
        if (forced) addEdit(n.getStart(sf), n.getEnd(), forced);
      } else if (lettersIn(raw) >= 4) skip(n, "template not text-like");
      return;
    }

    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (alreadyEdited(n)) return;
      // only the outermost + of a chain
      if (n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return;
      const fc = flatConcat(n);
      if (!fc) return;
      const ctx = contextOf(n);
      if (!ctx) return;
      const call = callFor(fc.raw, fc.exprs, n, { explicit: ctx === "explicit" });
      if (call) addEdit(n.getStart(sf), n.getEnd(), call);
      return;
    }

    if (ts.isStringLiteral(n)) {
      if (alreadyWrapped(n) || alreadyEdited(n)) return;
      if (n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        // part of a chain handled by the chain's root when it qualifies; a lone literal part falls through below
        let r = n.parent;
        while (r.parent && ts.isBinaryExpression(r.parent) && r.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) r = r.parent;
        if (flatConcat(r) && contextOf(r)) return;
      }
      const text = n.text;
      if (/<\/?[a-zA-Z][^<>]*>/.test(text)) {
        // an HTML string
        const ctx = contextOf(n);
        if (!ctx) return;
        // handled like an HTML template: the string becomes a template literal whose text runs are wrapped
        const raw = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        const rebuilt = transformHtml(raw, [], n);
        if (rebuilt !== raw) addEdit(n.getStart(sf), n.getEnd(), "`" + rebuilt + "`");
        else skip(n, "html in plain string");
        return;
      }
      const ctx = contextOf(n);
      if (!ctx) return;
      if (((ctx === "explicit" ? looksLabel(text) : looksProse(text)) || FORCE.has(text)) && !(FORCE.has(text) && inError(n))) {
        // keys of lookups: `{ "Some text": x }` handled (PropertyAssignment name is not an initializer)
        note(text, n);
        usedTr = true;
        addEdit(n.getStart(sf), n.getEnd(), `${trName}(${q(text)})`);
      } else if (lettersIn(text) >= 12 && /\s/.test(text)) skip(n, "not prose");
    }
  }
  visit(sf);

  if (!edits.length) return { changed: false, rel };

  // outermost edits only, then apply
  const all = edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const maximal = [];
  let last = -1;
  for (const e of all) { if (e.start >= last) { maximal.push(e); last = e.end; } }
  let out = "", at = 0;
  for (const e of maximal) { out += src.slice(at, e.start) + e.text; at = e.end; }
  out += src.slice(at);

  // import
  const need = [];
  if (usedTr || out.includes(`${trName}(`)) need.push(trName === "tr" ? "tr" : `tr as ${trName}`);
  if (usedTrn) need.push("trn");
  if (!/from "[^"]*lib\/i18n\.js"|from "\.\/i18n\.js"/.test(out) && need.length) {
    const depth = rel.split(path.sep).length - 1;
    const spec = rel.startsWith("lib" + path.sep) ? "./i18n.js" : (depth === 0 ? "./lib/i18n.js" : "../lib/i18n.js");
    const line = `import { ${need.join(", ")} } from "${spec}";\n`;
    const importEnds = [];
    sf.statements.forEach((s) => { if (ts.isImportDeclaration(s)) importEnds.push(s.getEnd()); });
    const header = sf.statements.find((s) => ts.isImportDeclaration(s));
    if (header) {
      // after the last import statement (rendered offsets shift, so locate it again in the output)
      const lastImport = [...out.matchAll(/^import[\s\S]*?;\s*$/gm)].pop();
      const idx = lastImport ? lastImport.index + lastImport[0].length : 0;
      out = out.slice(0, idx) + "\n" + line.trimEnd() + out.slice(idx);
    } else {
      // a file without imports: after a leading comment block
      const m = out.match(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*)/);
      const idx = m ? m[0].length : 0;
      out = out.slice(0, idx) + line + out.slice(idx);
    }
  }
  return { changed: true, rel, out, count: maximal.length };
}

// ---- index.html: static text ------------------------------------------------------------------------

function staticHtmlEntries() {
  const file = path.join(WEBAPP, "index.html");
  const doc = parse(fs.readFileSync(file, "utf8"), { sourceCodeLocationInfo: true });
  const found = {};
  const inlineOnly = (el) => (el.childNodes ?? []).every((c) => c.nodeName === "#text" || c.nodeName === "#comment" || (INLINE_TAGS.has(c.nodeName) && inlineOnly(c)));
  const walk = (node) => {
    if (["script", "style", "template"].includes(node.nodeName)) return;
    // an element holding only text and inline tags is one sentence: <p>Pick <strong>one</strong> now.</p>
    if (node.tagName && node.childNodes?.some((c) => INLINE_TAGS.has(c.nodeName)) && inlineOnly(node)) {
      const inner = serialize(node).replace(/\s+/g, " ").trim();
      if (lettersIn(inner.replace(/<[^>]*>/g, "")) >= 2 && !/^\{\{/.test(inner)) {
        found[inner] = { en: inner, ctx: "webapp/index.html" };
        for (const a of node.attrs ?? []) if (["placeholder", "title", "aria-label", "alt"].includes(a.name) && lettersIn(a.value) >= 2) found[a.value] = { en: a.value, ctx: "webapp/index.html" };
        return;
      }
    }
    if (node.nodeName === "#text") {
      const t = node.value.trim().replace(/\s+/g, " ");
      if (lettersIn(t) >= 2 && !/^\{\{/.test(t)) found[node.value.trim()] = { en: node.value.trim(), ctx: "webapp/index.html" };
    }
    for (const a of node.attrs ?? []) if (["placeholder", "title", "aria-label", "alt"].includes(a.name) && lettersIn(a.value) >= 2) found[a.value] = { en: a.value, ctx: "webapp/index.html" };
    for (const c of node.childNodes ?? []) walk(c);
  };
  walk(doc);
  return found;
}

/** Every literal key the code already passes to tr()/trn(), by file:line (hand-written calls included). */
function harvestCalls() {
  const found = {};
  for (const f of listJs()) {
    const text = fs.readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const rel = path.relative(WEBAPP, f);
    const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(tr|tr_|trn)$/.test(n.expression.text)) {
        const idx = n.expression.text === "trn" ? [1, 2] : [0];
        for (const i of idx) {
          const k = lit(n.arguments[i]);
          if (k !== null && lettersIn(k) >= 1 && !(k in found)) found[k] = { en: k, ctx: `webapp/${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}` };
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

// ---- commands ------------------------------------------------------------------------------------------

if (cmd === "extract") {
  const onlyFiles = args.filter((a) => a.endsWith(".js")).map((a) => path.resolve(a));
  const files = onlyFiles.length ? onlyFiles : listJs();
  let changed = 0;
  for (const f of files) {
    const r = transformFile(f);
    if (r.changed) {
      const check = ts.transpileModule(r.out, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true }, fileName: f });
      const bad = (check.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (bad.length) { console.error(`SYNTAX ${r.rel}: ${ts.flattenDiagnosticMessageText(bad[0].messageText, "\n")}`); process.exitCode = 1; continue; }
      changed++;
      if (!dry) fs.writeFileSync(f, r.out);
    }
  }
  const existing = readEn(SURFACE);
  const statics = staticHtmlEntries();
  // text that left index.html (or merged into a whole-sentence entry) is not a key any more
  for (const [k, v] of Object.entries(existing)) if (v.ctx === "webapp/index.html" && !statics[k]) delete existing[k];
  const merged = { ...entries, ...harvestCalls(), ...statics };
  for (const [k, v] of Object.entries(merged)) if (!existing[k]) existing[k] = v;
  if (!dry) writeEn(SURFACE, existing);
  fs.writeFileSync("/tmp/i18n-pwa-skipped.txt", skipped.join("\n"));
  console.log(`${changed} files rewritten, ${Object.keys(existing).length} keys (${Object.keys(entries).length} from code), ${skipped.length} skipped candidates -> /tmp/i18n-pwa-skipped.txt`);
} else if (cmd === "build") {
  const withDrafts = args.includes("--drafts");
  const ga = locales.locales.filter((l) => l.code !== locales.source && (l.status === "ga" || withDrafts));
  const outDir = path.join(WEBAPP, "i18n");
  fs.rmSync(outDir, { recursive: true, force: true });
  const en = readEn(SURFACE);
  for (const l of ga) {
    const tr = readTr(SURFACE, l.code);
    const o = {};
    for (const [k, v] of Object.entries(en)) if (v.translatable !== false && tr[k]) o[k] = tr[k];
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${l.code}.json`), JSON.stringify(o));
  }
  const list = ga.map((l) => `"${l.code}"`).join(", ");
  fs.writeFileSync(path.join(WEBAPP, "lib/i18nLocales.js"), `// GENERATED by scripts/i18n-pwa.mjs from i18n/locales.json (ga languages only). Do not edit.\nexport const GA_LOCALES = [${list}];\n`);
  console.log(`webapp: ${ga.length} language file(s)`);
} else if (cmd === "check") {
  const problems = lintSurface(SURFACE);
  const ga = locales.locales.filter((l) => l.status === "ga" && l.code !== locales.source);
  const en = readEn(SURFACE);
  for (const k of Object.keys(harvestCalls())) if (!en[k]) problems.push(`not in i18n/webapp/en.json (run node scripts/i18n-pwa.mjs extract): ${k.slice(0, 70)}`);
  for (const l of ga) {
    const tr = readTr(SURFACE, l.code);
    const missing = Object.keys(en).filter((k) => en[k].translatable !== false && !tr[k]);
    if (missing.length) problems.push(`webapp/${l.code} is ga but lacks ${missing.length} strings (first: ${missing[0]})`);
    const f = path.join(WEBAPP, "i18n", `${l.code}.json`);
    if (!fs.existsSync(f)) problems.push(`webapp/i18n/${l.code}.json is missing: run node scripts/i18n-pwa.mjs build`);
  }
  const gaList = (fs.readFileSync(path.join(WEBAPP, "lib/i18nLocales.js"), "utf8").match(/\[(.*)\]/) || [, ""])[1];
  const want = ga.map((l) => `"${l.code}"`).join(", ");
  if (gaList.trim() !== want) problems.push("webapp/lib/i18nLocales.js is stale: run node scripts/i18n-pwa.mjs build");
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-pwa: ok");
} else if (!runCommon(SURFACE, args)) {
  console.error("usage: i18n-pwa.mjs extract [--dry] [file…] | build [--drafts] | check | dump | merge | midx | status | lint");
  process.exit(2);
}
