#!/usr/bin/env node
// i18n-windows — .resx localisation for Flagship Studio on Windows (WPF).
//
//   node scripts/i18n-windows.mjs wrap [--dry]    one-time: C# string literals -> Strings.T("key") / Strings.F("key", args),
//                                                  XAML text attributes -> {local:Str key}; writes i18n/studio-windows/en.json
//   node scripts/i18n-windows.mjs build [--drafts] i18n/studio-windows/*.json -> src/Strings.resx and src/Strings.<culture>.resx
//   node scripts/i18n-windows.mjs check | dump | merge | status | lint
//
// .NET picks the satellite assembly from the Windows display language (CurrentUICulture), so there is no
// in-app language setting. Only "ga" languages get a .resx unless --drafts; MSBuild embeds every
// src/Strings*.resx it finds, so an unreviewed translation cannot ship by accident.

import fs from "node:fs";
import path from "node:path";
import { ROOT, locales, targets, readEn, writeEn, readTr, runCommon, lintSurface } from "./lib/i18n-kv.mjs";

const SURFACE = "studio-windows";
const WIN = path.join(ROOT, "apps/builder-windows");
const SRC = path.join(WIN, "src");
const args = process.argv.slice(2);
const cmd = args[0];
const EXCLUDE_FILE = path.join(ROOT, "scripts/i18n-windows.exclude.json");

// ---- C# lexing -----------------------------------------------------------------------------

/** String literals of a C# source: { start, end, kind, parts:[{text}|{expr,start,end,align,format}] } */
function scanCs(src, from = 0, to = src.length) {
  const out = [];
  let i = from;
  while (i < to) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? to : j + 2; continue; }
    if (c === "#" && /^\s*$/.test(src.slice(src.lastIndexOf("\n", i) + 1, i))) { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "'") { i++; if (src[i] === "\\") i += 2; i = src.indexOf("'", i) + 1 || to; continue; }
    const m = /^(\$@|@\$|\$|@)?"/.exec(src.slice(i, i + 3));
    if (m && (c === '"' || c === "$" || c === "@")) {
      const prefix = m[1] ?? "";
      if (src.startsWith('"""', i + prefix.length)) { const j = src.indexOf('"""', i + prefix.length + 3); i = j < 0 ? to : j + 3; continue; } // raw: untouched
      const lit = readCsString(src, i, prefix, to);
      out.push(lit);
      i = lit.end;
      continue;
    }
    i++;
  }
  return out;
}

function readCsString(src, start, prefix, limit) {
  const verbatim = prefix.includes("@"), interp = prefix.includes("$");
  let i = start + prefix.length + 1;
  const parts = [];
  let buf = "";
  const flush = () => { if (buf) { parts.push({ text: buf }); buf = ""; } };
  while (i < limit) {
    const c = src[i];
    if (verbatim) {
      if (c === '"') { if (src[i + 1] === '"') { buf += '"'; i += 2; continue; } flush(); return { start, end: i + 1, kind: prefix, parts }; }
    } else {
      if (c === "\\") {
        const n = src[i + 1];
        if (n === "u") { buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (n === "x") { const m = /^[0-9a-fA-F]{1,4}/.exec(src.slice(i + 2, i + 6)); buf += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
        buf += { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "'": "'", "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" }[n] ?? n;
        i += 2; continue;
      }
      if (c === '"') { flush(); return { start, end: i + 1, kind: prefix, parts }; }
      if (c === "\n") break;
    }
    if (interp && c === "{") {
      if (src[i + 1] === "{") { buf += "{"; i += 2; continue; }
      flush();
      let depth = 1, j = i + 1;
      while (j < limit && depth > 0) {
        const ch = src[j];
        if (ch === '"' || ch === "$" || ch === "@") {
          const mm = /^(\$@|@\$|\$|@)?"/.exec(src.slice(j, j + 3));
          if (mm) { j = readCsString(src, j, mm[1] ?? "", limit).end; continue; }
        }
        if (ch === "'") { j += src[j + 1] === "\\" ? 4 : 3; continue; }
        if (ch === "{" || ch === "(" || ch === "[") depth++; else if (ch === "}" || ch === ")" || ch === "]") depth--;
        j++;
      }
      const hole = src.slice(i + 1, j - 1);
      const { expr, align, format } = splitHole(hole);
      parts.push({ expr, start: i + 1, end: j - 1, align, format });
      i = j; continue;
    }
    if (interp && c === "}" && src[i + 1] === "}") { buf += "}"; i += 2; continue; }
    buf += c; i++;
  }
  flush();
  return { start, end: limit, kind: prefix, parts };
}

/** Split `expr[,align][:format]` at the first top-level , or : (a ternary must be parenthesised in C#). */
function splitHole(hole) {
  let depth = 0, q = false;
  for (let i = 0; i < hole.length; i++) {
    const ch = hole[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--;
    else if (depth === 0 && ch === ":" && hole[i + 1] !== ":" && hole[i - 1] !== ":") return { expr: hole.slice(0, i), align: "", format: hole.slice(i + 1) };
    else if (depth === 0 && ch === "," ) {
      const rest = hole.slice(i + 1);
      const m = /^\s*(-?\d+)\s*(?::(.*))?$/.exec(rest);
      if (m) return { expr: hole.slice(0, i), align: "," + m[1], format: m[2] ?? "" };
    }
  }
  return { expr: hole, align: "", format: "" };
}

/** The .NET composite-format template ({0}, {1:N0}) and the argument expressions. */
function templateOf(lit) {
  let n = 0;
  const exprs = [];
  const t = lit.parts.map((p) => {
    if (p.text !== undefined) return p.text.replace(/\{/g, "{{").replace(/\}/g, "}}");
    exprs.push(p.expr.trim());
    return `{${n++}${p.align}${p.format ? ":" + p.format : ""}}`;
  }).join("");
  return { template: t, exprs };
}
const plainOf = (lit) => lit.parts.map((p) => (p.text !== undefined ? p.text : "\u0001")).join("");

// ---- classification ------------------------------------------------------------------------

const looksLikeCode = (t) =>
  !/[A-Za-zÀ-ɏ]{2}/.test(t)
  || /^[a-z0-9_.\-/:+@#%&=?\\]+$/.test(t)
  || /^[a-z]+([A-Z][a-z0-9]+)+$/.test(t)
  || /^[A-Z0-9_]+$/.test(t)
  || /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]*$/.test(t)
  || /^(https?:|\/|\\|[A-Za-z]:\\)/.test(t)
  || /[\\^$|]|\(\?|\[\^?[a-z\\]/.test(t.replace(/\u0001/g, ""))
  || /^(GET|POST|PUT|PATCH|DELETE|HEAD|Bearer|Basic|Authorization|Content-Type|Accept|User-Agent)\b/.test(t)
  || /^[A-Z][a-z]+(-[A-Z][a-z]+)+$/.test(t);
const looksProse = (t) => /^[A-ZÀ-Þ“‘("\u0001]/.test(t) && (/\s/.test(t) || /[.!?…:]$/.test(t));
const BRANDS = /^(Flagship|Flagship Studio|Windows|Debian|Ubuntu|Linux|OK|QEMU|WHPX|SSH|USB|ISO|Wi-Fi)$/;
const NEVER = /(?:^|[^\w])(Console\.\w+|Debug\.\w+|Trace\.\w+|Path\.\w+|File\.\w+|Directory\.\w+|Environment\.\w+|Registry\w*|Process\.\w+|ProcessStartInfo|Uri|UriBuilder|nameof|typeof|Enum\.\w+|Guid\.\w+|Regex\w*|Encoding\.\w+|Type\.GetType|Activator\.\w+|StartsWith|EndsWith|Contains|Equals|IndexOf|Replace|Split|Join|Trim\w*|TryGetValue|ContainsKey|GetProperty|GetEnvironmentVariable|SetEnvironmentVariable|DllImport|Mutex|EventLog|Add|Remove|AddRange|Append\w*Path|Combine|CompareTo|Compare\w*|ToString|Parse|TryParse|Format\w*|WriteLine|Write|Log\w*|ArgumentException|ArgumentNullException|ArgumentOutOfRangeException|InvalidOperationException|NotSupportedException|NotImplementedException|InvalidDataException|IOException|UnauthorizedAccessException|FileNotFoundException|Exception|ProcessStartInfo|Arguments|FileName|WorkingDirectory|KeyValuePair|Assert\w*)\s*\(\s*(\w+:\s*)?$/;
const FRIENDLY_THROW = /(?:^|[^\w])(\w*Exception)\s*\(\s*$/;

// An exception message that reads as a sentence for a person (it ends up on screen), not a developer note.
const friendly = (t) => {
  const plain = t.replace(/\u0001/g, "x").trim();
  return /^[A-Z][\s\S]*[.!?…)]$/.test(plain) && plain.split(/\s+/).length >= 4 && !/[a-z][A-Z]/.test(plain.replace(/\b(Wi-Fi|iPhone|WiFi)\b/g, "")) && !/[_=<>{}]|\w\.\w+\(|0x/.test(plain);
};

function classify(src, lit, rel, exclude) {
  const text = plainOf(lit);
  if (exclude.has(`${rel}:${lineOf(src, lit.start)}`)) return { yes: false, why: "excluded by hand" };
  if (looksLikeCode(text)) return { yes: false, why: "code-like" };
  if (BRANDS.test(text)) return { yes: false, why: "brand" };
  const lineStart = src.lastIndexOf("\n", lit.start) + 1;
  const line = src.slice(lineStart, lit.start);
  const after = src.slice(lit.end, lit.end + 16);
  const head = src.slice(Math.max(0, lit.start - 120), lit.start).replace(/\s+$/, "");
  if (/\[\s*\w+\s*\(\s*$|^\s*\[/.test(line)) return { yes: false, why: "attribute" };
  if (/\bconst\b/.test(src.slice(Math.max(lineStart - 160, src.lastIndexOf(";", lit.start) + 1), lit.start)) && !constDecl(src, lit)) return { yes: false, why: "constant" };
  if (/\bcase\s*$|\bcase\b[^:\n]*$/.test(line)) return { yes: false, why: "case label" };
  if (/(==|!=|\bis\b|\bis not\b|\bor\b|\band\b)\s*$/.test(head) || /^\s*(==|!=|=>\s*)/.test(after) && /^\s*==|^\s*!=/.test(after)) return { yes: false, why: "comparison" };
  if (/^\s*=>/.test(after) && !/\bnew\b|\breturn\b/.test(line) && /\bswitch\b|\bcase\b/.test(src.slice(Math.max(0, lit.start - 400), lit.start))) return { yes: false, why: "switch arm" };
  if (/\[\s*$/.test(head) || /^\s*\]/.test(after) && /\[$/.test(head)) return { yes: false, why: "indexer" };
  if (/\([^()]*\b\w+\s*=\s*$/.test(head) && /\)\s*$|,\s*$|^\s*[,)]/.test(after) && /(\bstring|\bobject|\bint)\s+\w+\s*=\s*$/.test(head)) return { yes: false, why: "default parameter" };
  if (/\w\s+\w+\s*=\s*$/.test(head) && /^\s*[,)]/.test(after) && /\)\s*\{?\s*$|\{|=>/.test(src.slice(lit.end, lit.end + 60).split("\n")[0] + "{") && /\b(string|bool|int|double|object)\??\s+\w+\s*=\s*$/.test(head)) return { yes: false, why: "default parameter" };
  if (NEVER.test(head)) return { yes: false, why: "non-ui call" };
  if (FRIENDLY_THROW.test(head) && !friendly(text)) return { yes: false, why: "developer exception" };
  if (/^[A-Za-z][\w.]*:\s/.test(text) && !/^(Note|Warning|Error|Tip|Step \d|Option|Reason|Result|Status):/i.test(text)) return { yes: false, why: "developer log" };
  if (looksProse(text)) return { yes: true, why: "prose" };
  if (/^[A-Z][a-z]{2,14}$/.test(text) && /\b(Text|Content|Header|ToolTip|Title|Label|Caption|Status|Message)\s*=\s*$|\bnew\s+\w*(Item|Entry|Option)\s*\(\s*$/.test(head)) return { yes: true, why: "label" };
  return { yes: false, why: "not user-facing" };
}

/** `[mods] const string Name =` directly before the literal (possibly on the previous line): becomes a getter. */
function constDecl(src, lit) {
  const before = src.slice(Math.max(0, lit.start - 200), lit.start);
  const m = /((?:public|internal|private|protected)\s+)?const\s+string\s+(\w+)\s*=\s*$/.exec(before);
  if (!m) return null;
  // the literal must be the whole initialiser: `;` follows
  return /^\s*;/.test(src.slice(lit.end, lit.end + 8)) ? { start: lit.start - m[0].length, mods: m[1] ?? "", name: m[2] } : null;
}

const lineOf = (src, pos) => src.slice(0, pos).split("\n").length;

// ---- keys ----------------------------------------------------------------------------------

const RESERVED = new Set(["abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while"]);
function slugOf(text) {
  const w = text.replace(/\{\d+[^}]*\}/g, " ").replace(/['’]/g, "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  let s = w.map((x, i) => (i === 0 ? x.toLowerCase() : x[0].toUpperCase() + x.slice(1).toLowerCase())).join("");
  if (!s) s = "text";
  if (/^[0-9]/.test(s)) s = "n" + s;
  if (RESERVED.has(s)) s += "Text";
  return s.slice(0, 48);
}

// ---- wrap ----------------------------------------------------------------------------------

function csFiles() {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".cs") && !/Strings\.cs$|StrExtension\.cs$/.test(p)) out.push(p); } })(SRC);
  return out;
}

function wrap() {
  const exclude = new Set(fs.existsSync(EXCLUDE_FILE) ? JSON.parse(fs.readFileSync(EXCLUDE_FILE, "utf8")) : []);
  const entries = { ...readEn(SURFACE) };
  const byText = new Map(Object.entries(entries).map(([k, v]) => [v.en, k]));
  const report = { wrapped: 0, skipped: [] };
  const key = (template, ctx) => {
    let k = byText.get(template);
    if (!k) {
      k = slugOf(template);
      let c = k, n = 2;
      while (entries[c] && entries[c].en !== template) c = `${k}${n++}`;
      k = c;
      entries[k] = { en: template, ctx };
      byText.set(template, k);
    }
    return k;
  };
  const plans = [];
  for (const file of csFiles()) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    const src = fs.readFileSync(file, "utf8");
    const edits = [];
    const visit = (lit) => {
      for (const p of lit.parts) if (p.expr !== undefined) for (const n of scanCs(src, p.start, p.end)) visit(n);
      const cls = classify(src, lit, rel, exclude);
      if (!cls.yes) {
        const t = plainOf(lit);
        if (/^[A-Z][\s\S]{2,}/.test(t) && !["code-like", "brand"].includes(cls.why)) report.skipped.push(`${rel}:${lineOf(src, lit.start)} [${cls.why}] ${JSON.stringify(t).slice(0, 90)}`);
        return;
      }
      const { template, exprs } = templateOf(lit);
      const k = key(template, `${rel}:${lineOf(src, lit.start)} (${cls.why})`);
      // expressions may contain nested wrapped literals: take their (already edited) text
      const inner = exprs.length ? lit.parts.filter((p) => p.expr !== undefined).map((p) => applyInside(src, edits, p.start, p.end, p)).join(", ") : "";
      const cd = constDecl(src, lit);
      if (cd && !exprs.length) {
        // a member constant becomes a getter; a constant local to a method (no access modifier, indented) a plain local
        const local = !cd.mods && /^[ \t]{8,}/.test(src.slice(src.lastIndexOf("\n", cd.start) + 1));
        edits.push({ start: cd.start, end: lit.end, text: local ? `string ${cd.name} = Strings.T("${k}")` : `${cd.mods}static string ${cd.name} => Strings.T("${k}")` });
      }
      else edits.push({ start: lit.start, end: lit.end, text: exprs.length ? `Strings.F("${k}", ${inner})` : `Strings.T("${k}")` });
      report.wrapped++;
    };
    for (const lit of scanCs(src)) visit(lit);
    if (edits.length) plans.push({ file, rel, src, edits });
  }
  console.log(`${plans.length} files, ${report.wrapped} literals -> ${Object.keys(entries).length} resources`);
  fs.writeFileSync("/tmp/i18n-windows-skipped.txt", report.skipped.join("\n"));
  console.log(`skipped capitalised literals: ${report.skipped.length} (/tmp/i18n-windows-skipped.txt)`);
  if (args.includes("--dry")) return;
  for (const p of plans) {
    const outer = [];
    for (const e of [...p.edits].sort((a, b) => a.start - b.start || b.end - a.end)) if (!outer.some((o) => e.start >= o.start && e.end <= o.end)) outer.push(e);
    let out = "", i = 0;
    for (const e of outer) { out += p.src.slice(i, e.start) + e.text; i = e.end; }
    fs.writeFileSync(p.file, out + p.src.slice(i));
  }
  writeEn(SURFACE, entries);
  wrapXaml(entries, byText, key);
  writeEn(SURFACE, entries);
  buildAll(false);
}

function applyInside(src, edits, a, b, part) {
  const expr = src.slice(a, b);
  const { expr: e } = splitHole(expr);
  const inside = edits.filter((x) => x.start >= a && x.end <= a + e.length).sort((x, y) => x.start - y.start);
  let out = "", i = a;
  for (const x of inside) { out += src.slice(i, x.start) + x.text; i = x.end; }
  return (out + src.slice(i, a + e.length)).trim();
}

// ---- XAML ----------------------------------------------------------------------------------

const XAML_ATTRS = ["Text", "Content", "Header", "ToolTip", "Title", "Label", "PlaceholderText", "AutomationProperties.Name", "AutomationProperties.HelpText"];
const decodeXml = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function wrapXaml(entries, byText, key) {
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".xaml"))) {
    const p = path.join(SRC, f);
    let s = fs.readFileSync(p, "utf8");
    let n = 0;
    for (const a of XAML_ATTRS) {
      const re = new RegExp(`(\\s${a.replace(".", "\\.")}=)"([^"{][^"]*)"`, "g");
      s = s.replace(re, (m, pre, val) => {
        const text = decodeXml(val);
        if (!/[A-Za-z]{2}/.test(text) || looksLikeCode(text) || BRANDS.test(text)) return m;
        const k = key(text, `${f} ${a}`);
        n++;
        return `${pre}"{local:Str ${k}}"`;
      });
    }
    if (n) fs.writeFileSync(p, s);
    console.log(`${f}: ${n} attributes`);
  }
}

// ---- resx ----------------------------------------------------------------------------------

const xmlEsc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function emitResx(lang) {
  const en = readEn(SURFACE);
  const tr = lang ? readTr(SURFACE, lang) : null;
  const rows = [];
  for (const [k, v] of Object.entries(en)) {
    if (v.translatable === false) continue;
    const t = tr ? tr[k] : v.en;
    if (typeof t !== "string") continue;
    rows.push(`  <data name="${k}" xml:space="preserve">\n    <value>${xmlEsc(t)}</value>${v.ctx && !tr ? `\n    <comment>${xmlEsc(v.ctx)}</comment>` : ""}\n  </data>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- GENERATED by scripts/i18n-windows.mjs from i18n/${SURFACE}. Edit the JSON (or the code and re-run wrap), not this file. -->
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
${rows.join("\n")}
</root>
`;
}

function buildAll(drafts) {
  if (!Object.keys(readEn(SURFACE)).length) return;
  for (const f of fs.readdirSync(SRC)) if (/^Strings(\.[A-Za-z-]+)?\.resx$/.test(f)) fs.rmSync(path.join(SRC, f));
  fs.writeFileSync(path.join(SRC, "Strings.resx"), emitResx(null));
  for (const l of targets.filter((x) => drafts || x.status === "ga")) {
    if (!Object.keys(readTr(SURFACE, l.code)).length) continue;
    fs.writeFileSync(path.join(SRC, `Strings.${l.windowsId}.resx`), emitResx(l.code));
  }
  console.log(`${SURFACE}: wrote src/Strings.resx`);
}

// ---- dispatch ------------------------------------------------------------------------------

if (cmd === "wrap") wrap();
else if (cmd === "build") buildAll(args.includes("--drafts"));
else if (cmd === "check") {
  const problems = [...lintSurface(SURFACE)];
  const en = readEn(SURFACE);
  if (Object.keys(en).length) {
    const f = path.join(SRC, "Strings.resx");
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== emitResx(null)) problems.push("apps/builder-windows/src/Strings.resx is stale: run node scripts/i18n-windows.mjs build");
    for (const l of locales.locales.filter((x) => x.status === "ga" && x.code !== locales.source)) {
      const tr = readTr(SURFACE, l.code);
      const missing = Object.keys(en).filter((k) => en[k].translatable !== false && tr[k] == null);
      if (missing.length) problems.push(`${SURFACE}/${l.code} is ga but lacks ${missing.length} strings (first: ${missing[0]})`);
      const g = path.join(SRC, `Strings.${l.windowsId}.resx`);
      if (!fs.existsSync(g) || fs.readFileSync(g, "utf8") !== emitResx(l.code)) problems.push(`${path.relative(ROOT, g)} is stale: run node scripts/i18n-windows.mjs build`);
    }
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-windows: ok");
} else if (!runCommon(SURFACE, args)) {
  console.error("usage: i18n-windows.mjs wrap [--dry] | build [--drafts] | check | dump | merge | status | lint");
  process.exit(2);
}
