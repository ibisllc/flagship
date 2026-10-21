#!/usr/bin/env node
// i18n-ios — localisation for the iPhone/iPad app, its widgets, the Watch app and the Watch widgets.
//
//   node scripts/i18n-ios.mjs wrap [--dry]
//        Swift code that builds a plain String from a literal (error text, helper output, constants,
//        arguments of our own components) is rewritten to String(localized: "…"). SwiftUI's own
//        initialisers (Text, Label, Button, navigationTitle …) already treat a literal as a key and are left alone.
//   node scripts/i18n-ios.mjs harvest <DerivedData>
//        reads the .stringsdata files the compiler writes (build with SWIFT_EMIT_LOC_STRINGS=YES) and
//        updates i18n/<surface>/en.json — the keys, with the exact %@ / %lld format the compiler derived.
//   node scripts/i18n-ios.mjs build [--drafts]     i18n/<surface>/*.json -> <target>/Resources/Localizable.xcstrings
//   node scripts/i18n-ios.mjs check                fail on drift, bad placeholders, missing strings in a ga language
//   node scripts/i18n-ios.mjs dump|merge|status|lint [--surface ios|watch|ios-widgets]
//
// Surfaces map to bundles, because a string is looked up in the bundle of the app that runs it:
//   ios          the iPhone app, FlagshipUI and the shared packages' text      -> App/Resources/Localizable.xcstrings
//   ios-widgets  the widget / Live Activity extension                          -> App/WidgetExtension/Localizable.xcstrings
//   watch        the Watch app and the Watch widgets                           -> App/WatchApp/Localizable.xcstrings
// Only "ga" languages are written to a catalog unless --drafts is given, so an unreviewed translation
// cannot ship by accident.

import fs from "node:fs";
import path from "node:path";
import { ROOT, locales, targets, readEn, writeEn, readTr, runCommon, lintSurface } from "./lib/i18n-kv.mjs";

const IOS = path.join(ROOT, "apps/mobile/ios");
const SURFACES = {
  ios: { catalog: "App/Resources/Localizable.xcstrings" },
  "ios-widgets": { catalog: "App/WidgetExtension/Localizable.xcstrings" },
  watch: { catalog: "App/WatchApp/Localizable.xcstrings" },
  "watch-widgets": { catalog: "App/WatchWidgets/Localizable.xcstrings" },
  "ios-infoplist": { catalog: "App/Resources/InfoPlist.xcstrings", table: "InfoPlist" },
  // Flagship Studio for macOS is a SwiftPM executable packaged into an .app by its Makefile, so it gets plain
  // <lang>.lproj/Localizable.strings files (copied into Contents/Resources) instead of a compiled catalog.
  "studio-mac": { lproj: "../../builder-mac/Resources" },
};
// Permission prompts and the display name live in Info.plist; iOS localises them from InfoPlist.xcstrings.
const INFOPLIST_SEED = {
  NSCameraUsageDescription: { en: "Flagship uses the camera to scan a pairing QR shown by your server.", ctx: "App/project.yml INFOPLIST_KEY_NSCameraUsageDescription" },
  NSFaceIDUsageDescription: { en: "Flagship uses Face ID to confirm sensitive actions like approving unlock or revoking a server.", ctx: "App/project.yml INFOPLIST_KEY_NSFaceIDUsageDescription" },
  NSLocalNetworkUsageDescription: { en: "Flagship talks to your server directly when it's on the same network, which is faster than going through the relay.", ctx: "App/project.yml INFOPLIST_KEY_NSLocalNetworkUsageDescription" },
  CFBundleDisplayName: { en: "Flagship", ctx: "app name under the icon", translatable: false },
};
// Which bundle runs a source file. Package code (FlagshipUI, FlagshipCore, FlagshipAPI …) runs in the
// iPhone app (and a few strings in the watch app, which then also lists them).
function surfacesOf(source) {
  if (/\/apps\/builder-mac\//.test(source)) return ["studio-mac"];
  if (/\/App\/WidgetExtension\//.test(source)) return ["ios-widgets"];
  if (/\/App\/WatchWidgets\//.test(source)) return ["watch-widgets"];
  if (/\/App\/WatchApp\//.test(source)) return ["watch"];
  return ["ios"];
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const surfaceArg = args.includes("--surface") ? args[args.indexOf("--surface") + 1] : "ios";

// ---- Swift lexing --------------------------------------------------------------------------

/** String literals of a Swift source: { start, end, parts:[{text}|{expr,start,end,nested}], multiline }. */
function scanSwift(src, from = 0, to = src.length) {
  const out = [];
  let i = from;
  while (i < to) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      let d = 1; i += 2;
      while (i < to && d > 0) { if (src[i] === "/" && src[i + 1] === "*") { d++; i += 2; } else if (src[i] === "*" && src[i + 1] === "/") { d--; i += 2; } else i++; }
      continue;
    }
    if (c === "#" || c === '"') {
      const m = /^(#*)("""|")/.exec(src.slice(i, i + 12));
      if (m && (c === '"' || /^#+"/.test(src.slice(i, i + 12)))) {
        const lit = readSwiftString(src, i, m[1].length, m[2] === '"""', to);
        out.push(lit);
        i = lit.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

function readSwiftString(src, start, hashes, multi, limit) {
  const open = hashes + (multi ? 3 : 1);
  const close = (multi ? '"""' : '"') + "#".repeat(hashes);
  const esc = "\\" + "#".repeat(hashes);
  let i = start + open;
  const parts = [];
  let buf = "";
  const flush = () => { if (buf) { parts.push({ text: buf }); buf = ""; } };
  while (i < limit) {
    if (src.startsWith(close, i)) { flush(); return { start, end: i + close.length, parts, multi, raw: hashes > 0 }; }
    if (src.startsWith(esc + "(", i)) {
      flush();
      let depth = 1, j = i + esc.length + 1;
      while (j < limit && depth > 0) {
        const ch = src[j];
        if (ch === '"' || (ch === "#" && /^#+"/.test(src.slice(j, j + 8)))) {
          const m = /^(#*)("""|")/.exec(src.slice(j, j + 12));
          j = readSwiftString(src, j, m[1].length, m[2] === '"""', limit).end;
        } else { if (ch === "(") depth++; else if (ch === ")") depth--; j++; }
      }
      parts.push({ expr: src.slice(i + esc.length + 1, j - 1), start: i + esc.length + 1, end: j - 1, nested: scanSwift(src, i + esc.length + 1, j - 1) });
      i = j; continue;
    }
    if (src.startsWith(esc, i)) {
      const n = src[i + esc.length];
      if (hashes === 0 && n === "u") { const e = src.indexOf("}", i); buf += String.fromCodePoint(parseInt(src.slice(i + 3, e), 16)); i = e + 1; continue; }
      buf += { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "'": "'", "\\": "\\" }[n] ?? n;
      i += esc.length + 1; continue;
    }
    if (!multi && src[i] === "\n") break; // unterminated: bail out
    buf += src[i]; i++;
  }
  flush();
  return { start, end: limit, parts, multi, raw: hashes > 0 };
}

const textOf = (lit) => lit.parts.map((p) => (p.text !== undefined ? p.text : "\u0001")).join("");

// ---- Classification ------------------------------------------------------------------------

// SwiftUI initialisers and modifiers whose first (or labelled) string parameter is a LocalizedStringKey:
// a literal there is already a key, so it is left alone and picked up by the compiler instead.
const KEY_CALLEES = new Set(["Text", "Label", "Button", "Toggle", "Section", "Picker", "NavigationLink", "Link", "TextField", "SecureField", "TextEditor",
  "Menu", "LabeledContent", "DisclosureGroup", "GroupBox", "ProgressView", "Stepper", "Gauge", "ShareLink", "Tab", "TabItem", "ContentUnavailableView",
  "navigationTitle", "navigationBarTitle", "alert", "confirmationDialog", "accessibilityLabel", "accessibilityHint", "accessibilityValue", "help", "badge", "searchable",
  "navigationSubtitle", "sheet", "headerProminence", "tabItem", "contextMenu", "swipeActions", "toolbar", "ToolbarItem", "Form", "List", "LocalizedStringKey",
  "LocalizedStringResource", "NSLocalizedString", "String", "AttributedString", "Markdown", "StaticString", "Logger", "OSLog", "print", "debugPrint", "fatalError", "assert",
  "assertionFailure", "precondition", "preconditionFailure", "NSError", "URL", "URLComponents", "Notification", "Name", "UserDefaults", "Bundle", "Locale", "Image",
  "UIImage", "Color", "UIColor", "Font", "Data", "Regex", "NSPredicate", "DateFormatter", "Calendar", "Decimal", "UUID", "Set", "Array", "Dictionary"]);
const NAMED = new Set(["title", "message", "label", "subtitle", "description", "placeholder", "text", "header", "footer", "caption", "hint", "detail", "body",
  "summary", "prompt", "actionLabel", "confirmLabel", "cancelLabel", "buttonTitle", "emptyMessage", "errorMessage", "helper", "reason", "fallback", "name",
  "heading", "tooltip", "accessibilityLabel", "accessibilityHint", "displayName", "contentDescription", "subhead", "eyebrow", "cta", "primary", "secondary"]);
const HARD_NEVER = /(?:^|[^\w.])(print|debugPrint|NSLog|os_log|logger\.\w+|Logger|fatalError|assert|assertionFailure|precondition|preconditionFailure|URL|URLComponents|URLRequest|Notification\.Name|NSNotification\.Name|setValue|value|forKey|object|string|integer|bool|data|removeObject|register|hasPrefix|hasSuffix|contains|firstIndex|range|replacingOccurrences|components|split|trimmingCharacters|appending|appendingPathComponent|pathExtension|lastPathComponent|NSPredicate|Regex|NSRegularExpression|Locale|TimeZone|DateFormatter|dateFormat|Image|systemName|UIImage|named|Color|UIColor|Font|custom|JSONSerialization|CodingKey|accessibilityIdentifier|identifier|id|tag|testTag|restorationIdentifier|userInfo|ProcessInfo|environment|CFBundle\w*|Bundle|infoDictionary|UserDefaults|Keychain|SecItem|kSec\w+|Set|Data|Decimal|UUID|NSError|domain|AppStorage|SceneStorage|Entry|deepLink|scheme|host|path|query)\s*\(?\s*(\w+:\s*)?$/;
const SOFT_THROWS = /(?:^|[^\w.])(throw\s+\w+\.?\w*|\w*Error|\w*Exception|preconditionFailure|fatalError)\s*\(\s*(\w+:\s*)?$/;

const looksLikeCode = (t) =>
  /\\[bdwsBDWS.()\[\]|^$]|\(\?[:=!<]|\[\^?[a-z\\]|\\\\/.test(t) // a regular expression
  || !/[A-Za-zÀ-ɏ぀-ヿ一-鿿]{2}/.test(t)
  || /^[a-z0-9_.\-/:+@#%&=?]+$/.test(t)
  || /^[a-z]+([A-Z][a-z0-9]+)+$/.test(t)
  || /^[A-Z0-9_]+$/.test(t)
  || /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]*$/.test(t)
  || /^https?:|^\//.test(t)
  || /^(GET|POST|PUT|PATCH|DELETE|HEAD|Bearer|Basic|Authorization|Content-Type|Accept|User-Agent|Cache-Control|Host)\b/.test(t)
  || /^[A-Z][a-z]+(-[A-Z][a-z]+)+$/.test(t)
  || /^%[@sdfl@0-9.$]+$/.test(t) || /^\u0001+$/.test(t);
const looksProse = (t) => /^[A-ZÀ-Þ“‘("\u0001]/.test(t) && (/\s/.test(t) || /[.!?…:]$/.test(t));
const BRANDS = /^(OpenAI|Groq|Anthropic|Google|OpenRouter|Ollama|Mistral|Debian|Ubuntu|Fedora|Postgres|PostgreSQL|Docker|GitHub|GitLab|Forgejo|Chromium|Cloudflare|Fly|Hetzner|UpCloud|Apple|iCloud|Flagship|Android|iOS|macOS|Windows|Linux|WebAuthn|Face ID|Touch ID|Gemini|Claude|ChatGPT|Pro|OK)$/;

function contextBefore(src, pos) {
  let i = pos - 1;
  while (i >= 0 && /[ \t\n]/.test(src[i])) i--;
  const c = src[i];
  const near = src.slice(Math.max(0, i - 120), i + 1);
  let kind = "other", label = null, callee = null;
  if (c === ":") {
    label = /([A-Za-z_]\w*)\s*:$/.exec(near)?.[1] ?? null;
    kind = "label";
    const open = enclosingOpen(src, pos);
    if (open >= 0) callee = /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(Math.max(0, open - 80), open))?.[1]?.split(".").pop() ?? null;
  } else if (c === "(") {
    kind = "first";
    callee = /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(Math.max(0, i - 80), i))?.[1]?.split(".").pop() ?? null;
  } else if (c === ",") {
    kind = "later";
    const open = enclosingOpen(src, pos);
    if (open >= 0) callee = /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(Math.max(0, open - 80), open))?.[1]?.split(".").pop() ?? null;
  } else if (c === "=" && src[i - 1] !== "=" && !"!<>".includes(src[i - 1])) kind = "assign";
  else if (c === ">" && src[i - 1] === "-") kind = "arrow";
  else if (c === "?" || c === ":") kind = "ternary";
  else if (/return$/.test(src.slice(Math.max(0, i - 6), i + 1))) kind = "return";
  else if (c === "[") kind = "subscript";
  return { kind, label, callee, near };
}

function enclosingOpen(src, pos) {
  let depth = 0;
  for (let i = pos - 1, n = 0; i >= 0 && n < 4000; i--, n++) {
    const c = src[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") { if (depth === 0) return c === "(" ? i : -1; depth--; }
  }
  return -1;
}

function classify(src, lit, rel, regions) {
  const text = textOf(lit);
  if (lit.multi) return { yes: false, why: "multi-line" };
  if (looksLikeCode(text)) return { yes: false, why: "code-like" };
  if (/^[yMdEhHmsaZzGQw'\u0001 ,:/.\-]+$/.test(text) && /[yMdEHhma]{2,}/.test(text)) return { yes: false, why: "date pattern" };
  if (BRANDS.test(text)) return { yes: false, why: "brand" };
  const lineStart = src.lastIndexOf("\n", lit.start) + 1;
  const line = src.slice(lineStart, lit.start);
  const after = src.slice(lit.end, lit.end + 14);
  if (/\bcase\b[^:\n]*$/.test(line) || /^\s*(,|:)\s*$/.test(after.split("\n")[0].slice(0, 2)) && /\bcase\b/.test(line)) return { yes: false, why: "case pattern" };
  if (/(==|!=|~=)\s*$/.test(line) || /^\s*(==|!=)/.test(after)) return { yes: false, why: "comparison" };
  if (/^\s*:/.test(after) && /\[\s*$/.test(line + "")) return { yes: false, why: "dictionary key" };
  if (/#(Preview|available|if|selector|keyPath)|@\w+\(\s*$/.test(line)) return { yes: false, why: "attribute" };
  const ctx = contextBefore(src, lit.start);
  const head = src.slice(Math.max(0, lit.start - 100), lit.start).replace(/\s+$/, "");
  if (HARD_NEVER.test(head) || (ctx.callee && /^(print|debugPrint|NSLog|fatalError|URL|URLComponents|Image|UIImage|Color|UIColor|Notification|UserDefaults|Bundle|Locale|Regex|Data|NSPredicate|DateFormatter)$/.test(ctx.callee))) return { yes: false, why: "non-ui call" };
  if (ctx.kind === "label" && ctx.label && /^(systemName|named|identifier|id|key|forKey|domain|scheme|host|path|tag|testTag|rawValue|label_|accessibilityIdentifier|name_|code|kind|type|action|event|topic|category|channel|reuseIdentifier|bundleIdentifier|suiteName)$/.test(ctx.label)) return { yes: false, why: "identifier label" };
  const inRegion = (regions ?? []).some(([a, b]) => lit.start > a && lit.start < b);
  if (!inRegion && /^\s*(?:(?:public|internal|private|fileprivate|open)\s+)?(?:static\s+)?(?:case|enum)\b/.test(src.slice(lineStart, lineStart + 80))) return { yes: false, why: "enum raw value" };
  if (/\bcase\b[^=\n]*=\s*$/.test(line)) return { yes: false, why: "enum raw value" };
  if (ctx.callee && KEY_CALLEES.has(ctx.callee) && ctx.kind !== "later") return { yes: false, why: `localized-key call ${ctx.callee}` };
  if (ctx.kind === "later" && ctx.callee && KEY_CALLEES.has(ctx.callee)) return { yes: false, why: `localized-key call ${ctx.callee}` };
  if (SOFT_THROWS.test(head) && !/^[A-Z][^]*[.!?]$/.test(text.replace(/\u0001/g, "x"))) return { yes: false, why: "developer error" };
  if (/^[A-Za-z][\w.]*:\s/.test(text) && !/^(Note|Warning|Error|Tip|Step \d|Option|Reason|Result|Status):/i.test(text)) return { yes: false, why: "developer log" };
  if ((ctx.kind === "label" || ctx.kind === "first" || ctx.kind === "later") && ctx.label && NAMED.has(ctx.label) && /[A-Za-z]/.test(text)) return { yes: true, why: `${ctx.label}:` };
  if (looksProse(text)) return { yes: true, why: "prose" };
  if (/^[A-Z]/.test(text) && /^(ui|FlagshipUI)/i.test(rel) === false && /[a-z]/.test(text) && ["return", "arrow", "ternary", "assign", "first", "later", "label"].includes(ctx.kind) && /FlagshipUI|App\//.test(rel)) return { yes: true, why: "ui label" };
  return { yes: false, why: "not user-facing" };
}

/** Function / closure / init bodies, to tell a declaration's initialiser from code. Light brace walk. */
function bodyRegions(src) {
  const masked = maskSwift(src);
  const stack = [], regions = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      const header = masked.slice(Math.max(0, masked.lastIndexOf("\n\n", i)), i);
      const kind = /\b(func|init|deinit|subscript)\b/.test(header.slice(header.lastIndexOf("\n}") + 1)) ? "fun" : "block";
      stack.push({ start: i, kind });
    } else if (ch === "}") { const t = stack.pop(); if (t && t.kind === "fun") regions.push([t.start, i]); }
  }
  return regions;
}

function maskSwift(src) {
  const out = src.split("");
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== "\n") out[i] = " "; };
  for (const lit of scanSwift(src)) blank(lit.start + 1, lit.end - 1);
  // comments
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; blank(i, e); i = e; continue; }
    if (src[i] === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? src.length : j + 2; blank(i, e); i = e; continue; }
    i++;
  }
  return out.join("");
}

// ---- wrap ----------------------------------------------------------------------------------

function listSwift() {
  if (flag("--mac")) return listUnder(["apps/builder-mac/Sources/FlagshipBuilder", "apps/builder-mac/Sources/FlagshipBuilderCore"]);
  const roots = ["apps/mobile/ios/Sources/Flagship", "apps/mobile/ios/Sources/FlagshipUI", "apps/mobile/ios/App/Sources", "apps/mobile/ios/App/Shared", "apps/mobile/ios/App/WidgetExtension",
    "apps/mobile/ios/App/WatchApp", "apps/mobile/ios/App/WatchWidgets", "apps/mobile/shared/Sources"];
  return listUnder(roots);
}
function listUnder(roots) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(\.build|build|Tests|UITests|Vendor|Intents)$/.test(e.name)) walk(p); } // Intents: LocalizedStringResource, the literals are already keys
      else if (p.endsWith(".swift")) out.push(p);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return out;
}

/** "A" + "B" is one sentence for a translator. Single-line, non-raw literals joined by + are folded into one. */
function foldConcats(src, lits) {
  const out = [];
  for (const lit of lits) {
    const prev = out[out.length - 1];
    if (prev && !prev.multi && !lit.multi && !prev.raw && !lit.raw && /^\s*\+\s*$/.test(src.slice(prev.end, lit.start))) {
      out[out.length - 1] = { start: prev.start, end: lit.end, multi: false, raw: false, parts: [...prev.parts, ...lit.parts], folded: [...(prev.folded ?? [prev]), lit] };
    } else out.push(lit);
  }
  return out;
}

function wrap() {
  const report = { wrapped: 0, skipped: [], decl: [] };
  const plans = [];
  for (const file of listSwift()) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, "utf8");
    const regions = bodyRegions(src);
    const inserts = []; // { pos, text }
    const replaces = []; // { start, end, text } for folded literals
    const visit = (lit) => {
      for (const p of lit.parts) for (const n of foldConcats(src, p.nested ?? [])) visit(n);
      const cls = classify(src, lit, rel, regions);
      if (!cls.yes) {
        const t = textOf(lit);
        if (/^[A-Z][^]{2,}/.test(t) && !["code-like", "brand", "date pattern"].includes(cls.why)) report.skipped.push(`${rel}:${lineOf(src, lit.start)} [${cls.why}] ${JSON.stringify(t).slice(0, 90)}`);
        return;
      }
      if (src.slice(Math.max(0, lit.start - 18), lit.start).includes("String(localized:")) return; // already wrapped
      if (lit.folded) {
        // one literal from several: keep each piece's source text (escapes and interpolations intact)
        const inner = lit.folded.map((l) => withInserts(src, inserts, l.start + 1, l.end - 1)).join("");
        replaces.push({ start: lit.start, end: lit.end, text: `String(localized: "${inner}")` });
      } else {
        inserts.push({ pos: lit.start, text: "String(localized: ", order: 1 });
        inserts.push({ pos: lit.end, text: ")", order: 0 });
      }
      report.wrapped++;
    };
    for (const lit of foldConcats(src, scanSwift(src))) visit(lit);
    if (inserts.length || replaces.length) plans.push({ file, src, inserts: inserts.filter((x) => !replaces.some((r) => x.pos >= r.start && x.pos <= r.end)), replaces });
  }
  console.log(`${plans.length} files, ${report.wrapped} literals wrapped`);
  fs.writeFileSync("/tmp/i18n-ios-skipped.txt", report.skipped.join("\n"));
  console.log(`skipped capitalised literals: ${report.skipped.length} (/tmp/i18n-ios-skipped.txt)`);
  if (flag("--dry")) return;
  for (const p of plans) {
    // later positions first so earlier offsets stay valid; at one position the closer goes before the opener
    const edits = [
      ...p.inserts.map((x) => ({ start: x.pos, end: x.pos, text: x.text, order: x.order })),
      ...p.replaces.map((r) => ({ ...r, order: 0 })),
    ].sort((a, b) => b.start - a.start || a.order - b.order);
    let out = p.src;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    fs.writeFileSync(p.file, out);
  }
}

/** src[a,b) with the insertions that fall inside applied (nested literals in an interpolation). */
function withInserts(src, inserts, a, b) {
  const inside = inserts.filter((x) => x.pos >= a && x.pos <= b).sort((x, y) => x.pos - y.pos || y.order - x.order);
  let out = "", i = a;
  for (const x of inside) { out += src.slice(i, x.pos) + x.text; i = x.pos; }
  return out + src.slice(i, b);
}

const lineOf = (src, pos) => src.slice(0, pos).split("\n").length;

// ---- harvest -------------------------------------------------------------------------------

function harvest(dd) {
  const found = { ios: {}, "ios-widgets": {}, watch: {}, "watch-widgets": {}, "studio-mac": {} };
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".stringsdata")) {
        let j;
        try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        const source = j.source ?? "";
        if (!source.startsWith(ROOT) || /\/(Tests|UITests|\.build|Vendor|Gym)\/|Seams|GymLaunch|GymOrder/.test(source)) continue;
        for (const [table, items] of Object.entries(j.tables ?? {})) {
          if (table !== "Localizable") continue;
          for (const it of items) {
            for (const s of surfacesOf(source)) {
              const rel = path.relative(ROOT, source);
              const notText = !/[A-Za-z\u00C0-\u024F\u3040-\u30ff\u4e00-\u9fff]{2}/.test(it.key.replace(/%[@a-z0-9$.]+/gi, "")) || /^[{\[]/.test(it.key);
              (found[s][it.key] ??= { en: it.key, ctx: `${rel}:${it.location?.startingLine ?? ""}`, ...(it.comment ? { comment: it.comment } : {}), ...(notText ? { translatable: false } : {}) });
            }
          }
        }
      }
    }
  };
  walk(dd);
  writeEn("ios-infoplist", { ...INFOPLIST_SEED, ...readEn("ios-infoplist") });
  for (const [surface, keys] of Object.entries(found)) {
    if (Object.keys(keys).length === 0) continue;
    const existing = readEn(surface);
    if (surface === "ios-infoplist") continue;
    // keep a hand-added entry; refresh everything the compiler reported; drop what it no longer reports
    const next = {};
    for (const k of Object.keys(keys)) next[k] = { ...(existing[k] ?? {}), ...keys[k] };
    for (const [k, v] of Object.entries(existing)) if (v.manual) next[k] = v; // hand-kept: text the server sends (scripts/i18n-server.mjs)
    writeEn(surface, next);
    console.log(`${surface}: ${Object.keys(next).length} keys`);
  }
}

// ---- catalog emit --------------------------------------------------------------------------

function emitCatalog(surface, withDrafts) {
  const en = readEn(surface);
  const langs = targets.filter((l) => withDrafts || l.status === "ga");
  const trs = Object.fromEntries(langs.map((l) => [l.code, readTr(surface, l.code)]));
  const strings = {};
  for (const [k, v] of Object.entries(en)) {
    if (v.translatable === false) continue;
    const entry = { extractionState: "manual" };
    if (v.comment) entry.comment = v.comment;
    const localizations = {};
    for (const l of langs) {
      const t = trs[l.code][k];
      if (t == null) continue;
      localizations[l.appleId ?? l.code] = typeof t === "string"
        ? { stringUnit: { state: "translated", value: t } }
        : { variations: { plural: Object.fromEntries(Object.entries(t).map(([f, val]) => [f, { stringUnit: { state: "translated", value: val } }])) } };
    }
    if (Object.keys(localizations).length) entry.localizations = localizations;
    strings[k] = entry;
  }
  return JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2) + "\n";
}

/** Mac Studio: Foundation .strings files, one lproj per language. Key and value are quoted and escaped. */
function emitStrings(surface, withDrafts) {
  const en = readEn(surface);
  const langs = targets.filter((l) => withDrafts || l.status === "ga");
  const q = (t) => '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  const files = {};
  for (const l of langs) {
    const tr = readTr(surface, l.code);
    const lines = Object.keys(en).filter((k) => en[k].translatable !== false && typeof tr[k] === "string").map((k) => `${q(k)} = ${q(tr[k])};`);
    if (lines.length) files[`${l.appleId ?? l.code}.lproj/Localizable.strings`] = `/* GENERATED by scripts/i18n-ios.mjs build from i18n/${surface}. Edit the JSON, not this file. */\n${lines.join("\n")}\n`;
  }
  return files;
}

function buildOne(surface, withDrafts) {
  if (Object.keys(readEn(surface)).length === 0) return;
  if (SURFACES[surface].lproj) {
    const dir = path.resolve(IOS, SURFACES[surface].lproj);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(emitStrings(surface, withDrafts))) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    console.log(`${surface}: wrote ${path.relative(ROOT, dir)}`);
    return;
  }
  const f = path.join(IOS, SURFACES[surface].catalog);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, emitCatalog(surface, withDrafts));
  console.log(`${surface}: wrote ${path.relative(ROOT, f)}`);
}

// ---- dispatch ------------------------------------------------------------------------------

if (cmd === "wrap") wrap();
else if (cmd === "harvest") harvest(args[1]);
else if (cmd === "build") for (const s of Object.keys(SURFACES)) buildOne(s, flag("--drafts"));
else if (cmd === "check") {
  const problems = [];
  for (const s of Object.keys(SURFACES)) {
    problems.push(...lintSurface(s));
    if (SURFACES[s].lproj) continue;
    const f = path.join(IOS, SURFACES[s].catalog);
    if (Object.keys(readEn(s)).length && (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== emitCatalog(s, false))) problems.push(`${path.relative(ROOT, f)} is stale: run node scripts/i18n-ios.mjs build`);
    for (const l of locales.locales.filter((x) => x.status === "ga" && x.code !== locales.source)) {
      const en = readEn(s), tr = readTr(s, l.code);
      const missing = Object.keys(en).filter((k) => en[k].translatable !== false && tr[k] == null);
      if (missing.length) problems.push(`${s}/${l.code} is ga but lacks ${missing.length} strings (first: ${missing[0]})`);
    }
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-ios: ok");
} else if (!runCommon(surfaceArg, args)) {
  console.error("usage: i18n-ios.mjs wrap [--dry] | harvest <DerivedData> | build [--drafts] | check | dump | merge | status | lint   [--surface ios|ios-widgets|watch]");
  process.exit(2);
}
