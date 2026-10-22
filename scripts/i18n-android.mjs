#!/usr/bin/env node
// i18n-android — move the Android app's (and Wear's) user-facing text into string resources and
// emit one values-<lang>/strings.xml per language.
//
//   node scripts/i18n-android.mjs extract [--dry] [--module app|wear]
//        one-time (and re-runnable) migration: finds user-facing string literals in the Kotlin
//        sources, writes them to i18n/<module>/en.json and res/values/strings.xml, and rewrites the
//        code to read them (stringResource(...) inside UI, FSStrings.get(...) elsewhere).
//   node scripts/i18n-android.mjs build [--module ...]    i18n/<module>/<lang>.json -> res/values-<lang>/strings.xml (every module unless --module)
//   node scripts/i18n-android.mjs check                   fail on drift, bad placeholders, missing keys in a ga language
//   node scripts/i18n-android.mjs dump|merge|status|lint  see scripts/lib/i18n-kv.mjs
//
// Text that is not a plain literal (a top-level `val`, an enum entry, string building with `+`) is
// not rewritten; extract lists every such candidate in the report so none is lost silently.

import fs from "node:fs";
import path from "node:path";
import { ROOT, locales, targets, readEn, writeEn, readTr, runCommon, lintSurface } from "./lib/i18n-kv.mjs";

const MODULES = {
  app: { dir: "apps/mobile/android/app/src/main", pkgDir: "java/com/flagshipserver/app", surface: "android", uiDirs: ["ui/"], res: "res" },
  wear: { dir: "apps/mobile/android/wear/src/main", pkgDir: "java", surface: "wear", uiDirs: [""], res: "res" },
};

const SEED = {
  android: {
    app_name: { en: "Flagship", ctx: "launcher label", translatable: false },
    widget_pod_status_label: { en: "Servers", ctx: "home-screen widget picker" },
    widget_pod_status_description: { en: "Online status for your Flagship servers.", ctx: "home-screen widget picker" },
  },
  wear: {
    app_name: { en: "Flagship", ctx: "watch launcher label", translatable: false },
    tile_label: { en: "Flagship servers", ctx: "watch tile picker" },
    complication_label: { en: "Flagship", ctx: "watch complication picker", translatable: false },
  },
};

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const moduleName = args.includes("--module") ? args[args.indexOf("--module") + 1] : "app";

// ---- Kotlin lexing -------------------------------------------------------------------------

/** Find the string literals of a Kotlin source. Returns top-level literals (not those nested in templates). */
function scanLiterals(src, from = 0, to = src.length) {
  const out = [];
  let i = from;
  const skipLineComment = () => { while (i < to && src[i] !== "\n") i++; };
  const skipBlockComment = () => {
    let depth = 1; i += 2;
    while (i < to && depth > 0) {
      if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
      else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
      else i++;
    }
  };
  while (i < to) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { skipLineComment(); continue; }
    if (c === "/" && src[i + 1] === "*") { skipBlockComment(); continue; }
    if (c === "'") { // char literal
      if (src[i + 1] === "\\") { i += 2; while (i < to && src[i] !== "'") i++; i++; } else i += 3;
      continue;
    }
    if (c === '"') {
      const lit = readString(src, i, to);
      out.push(lit);
      i = lit.end;
      continue;
    }
    i++;
  }
  return out;
}

/** "A" + "B" (only whitespace and one + between) is one sentence for a translator: fold it into one literal. */
function foldConcats(src, lits) {
  const out = [];
  for (const lit of lits) {
    const prev = out[out.length - 1];
    if (prev && /^\s*\+\s*$/.test(src.slice(prev.end, lit.start)) && !prev.raw && !lit.raw) {
      out[out.length - 1] = { start: prev.start, end: lit.end, raw: false, parts: [...prev.parts, ...lit.parts], nested: [...(prev.nested ?? []), ...(lit.nested ?? [])], folded: true };
    } else out.push(lit);
  }
  return out;
}

/** Parse one string literal starting at src[start] === '"'. */
function readString(src, start, limit) {
  const raw = src.startsWith('"""', start);
  let i = start + (raw ? 3 : 1);
  const parts = []; // { text } | { expr, exprStart, exprEnd, name? }
  let buf = "";
  const flush = () => { if (buf !== "") { parts.push({ text: buf }); buf = ""; } };
  while (i < limit) {
    const c = src[i];
    if (!raw && c === "\\") {
      const n = src[i + 1];
      if (n === "u") { buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
      buf += { n: "\n", t: "\t", r: "\r", b: "\b", '"': '"', "'": "'", "\\": "\\", $: "$" }[n] ?? n;
      i += 2; continue;
    }
    if (raw ? src.startsWith('"""', i) : c === '"') {
      let end = i + (raw ? 3 : 1);
      if (raw) while (src[end] === '"') end++; // """" at the end belongs to the content
      flush();
      return { start, end, raw, parts, nested: parts.flatMap((p) => p.nested ?? []) };
    }
    if (c === "$" && src[i + 1] === "{") {
      flush();
      // find the matching }, skipping nested strings and braces
      let depth = 1, j = i + 2;
      while (j < limit && depth > 0) {
        if (src[j] === '"') j = readString(src, j, limit).end;
        else if (src[j] === "'") j += src[j + 1] === "\\" ? 4 : 3;
        else { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      }
      const exprStart = i + 2, exprEnd = j - 1;
      parts.push({ expr: src.slice(exprStart, exprEnd), exprStart, exprEnd, nested: foldConcats(src, scanLiterals(src, exprStart, exprEnd)) });
      i = j; continue;
    }
    if (c === "$" && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
      flush();
      let j = i + 1;
      while (j < limit && /[A-Za-z0-9_]/.test(src[j])) j++;
      parts.push({ expr: src.slice(i + 1, j), name: true, exprStart: i + 1, exprEnd: j });
      i = j; continue;
    }
    buf += c; i++;
  }
  flush();
  return { start, end: limit, raw, parts, nested: [] };
}

// ---- Context -------------------------------------------------------------------------------

const NAMED = new Set(["text", "title", "label", "placeholder", "contentDescription", "supportingText", "subtitle", "headline",
  "description", "message", "hint", "body", "caption", "summary", "actionLabel", "confirmLabel", "dismissLabel", "cta", "header",
  "prompt", "emptyMessage", "errorMessage", "helper", "helperText", "subhead", "detail", "buttonText", "primaryLabel",
  "secondaryLabel", "positiveText", "negativeText", "eyebrow", "heading", "tooltip", "stateDescription", "contentTitle", "contentText"]);
const NEVER_CALL = /(?:^|[^\w.])(Log\.[a-z]|ErrorLog\.\w+|println|print|Timber\.[a-z]|Regex|Uri\.parse|URL|URI|Intent|putExtra|getStringExtra|getString|getBoolean|getInt|getLong|put|contains|startsWith|endsWith|equals|indexOf|split|replace|removePrefix|removeSuffix|trim|JSONObject|optString|encodeToString|SerialName|SharedPreferences|getSharedPreferences|edit|putString|NotificationChannel\.id|Settings|System\.getProperty|setPackage|setAction|Class\.forName|MediaType|toMediaType|header|addHeader|setHeader|MessageDigest\.getInstance|Cipher\.getInstance|KeyStore\.getInstance|Mac\.getInstance|KeyGenerator\.getInstance|SecretKeySpec|Signature\.getInstance|getInstance)\s*\($/;

// Exceptions and checks: developer messages, unless written as a plain sentence for the person (those are shown).
const SOFT_CALL = /(?:^|[^\w.])(require|check|error|assert|checkNotNull|requireNotNull|throw\s+\w+|\w*Exception|\w*Error)\s*\(\s*$/;
const friendly = (t) => {
  const plain = t.replace(/\u0001/g, "x");
  return /^[A-Z][^]*[.!?]$/.test(plain) && plain.split(/\s+/).length >= 4
    && !/[a-z][A-Z]/.test(plain) && !/[_=(){}\[\]<>]|\w\.\w+\(|0x|\bnull\b/.test(plain);
};

function ctxBefore(src, pos) {
  // the text between the start of the line / statement and the literal, collapsed
  let i = pos - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  const c = src[i];
  const near = src.slice(Math.max(0, i - 160), i + 1);
  let kind = "other", name = null, callee = null;
  if (c === "(") {
    kind = "firstArg";
    callee = /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(Math.max(0, i - 80), i))?.[1] ?? null;
  } else if (c === "=" && src[i - 1] !== "=" && !"!<>".includes(src[i - 1])) {
    kind = "assign";
    name = /([A-Za-z_]\w*)\s*$/.exec(src.slice(Math.max(0, i - 60), i))?.[1] ?? null;
  } else if (c === ">" && src[i - 1] === "-") kind = "arrow";
  else if (c === "," ) {
    kind = "listArg";
    // is it a later positional arg of an FS* component call?
    const open = enclosingCallOpen(src, pos);
    callee = open >= 0 ? /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(Math.max(0, open - 80), open))?.[1] ?? null : null;
  } else if (c === ":" && /\b(val|var)\s+\w+\s*$/.test(src.slice(Math.max(0, i - 80), i))) kind = "typed";
  else if (c === "?" && src[i - 1] === ":") kind = "elvis";
  else if (src.slice(Math.max(0, i - 6), i + 1).match(/return$/)) kind = "return";
  else if (src.slice(Math.max(0, i - 4), i + 1).match(/else$/)) kind = "else";
  return { kind, name, callee, near };
}

function enclosingCallOpen(src, pos) {
  let depth = 0;
  for (let i = pos - 1, steps = 0; i >= 0 && steps < 1200; i--, steps++) {
    const c = src[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") { if (depth === 0) return c === "(" ? i : -1; depth--; }
  }
  return -1;
}

const UI_CALLEE = /^(Text|AnnotatedString|BasicText|FS\w+|Button|TextButton|OutlinedButton|Tab|NavigationBarItem|DropdownMenuItem|Snackbar|SnackbarVisuals|AssistChip|FilterChip|SuggestionChip|ListItem|Label|SectionHeader|Header|Card|Chip|\w*Button|\w*Row|\w*Field|\w*Banner|\w*Dialog|\w*Sheet|\w*Header|\w*Label|\w*Title|\w*Card|\w*Item|showSnack\w*|showToast|toast|snackbar\w*|Toast\.makeText)$/;

const looksLikeCode = (t) =>
  !/[A-Za-z\u00C0-\u024F\u3040-\u30ff\u4e00-\u9fff]{2}/.test(t) // no real word
  || /^[a-z0-9_.\-/:+@#%&=?]+$/.test(t) // identifier, path, url, mime
  || /^[a-z]+([A-Z][a-z0-9]+)+$/.test(t) // camelCase
  || /^[A-Z0-9_]+$/.test(t) // CONSTANT
  || /^[A-Z]{2,}(-[A-Z]{2,})+$/.test(t) // sample code AAAA-BBBB
  || /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]*$/.test(t) // key:value tokens
  || /[{}<>]/.test(t) && !/\s/.test(t) // JSON / tags
  || /^\w+\([^)]*\)$/.test(t) // fn()
  || /^(GET|POST|PUT|PATCH|DELETE|HEAD|Bearer|Basic|Authorization|Content-Type|Accept|User-Agent|Cache-Control|Host)\b/.test(t)
  || /^[A-Z][a-z]+(-[A-Z][a-z]+)+$/.test(t) // Header-Names
  || /^https?:/.test(t) || t.startsWith("/");

const looksProse = (t) => /^[A-Z\u00C0-\u00DE“‘(\u0001]/.test(t.replace(/^\u0001$/, "x")) && (/\s/.test(t) || /[.!?…:]$/.test(t));

/** Decide whether a literal is user-facing. Returns { yes, why }. */
function classify(src, lit, ctx, rel) {
  const text = literalText(lit);
  if (text === null) return { yes: false, why: "dynamic" };
  if (looksLikeCode(text.replace(/\u0001/g, "x"))) return { yes: false, why: "code-like" };
  if (/\b(yyyy|YYYY|MMM+|EEE+|hh?:mm|HH:mm|dd?\/|a\b.*\bh)\b/.test(text) && /[yMdEhHma]{2,}/.test(text)) return { yes: false, why: "date pattern" };
  const head = src.slice(Math.max(0, lit.start - 90), lit.start);
  if (/@\w+(\([^)]*)?$/.test(head) && !/\)\s*$/.test(head)) return { yes: false, why: "annotation" };
  if (NEVER_CALL.test(head.replace(/\s+$/, ""))) return { yes: false, why: "non-ui call" };
  if (/(==|!=)\s*$/.test(head) || /\b(when|in|is)\s*\(?\s*$/.test(head)) return { yes: false, why: "comparison" };
  const inUi0 = rel.startsWith("ui/") || rel.includes("/ui/");
  if (/^\s*to\b/.test(src.slice(lit.end, lit.end + 12))) return { yes: false, why: "pair key" };
  if (/^(OpenAI|Groq|Anthropic|Google|OpenRouter|Ollama|Mistral|Debian|Ubuntu|Fedora|Postgres|PostgreSQL|Docker|GitHub|GitLab|Forgejo|Chromium|Cloudflare|Fly|Hetzner|UpCloud|Apple|iCloud|Flagship|Android|iOS|macOS|Windows|Linux|WebAuthn|Face ID|Touch ID|Gemini|Claude|ChatGPT|Pro)$/.test(text)) return { yes: false, why: "brand" };
  if (ctx.kind === "firstArg" && ctx.callee && UI_CALLEE.test(ctx.callee.split(".").pop())) return { yes: true, why: `arg of ${ctx.callee}` };
  if (ctx.kind === "listArg" && ctx.callee && /^(FS\w+|Text)$/.test(ctx.callee)) return { yes: true, why: `arg of ${ctx.callee}` };
  if ((ctx.kind === "assign" || ctx.kind === "firstArg" || ctx.kind === "listArg") && ctx.name && NAMED.has(ctx.name)) return { yes: true, why: `${ctx.name}=` };
  if (ctx.kind === "assign" && ctx.name && NAMED.has(ctx.name)) return { yes: true, why: `${ctx.name}=` };
  const inUi = rel.startsWith("ui/") || rel.includes("/ui/");
  if (SOFT_CALL.test(head.replace(/\s+$/, "")) && !friendly(text)) return { yes: false, why: "exception message" };
  if (/(require|check|assert|checkNotNull|requireNotNull)\s*\([^)]*\)\s*\{\s*$/.test(head) && !friendly(text)) return { yes: false, why: "assertion message" };
  if (/^[A-Za-z][\w.]*:\s/.test(text) && !/^(Note|Warning|Error|Tip|Heads up|Step \d|Option|Reason|Result|Status):/i.test(text)) return { yes: false, why: "developer log" };
  if ((inUi ? /\bnull\b|0x[0-9a-f]+/i : /\.(kt|java|swift|json|xml|txt|ts)\b|\bnull\b|\bbyte(s)?\b.*(got|expected)|0x[0-9a-f]+/i).test(text)) return { yes: false, why: "developer message" };
  if (/^(just now|yesterday|today|tomorrow|never|none|unknown)$/.test(text) && /^(core|viewmodels|ui)\//.test(rel)) return { yes: true, why: "word" };
  if (looksProse(text) && !/^builder\/(usb|iso)\//.test(rel)) return { yes: true, why: "prose" };
  if (inUi && /^[A-Z\u0001]/.test(text) && /[a-z]/.test(text)) return { yes: true, why: "ui label" };
  // lower-case fragments that are joined into a line the person reads ("no proof yet", "last proof ...")
  if (/^[a-z][a-z',.\u0001 -]*[a-z.\u0001]$/.test(text) && / /.test(text) && inUi && /[a-z]{3}/.test(text.replace(/\u0001/g, ""))) return { yes: true, why: "fragment" };
  if ((ctx.kind === "arrow" || ctx.kind === "return" || ctx.kind === "else" || ctx.kind === "elvis") && /^[A-Z]/.test(text) && inUi) return { yes: true, why: "branch value" };
  return { yes: false, why: "not user-facing" };
}

function literalText(lit) {
  if (lit.parts.some((p) => p.expr !== undefined && /^\s*$/.test(p.expr))) return null;
  return lit.parts.map((p) => (p.text !== undefined ? p.text : "\u0001")).join("");
}

/** The text as it is stored in the resource file: template arguments become %1$s, %2$s, and a literal % is doubled only when the string is formatted. */
function resourceText(marked) {
  const argc = (marked.match(/\u0001/g) ?? []).length;
  if (!argc) return marked;
  let n = 0;
  return marked.replace(/%/g, "%%").replace(/\u0001/g, () => `%${++n}$s`);
}

// ---- Statement context (function body or declaration initialiser?) --------------------------

/** For each position, is it inside a function body? A light brace/keyword walk that skips strings & comments. */
function funRegions(src, lits) {
  // mask strings/comments with spaces so keyword/brace scanning is safe
  const masked = maskSource(src);
  const regions = []; // [start,end) of function bodies (block or expression) and property accessors
  const all = []; // every brace region with its kind (fun | class | block)
  const stack = []; // {kind, start}
  const re = /\bfun\b|\bclass\b|\binterface\b|\bobject\b|\binit\b|\bget\s*\(\s*\)|\bset\s*\(|[{}]/g;
  let m, pending = null, parenDepth = 0, last = 0;
  const kinds = [];
  const tokens = [...masked.matchAll(re)];
  for (let t = 0; t < tokens.length; t++) {
    m = tokens[t];
    const tok = m[0];
    if (tok === "{") {
      // what is this brace? read the declaration header before it, skipping balanced (...) and {...}
      // groups so a default argument such as `onClose: () -> Unit = {}` does not cut the header short
      const seg = headerBefore(masked, m.index);
      const isFun = /\bfun\b/.test(seg) || /(?:^|\n)\s*init\s*$/.test(seg) || /\bconstructor\s*\((…)?\)[^{]*$/.test(seg)
        || /\bget\s*\(\)\s*(:\s*[\w<>?, .]+)?\s*$/.test(seg) || /\bset\s*\(…\)\s*$/.test(seg);
      const isClass = !isFun && /\b(class|object|interface)\b/.test(seg);
      kinds.push({ kind: isFun ? "fun" : isClass ? "class" : "block", start: m.index });
    } else if (tok === "}") {
      const top = kinds.pop();
      if (top) all.push({ start: top.start, end: m.index, kind: top.kind });
      if (top && top.kind === "fun") regions.push([top.start, m.index]);
    }
  }
  // expression-bodied functions and getters:  fun name(...) [: T] = <expr>   /   get() = <expr>
  const exprBodies = [];
  for (const fm of masked.matchAll(/\bfun\b/g)) {
    // fun [<T>] [Recv.]name ( ...params... ) [: Type] ( = | { )
    let i = fm.index + 3;
    const open = masked.indexOf("(", i);
    if (open < 0) continue;
    if (/[={]/.test(masked.slice(i, open))) continue; // `fun` used as a word, or generics with defaults
    let d = 0, j = open;
    for (; j < masked.length; j++) { if (masked[j] === "(") d++; else if (masked[j] === ")") { d--; if (d === 0) break; } }
    const after = masked.slice(j + 1, j + 400);
    const m = /^\s*(?::\s*[\w<>?, .()\-]+?)?\s*=(?!=)/.exec(after);
    if (m) exprBodies.push({ index: fm.index, 0: masked.slice(fm.index, j + 1 + m[0].length) });
  }
  for (const gm of masked.matchAll(/\bget\s*\(\s*\)\s*(?::\s*[\w<>?, .]+)?\s*=(?!=)/g)) exprBodies.push({ index: gm.index, 0: gm[0] });
  for (const fm of exprBodies) {
    const head = fm[0];
    let d = 0;
    for (const ch of head) { if (ch === "(") d++; else if (ch === ")") d--; }
    if (d !== 0) continue;
    // a signature that ends at a newline (abstract/interface fun) is not followed by `= expr`
    let dd = 0, broke = false;
    for (let q = 0; q < head.length; q++) {
      const ch = head[q];
      if (ch === "(") dd++; else if (ch === ")") dd--;
      else if (ch === "\n" && dd === 0) {
        const nxt = head.slice(q + 1).match(/^\s*(\S+)/)?.[1] ?? "";
        if (!/^(:|=|where\b)/.test(nxt)) { broke = true; break; }
      }
    }
    if (broke) continue;
    let start = fm.index + head.length;
    while (start < masked.length && /\s/.test(masked[start])) start++;
    // end: first newline at depth 0 that does not continue the expression (an operator ends the line, or the next line starts with one)
    let depth = 0, k = start;
    for (; k < masked.length; k++) {
      const ch = masked[k];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { depth--; if (depth < 0) break; }
      else if (ch === "\n" && depth === 0) {
        const lineEnd = masked.slice(0, k).replace(/[ \t]+$/, "").slice(-2);
        if (/(\+|-|\*|\/|&&|\|\||\?:|->|=|,)$/.test(lineEnd)) continue;
        const rest = masked.slice(k + 1).match(/^\s*(\S+)/)?.[1] ?? "";
        if (!/^(\.|\?\.|\?:|&&|\|\||\+|-|\*|\/|\)|,|else\b|->)/.test(rest)) break;
      }
    }
    regions.push([start, k]);
  }
  regions.all = all;
  // paren depth before each position, so a `val` inside a constructor's parentheses is not mistaken for a property
  const depth = new Int32Array(masked.length + 1);
  for (let i = 0, d = 0; i < masked.length; i++) { depth[i] = d; if (masked[i] === "(") d++; else if (masked[i] === ")") d--; }
  regions.parenDepth = depth;
  return regions;
}

/** The declaration text just before a `{`, top-level text only (balanced groups skipped), back to the previous statement boundary. */
function headerBefore(masked, brace) {
  let depth = 0, out = "", closeAt = -1;
  for (let i = brace - 1; i >= 0 && brace - i < 40000; i--) {
    const c = masked[i];
    if (c === ")" || c === "}" || c === "]") { if (depth === 0 && c === "}") break; if (depth === 0) closeAt = i; depth++; continue; }
    if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) break;
      depth--;
      if (depth === 0 && c === "(") out = (/^\s*$/.test(masked.slice(i + 1, closeAt)) ? "()" : "(…)") + out;
      continue;
    }
    if (depth === 0) { if (c === ";") break; out = c + out; }
    if (depth === 0 && c === "\n") {
      const prevLine = masked.slice(masked.lastIndexOf("\n", i - 1) + 1, i).trim();
      if (prevLine === "") break;
    }
  }
  return out;
}

function maskSource(src) {
  const out = src.split("");
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== "\n") out[i] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; blank(i, e); i = e; continue; }
    if (c === "/" && src[i + 1] === "*") { let d = 1, j = i + 2; while (j < src.length && d > 0) { if (src[j] === "/" && src[j + 1] === "*") { d++; j += 2; } else if (src[j] === "*" && src[j + 1] === "/") { d--; j += 2; } else j++; } blank(i, j); i = j; continue; }
    if (c === "'") { const e = src[i + 1] === "\\" ? src.indexOf("'", i + 2) + 1 : i + 3; blank(i, e); i = e; continue; }
    if (c === '"') { const lit = readString(src, i, src.length); blank(i + 1, lit.end - 1); i = lit.end; continue; }
    i++;
  }
  return out.join("");
}

function insideFun(regions, pos) { return regions.some(([a, b]) => pos >= a && pos < b); }

/** Is pos inside the parentheses of a fun / class / constructor header (a default argument)? Those run at call time. */
function inDeclarationParams(masked, pos) {
  let at = pos;
  for (let hops = 0; hops < 12; hops++) {
    const open = enclosingParen(masked, at);
    if (open < 0) return false;
    const header = masked.slice(Math.max(0, open - 160), open);
    if (/\b(fun|class)\s+[\w.<>?, ]*$/.test(header) || /\bconstructor\s*$/.test(header)) return true;
    // a supertype constructor call:  class X(...) : Base("...")   /   object Y : Base("...")
    if (/\b(class|object)\s+\w+[^{;]*:\s*[\w.<>?]+\s*$/.test(header.replace(/\n/g, " "))) return true;
    at = open;
  }
  return false;
}

/** The nearest unmatched "(" before pos, looking through lambdas and brackets. -1 when there is none. */
function enclosingParen(masked, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0 && pos - i < 60000; i--) {
    const c = masked[i];
    if (c === ")") depth++;
    else if (c === "(") { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** The innermost brace region around pos: "class" for a class/object body, "fun"/"block" otherwise, null at top level. */
function innermostKind(regions, pos) {
  let best = null;
  for (const r of regions.all ?? []) if (pos > r.start && pos < r.end && (!best || r.start > best.start)) best = r;
  return best ? best.kind : null;
}

// ---- Key naming ----------------------------------------------------------------------------

const JAVA_KEYWORDS = new Set(["abstract","assert","boolean","break","byte","case","catch","char","class","const","continue","default","do","double","else","enum","extends","final","finally","float","for","goto","if","implements","import","instanceof","int","interface","long","native","new","package","private","protected","public","return","short","static","strictfp","super","switch","synchronized","this","throw","throws","transient","try","void","volatile","while","true","false","null","as","fun","in","is","object","typealias","typeof","val","var","when"]);

function slugOf(text) {
  const words = text.replace(/%\d*\$?s/g, " ").replace(/['’]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let s = words.slice(0, 6).join("_");
  if (s.length > 44) s = s.slice(0, 44).replace(/_[^_]*$/, "");
  if (!s) s = "text";
  if (/^[0-9]/.test(s)) s = "n_" + s;
  if (JAVA_KEYWORDS.has(s)) s = `${s}_label`;
  return s;
}

// ---- Resource XML --------------------------------------------------------------------------

function xmlEscape(t) {
  return t
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/\n/g, "\\n").replace(/\t/g, "\\t")
    .replace(/^([@?])/, "\\$1")
    .replace(/^(\s)/, "\\u0020").replace(/(\s)$/, (m) => (m === " " ? "\\u0020" : m));
}

function emitXml(entries, tr, withTranslatable) {
  const lines = [];
  for (const [key, v] of entries) {
    const text = tr ? tr[key] : v.en;
    if (text == null) continue;
    if (typeof text === "object") {
      lines.push(`    <plurals name="${key}">`);
      for (const [form, t] of Object.entries(text)) lines.push(`        <item quantity="${form}">${xmlEscape(t)}</item>`);
      lines.push("    </plurals>");
    } else {
      const attrs = v.translatable === false ? ' translatable="false"' : "";
      lines.push(`    <string name="${key}"${attrs}>${xmlEscape(text)}</string>`);
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- GENERATED by scripts/i18n-android.mjs from i18n/${tr ? "…/<lang>" : "…/en"}.json. Edit the JSON (or the code and re-extract), not this file. -->\n<resources>\n${lines.join("\n")}\n</resources>\n`;
}

// ---- extract -------------------------------------------------------------------------------

function listKt(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(build|\.gradle|androidTest|test)$/.test(e.name)) walk(p); }
      else if (p.endsWith(".kt")) out.push(p);
    }
  })(root);
  return out;
}

function extract() {
  const M = MODULES[moduleName];
  const base = path.join(ROOT, M.dir);
  const kt = listKt(path.join(base, M.pkgDir));
  const existing = readEn(M.surface);
  const byText = new Map(Object.entries(existing).map(([k, v]) => [v.en, k]));
  // hand-written entries that predate the extraction (manifest and widget metadata read them)
  const entries = { ...SEED[M.surface], ...existing };
  const report = { rewritten: 0, files: 0, skipped: [], dynamic: [] };
  const plans = [];

  for (const file of kt) {
    const rel = path.relative(path.join(base, M.pkgDir), file);
    if (/\/(res|build)\//.test(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const lits = foldConcats(src, scanLiterals(src));
    const regions = funRegions(src, lits);
    const masked = maskSource(src);
    const inUi = M.uiDirs.some((d) => rel.startsWith(d));
    const edits = []; // { start, end, replacement }

    const visit = (lit) => {
      // nested literals inside templates are handled first (their own resources) and then the outer
      // literal is rewritten using the already-edited expression source.
      for (const p of lit.parts) for (const n of p.nested ?? []) visit(n);
      const ctx = ctxBefore(src, lit.start);
      const cls = classify(src, lit, ctx, rel);
      const text = literalText(lit);
      if (!cls.yes) {
        if (text && /^[A-Z][^"]{2,}/.test(text) && cls.why !== "code-like") report.skipped.push(`${rel}:${lineOf(src, lit.start)} [${cls.why}] ${JSON.stringify(text).slice(0, 90)}`);
        return;
      }
      let declaration = false;
      if (!insideFun(regions, lit.start) && !inDeclarationParams(masked, lit.start)) {
        const g = valDeclaration(src, lit.start, regions);
        if (!g) {
          report.dynamic.push(`${rel}:${lineOf(src, lit.start)} [declaration initialiser] ${JSON.stringify(text).slice(0, 90)}`);
          return;
        }
        declaration = true;
        for (const e of g) if (!edits.some((x) => x.start === e.start && x.end === e.end)) edits.push(e);
      }
      // build argument list from template expressions (with nested edits applied)
      const argsSrc = [];
      for (const p of lit.parts) if (p.expr !== undefined) argsSrc.push(applyEdits(src, edits, p.exprStart, p.exprEnd).trim());
      const stored = resourceText(text);
      let key = byText.get(stored);
      if (!key) {
        key = slugOf(stored.replace(/%\d+\$s/g, " "));
        let k = key, n = 2;
        while (entries[k] && entries[k].en !== stored) k = `${key}_${n++}`;
        key = k;
        entries[key] = { en: stored, ctx: `${rel}:${lineOf(src, lit.start)} (${cls.why})`, ...(argsSrc.length ? { args: argsSrc.length } : {}) };
        byText.set(stored, key);
      }
      const composableCtx = inUi && !declaration;
      const call = composableCtx ? (argsSrc.length ? "fsString" : "stringResource") : "FSStrings.get";
      const rep = `${call}(R.string.${key}${argsSrc.length ? ", " + argsSrc.join(", ") : ""})`;
      edits.push({ start: lit.start, end: lit.end, replacement: rep, nestedOf: lit });
      report.rewritten++;
    };
    for (const lit of lits) visit(lit);
    if (edits.length) plans.push({ file, rel, src, edits, inUi });
  }

  fs.writeFileSync("/tmp/i18n-android-accepted.json", JSON.stringify(Object.entries(entries).map(([k, v]) => ({ k, en: v.en, ctx: v.ctx })), null, 1));
  console.log(`${plans.length} files, ${report.rewritten} literals -> ${Object.keys(entries).length} resources`);
  fs.writeFileSync("/tmp/i18n-android-skipped.txt", report.skipped.join("\n"));
  fs.writeFileSync("/tmp/i18n-android-dynamic.txt", report.dynamic.join("\n"));
  console.log(`skipped capitalised literals: ${report.skipped.length} (/tmp/i18n-android-skipped.txt); declaration initialisers: ${report.dynamic.length} (/tmp/i18n-android-dynamic.txt)`);
  if (flag("--dry")) return;

  for (const p of plans) {
    let out = applyEditsOuter(p.src, p.edits);
    out = ensureImports(out, p.inUi);
    fs.writeFileSync(p.file, out);
  }
  applyManual(entries, M, base);
  writeEn(M.surface, entries);
  buildOne(moduleName);
}

/** scripts/i18n-android.manual.json: plural resources and the few edits no heuristic can make. */
function applyManual(entries, M, base) {
  const manual = moduleName === "app" ? JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/i18n-android.manual.json"), "utf8")) : { strings: {}, plurals: {}, edits: [] };
  for (const [k, v] of Object.entries(manual.strings ?? {})) entries[k] ??= v;
  for (const [k, v] of Object.entries(manual.plurals ?? {})) entries[k] = { en: { one: v.one, other: v.other }, ctx: v.ctx, plural: true };
  for (const e of manual.edits) {
    const f = path.join(base, M.pkgDir, e.file);
    const src = fs.readFileSync(f, "utf8");
    if (src.includes(e.find)) fs.writeFileSync(f, ensureImports(src.replace(e.find, e.replace), true));
  }
  // resources nothing refers to any more (a manual edit replaced their only use): drop them
  const used = new Set();
  const scan = (text) => { for (const m of text.matchAll(/R\.(?:string|plurals)\.(\w+)|@(?:string|plurals)\/(\w+)/g)) used.add(m[1] ?? m[2]); };
  for (const f of listKt(path.join(base, M.pkgDir))) scan(fs.readFileSync(f, "utf8"));
  scan(fs.readFileSync(path.join(base, "AndroidManifest.xml"), "utf8"));
  for (const d of ["xml", "values", "layout"]) {
    const dir = path.join(base, M.res, d);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".xml") && f !== "strings.xml") scan(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  for (const k of Object.keys(entries)) if (!used.has(k) && !SEED[M.surface][k] && !(manual.strings ?? {})[k]) delete entries[k];
}

const lineOf = (src, pos) => src.slice(0, pos).split("\n").length;

/** Source text of [a,b) with any edits that fall inside applied (used for template expressions). */
function applyEdits(src, edits, a, b) {
  const inside = edits.filter((e) => e.start >= a && e.end <= b).sort((x, y) => x.start - y.start);
  let out = "", i = a;
  for (const e of inside) { out += src.slice(i, e.start) + e.replacement; i = e.end; }
  return out + src.slice(i, b);
}

/** Apply only outermost edits (nested ones were folded into their parent's replacement). */
function applyEditsOuter(src, edits) {
  const sorted = [...edits].sort((x, y) => x.start - y.start || y.end - x.end);
  const outer = [];
  for (const e of sorted) if (!outer.some((o) => e.start >= o.start && e.end <= o.end)) outer.push(e);
  let out = "", i = 0;
  for (const e of outer) { out += src.slice(i, e.start) + e.replacement; i = e.end; }
  return out + src.slice(i);
}

/**
 * A string inside the initialiser of `val NAME = ...` (top level or in a class/object body) cannot read a
 * resource at class-load time, so the property becomes a getter (`val NAME get() = ...`) and each read
 * looks the text up. Returns the edits that do that, or null when the literal is not in such a property
 * (an enum entry, a constructor default, `by lazy { }`), which are reported for a hand edit.
 */
function valDeclaration(src, pos, regions) {
  const from = Math.max(0, pos - 4000);
  const window = src.slice(from, pos);
  const re = /^[ \t]*((?:private|internal|public|protected|override|const|open|final)\s+)*val\s+\w+\s*(?::[^=\n{]*?)?\s*=(?!=)/gm;
  let m, last = null;
  while ((m = re.exec(window))) last = m;
  if (!last) return null;
  const declStart = from + last.index;
  const where = innermostKind(regions, declStart);
  if (where !== null && where !== "class") return null; // a local val inside a function, lambda or init block
  if (regions.parenDepth && regions.parenDepth[declStart] > 0) return null; // a constructor / parameter, not a property
  const eq = declStart + last[0].length - 1;
  const masked = maskSource(src.slice(declStart, pos));
  const between = masked.slice(last[0].length);
  let depth = 0;
  for (const ch of between) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; if (depth < 0) return null; }
  if (depth === 0 && /\n/.test(between.trim()) ) {
    // a newline at depth 0 may continue the expression (operator / elvis) or end it
    const afterNl = between.slice(between.lastIndexOf("\n") + 1);
    if (!/^\s*(\.|\?\.|\?:|&&|\|\||\+)/.test(afterNl) && !/(\+|\?:|&&|\|\|)\s*\n/.test(between)) return null;
  }
  if (/\bfun\b|\blazy\b|\bby\b/.test(between)) return null;
  if (/\bget\s*\(\s*\)/.test(last[0])) return []; // already a getter
  const edits = [{ start: eq, end: eq + 1, replacement: "get() =" }];
  const constM = /\bconst\s+/.exec(src.slice(declStart, eq));
  if (constM) edits.push({ start: declStart + constM.index, end: declStart + constM.index + constM[0].length, replacement: "" });
  return edits;
}

function ensureImports(src, ui) {
  const need = [];
  if (/\bstringResource\(/.test(src) && !/import androidx\.compose\.ui\.res\.stringResource/.test(src)) need.push("import androidx.compose.ui.res.stringResource");
  if (moduleName === "app" && /\bfsString\(/.test(src) && !/import com\.flagshipserver\.app\.core\.fsString/.test(src) && !/^package com\.flagshipserver\.app\.core$/m.test(src)) need.push("import com.flagshipserver.app.core.fsString");
  if (moduleName === "app" && /\bFSStrings\./.test(src) && !/import com\.flagshipserver\.app\.core\.FSStrings/.test(src) && !/^package com\.flagshipserver\.app\.core$/m.test(src)) need.push("import com.flagshipserver.app.core.FSStrings");
  const pkg = /^package ([\w.]+)/m.exec(src)?.[1];
  const rPkg = moduleName === "wear" ? "com.flagshipserver.wear.R" : "com.flagshipserver.app.R";
  if (/\bR\.string\./.test(src) && pkg !== "com.flagshipserver.app" && !(moduleName === "wear" && pkg === "com.flagshipserver.wear") && !new RegExp(`import ${rPkg.replace(/\./g, "\\.")}$`, "m").test(src)) need.push(`import ${rPkg}`);
  if (!need.length) return src;
  const m = /^import .*$/m.exec(src);
  if (m) return src.replace(m[0], need.join("\n") + "\n" + m[0]);
  return src.replace(/^package .*$/m, (p) => `${p}\n\n${need.join("\n")}`);
}

// ---- build ---------------------------------------------------------------------------------

function androidDir(l) { return l.androidId.includes("+") ? l.androidId : l.androidId; }

/** Every resource file `build` writes for one module, path -> contents (the check compares against the same list). */
function outputsOf(mod, withDrafts = false) {
  const M = MODULES[mod];
  const resDir = path.join(ROOT, M.dir, M.res);
  const en = readEn(M.surface);
  const entries = Object.entries(en);
  const out = { [path.join(resDir, "values/strings.xml")]: emitXml(entries, null) };
  for (const l of targets) {
    if (l.status !== "ga" && !withDrafts) continue; // a draft language is generated only on request, like the iOS catalogs
    const tr = readTr(M.surface, l.code);
    if (!Object.keys(tr).length) continue;
    out[path.join(resDir, `values-${androidDir(l)}`, "strings.xml")] = emitXml(entries.filter(([k]) => tr[k] != null), tr);
  }
  if (mod === "app") {
    const ga = locales.locales.filter((l) => l.status === "ga" && l.code !== locales.source);
    out[path.join(resDir, "xml/locales_config.xml")] = `<?xml version="1.0" encoding="utf-8"?>\n<!-- GENERATED by scripts/i18n-android.mjs from i18n/locales.json (ga languages only). -->\n<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n    <locale android:name="en" />\n${ga.map((l) => `    <locale android:name="${l.code}" />`).join("\n")}\n</locale-config>\n`;
  }
  return out;
}

function buildOne(mod) {
  const out = outputsOf(mod, process.argv.includes("--drafts"));
  for (const [f, body] of Object.entries(out)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  console.log(`${mod}: wrote values/ and ${Object.keys(out).filter((f) => /values-[^/]+\/strings\.xml$/.test(f)).length} translated value sets`);
}

// ---- fix: compile errors -> FSStrings --------------------------------------------------------

/**
 * `extract` writes stringResource(...) inside ui/ because that is right inside a Composable. Where the
 * Kotlin compiler says a call is not in a Composable context (a click handler, a helper function, a
 * try/catch), this switches exactly those calls to FSStrings.get(...). Input: the compiler's `e:` lines.
 */
function fixFromErrors(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => /^e: /.test(l));
  const byFile = new Map();
  for (const l of lines) {
    const m = /^e: file:\/\/(.+\.kt):(\d+):(\d+) (.*)$/.exec(l);
    if (!m) continue;
    (byFile.get(m[1]) ?? byFile.set(m[1], []).get(m[1])).push({ line: Number(m[2]), col: Number(m[3]), msg: m[4] });
  }
  let changed = 0;
  for (const [f, errs] of byFile) {
    let src = fs.readFileSync(f, "utf8");
    const offsetOf = (line, col) => { let off = 0; for (let i = 1; i < line; i++) off = src.indexOf("\n", off) + 1; return off + col - 1; };
    const spans = [];
    for (const e of errs) {
      const at = offsetOf(e.line, e.col);
      if (/@Composable invocations can only happen/.test(e.msg)) {
        const m0 = /(stringResource|fsString)\(/g; m0.lastIndex = Math.max(0, at - 2);
        const hit = m0.exec(src);
        if (hit && hit.index - at < 40) spans.push([hit.index, hit.index + hit[0].length]);
      } else if (/Functions which invoke @Composable functions must be marked|Try catch is not supported around composable/.test(e.msg)) {
        const open = src.indexOf("{", at);
        const eq = src.indexOf("=", at);
        let a = at, b;
        if (/Try catch/.test(e.msg)) { const t = src.lastIndexOf("try", at + 3); a = t >= 0 ? t : at; b = matchBrace(src, src.indexOf("{", a)); }
        else if (open >= 0 && (eq < 0 || open < eq || /\bfun\b[^=]*\{/.test(src.slice(at, open + 1)))) b = matchBrace(src, open);
        else b = src.indexOf("\n", at);
        for (const m of src.slice(a, b).matchAll(/(?:stringResource|fsString)\(/g)) spans.push([a + m.index, a + m.index + m[0].length]);
      }
    }
    // `const val X = <now a lookup>`: a constant cannot call anything, so it becomes a getter
    for (const e of errs) {
      if (!/Const 'val' initializer should be a constant value/.test(e.msg)) continue;
      const at = offsetOf(e.line, e.col);
      const head = src.slice(Math.max(0, at - 600), at);
      const ms = [...head.matchAll(/const\s+val\s+(\w+)(\s*:\s*[\w<>?., ]+?)?\s*=/g)];
      const m = ms[ms.length - 1];
      if (!m) continue;
      const base = Math.max(0, at - 600) + m.index;
      spans.push({ a: base, b: base + m[0].length, text: `val ${m[1]}${m[2] ?? ""} get() =` });
    }
    const norm2 = spans.map((x) => (Array.isArray(x) ? { a: x[0], b: x[1], text: "FSStrings.get(" } : x));
    const uniq = [...new Map(norm2.map((x) => [x.a, x])).values()].sort((x, y) => y.a - x.a);
    for (const { a, b, text } of uniq) { src = src.slice(0, a) + text + src.slice(b); changed++; }
    if (moduleName === "app" && uniq.length && !/import com\.flagshipserver\.app\.core\.FSStrings/.test(src) && !/^package com\.flagshipserver\.app\.core$/m.test(src)) {
      src = src.replace(/^import .*$/m, (m0) => `import com.flagshipserver.app.core.FSStrings\n${m0}`);
    }
    fs.writeFileSync(f, src);
  }
  console.log(`switched ${changed} stringResource calls to FSStrings.get`);
}

function matchBrace(src, open) {
  if (open < 0) return src.length;
  const masked = maskSource(src.slice(open));
  let d = 0;
  for (let i = 0; i < masked.length; i++) { if (masked[i] === "{") d++; else if (masked[i] === "}") { d--; if (d === 0) return open + i; } }
  return src.length;
}

// ---- dispatch ------------------------------------------------------------------------------
if (process.env.I18N_DEBUG_FILE) {
  const f = process.env.I18N_DEBUG_FILE, line = Number(process.env.I18N_DEBUG_LINE);
  const src = fs.readFileSync(f, "utf8");
  const regions = funRegions(src, []);
  const pos = src.split("\n").slice(0, line - 1).join("\n").length + 1;
  console.log("inside fun:", insideFun(regions, pos), "innermost:", innermostKind(regions, pos));
  console.log("regions containing:", (regions.all ?? []).filter((r) => pos > r.start && pos < r.end).map((r) => `${r.kind}@${src.slice(0, r.start).split("\n").length}-${src.slice(0, r.end).split("\n").length}`).join(" "));
  process.exit(0);
}

if (cmd === "extract") extract();
else if (cmd === "fix") fixFromErrors(args[1]);
else if (cmd === "build") for (const mod of args.includes("--module") ? [moduleName] : Object.keys(MODULES)) buildOne(mod);
else if (cmd === "add") {
  const M = MODULES[moduleName];
  const en = readEn(M.surface);
  if (!en[args[1]]) { en[args[1]] = { en: args[2], ctx: args[3] ?? "added by hand" }; writeEn(M.surface, en); }
  console.log(`${args[1]}: ${en[args[1]].en}`);
}
else if (cmd === "check") {
  const problems = [];
  for (const mod of Object.keys(MODULES)) {
    const M = MODULES[mod];
    problems.push(...lintSurface(M.surface));
    const en = readEn(M.surface);
    if (Object.keys(en).length) for (const [f, want] of Object.entries(outputsOf(mod))) {
      if (!fs.existsSync(f)) problems.push(`${path.relative(ROOT, f)} is missing: run node scripts/i18n-android.mjs build`);
      else if (fs.readFileSync(f, "utf8") !== want) problems.push(`${path.relative(ROOT, f)} is stale: run node scripts/i18n-android.mjs build`);
    }
    for (const l of locales.locales.filter((x) => x.status === "ga" && x.code !== locales.source)) {
      const tr = readTr(M.surface, l.code);
      const missing = Object.keys(en).filter((k) => tr[k] == null && en[k].translatable !== false);
      if (missing.length) problems.push(`${M.surface}/${l.code} is ga but lacks ${missing.length} strings (first: ${missing[0]})`);
    }
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-android: ok");
} else if (!runCommon(MODULES[moduleName].surface, args)) {
  console.error("usage: i18n-android.mjs extract [--dry] | build [--drafts] | check | dump | merge | status | lint   [--module app|wear]");
  process.exit(2);
}
