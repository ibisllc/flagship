#!/usr/bin/env node
// Cross-client parity check. Derived checks read the mirrors straight from
// the sources (link paths, push categories, deep links, signed tags, BFF
// fields, test vectors); parity/features.json pins per-surface feature
// status to source anchors. Plain Node, no dependencies, so it runs on a
// Linux CI runner without the native toolchains.
//
//   node scripts/parity-check.mjs            summary; exit 1 on any red
//   node scripts/parity-check.mjs --report   markdown matrix + findings
//   node scripts/parity-check.mjs --json     machine-readable result
//   node scripts/parity-check.mjs --since <ref>
//                                            commits since <ref> that touched
//                                            exactly one client tree
//   --root <dir>                             check another checkout

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkVersions } from "./check-versions.mjs";

const SKIP_DIRS = new Set([
  "node_modules", "build", ".build", "dist", "DerivedData", ".gradle", "vendor",
  ".git", "bin", "obj", "__pycache__", ".venv", "venv",
]);

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function makeRepo(root) {
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      const abs = join(root, rel);
      cache.set(rel, existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null);
    }
    return cache.get(rel);
  };
  const walk = (rel, exts) => {
    const out = [];
    const start = join(root, rel);
    if (!existsSync(start)) return out;
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
        } else if (!exts || exts.some((x) => e.name.endsWith(x))) {
          out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
        }
      }
    }
    return out.sort();
  };
  return { root, read, walk };
}

const uniq = (xs) => [...new Set(xs)].sort();
const allMatches = (src, re, group = 1) => {
  const out = [];
  if (!src) return out;
  for (const m of src.matchAll(re)) out.push(m[group]);
  return out;
};
const isTestPath = (p) => /(^|\/)(tests?|Tests|__tests__)\//.test(p) || /\.test\.[a-z]+$/.test(p);
/** Drops `//` line comments and block comments so commented-out code and doc
 *  examples don't count as handling something. Strings keep their contents. */
export function stripComments(src) {
  if (!src) return src;
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      // A regex literal like /\/join\/?$/ contains "//" only after a
      // backslash, which never reaches here; a URL inside a string is
      // protected by the quote tracking above.
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const chunk = src.slice(i, end < 0 ? src.length : end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsers (exported for scripts/parity-check.test.ts)
// ---------------------------------------------------------------------------

/** `APP_LINK_PATHS = new Set([ "/join", ... ])` in apps/com/src/route.ts. */
export function parseAppLinkPaths(routeTs) {
  const m = /APP_LINK_PATHS[^=]*=\s*new Set\(\s*\[([^\]]*)\]/.exec(routeTs ?? "");
  if (!m) return [];
  return uniq(allMatches(m[1], /"(\/[^"]*)"/g));
}

/** Universal-link paths an apple-app-site-association file claims. */
export function parseAasaPaths(json) {
  const doc = JSON.parse(json);
  const out = [];
  for (const d of doc?.applinks?.details ?? []) {
    for (const c of d.components ?? []) if (typeof c["/"] === "string") out.push(c["/"]);
    for (const p of d.paths ?? []) out.push(p);
  }
  return uniq(out);
}

/** https App Link paths an AndroidManifest claims for `host`. */
export function parseManifestAppLinkPaths(xml, host) {
  const out = [];
  for (const m of (xml ?? "").matchAll(/<data\b[^>]*>/g)) {
    const tag = m[0];
    if (!/android:scheme="https"/.test(tag) || !tag.includes(`android:host="${host}"`)) continue;
    const p = /android:path="([^"]+)"/.exec(tag);
    if (p) out.push(p[1]);
  }
  return uniq(out);
}

/** `flagship://<host>` custom-scheme hosts an AndroidManifest claims. */
export function parseManifestSchemeHosts(xml) {
  return uniq(allMatches(xml, /android:scheme="flagship"\s+android:host="([^"]+)"/g));
}

/** The open-in-app page's `const LINKS = { "/path": { ..., web: bool } }`. */
export function parseOpenPageLinks(html) {
  const start = (html ?? "").indexOf("const LINKS = {");
  if (start < 0) return {};
  const body = html.slice(start, html.indexOf("\n      };", start));
  const out = {};
  for (const m of body.matchAll(/"(\/[a-z0-9-]+)":\s*\{([\s\S]*?)\n\s*\}/g)) {
    out[m[1]] = /web:\s*true/.test(m[2]);
  }
  return out;
}

/** Hosts in Swift `switch host { case "a", "b": ... }` blocks, plus the https
 *  control-apex paths a Swift parser routes (`case "/x":`, `url.path == "/x"`,
 *  `url.path == Some.constant` resolved through `constants`). */
export function parseSwiftDeepLink(src, constants = {}) {
  const code = stripComments(src ?? "");
  const hosts = [];
  const sw = code.indexOf("switch host {");
  if (sw >= 0) {
    const block = sliceBraces(code, code.indexOf("{", sw));
    for (const m of depthZeroText(block).matchAll(/^\s*case\s+((?:"[^"]+"\s*,?\s*)+):/gm)) {
      hosts.push(...allMatches(m[1], /"([^"]+)"/g));
    }
  }
  const paths = [
    ...allMatches(code, /case\s+"(\/[a-z0-9-]+)"\s*:/g),
    ...allMatches(code, /url\.path\s*==\s*"(\/[a-z0-9-]+)\/?"/g),
  ];
  for (const m of code.matchAll(/url\.path\s*==\s*([A-Za-z_][\w.]*)/g)) {
    const name = m[1].split(".").pop();
    if (constants[name]) paths.push(constants[name]);
  }
  return { hosts: uniq(hosts), paths: uniq(paths.map((p) => p.replace(/\/$/, ""))) };
}

/** Kotlin DeepLink: hosts are `"a", "b" -> ...` arms of `when (host)`; https
 *  paths are `uri.path == "/x"` and the `APP_LINK_PATHS = listOf(...)` twins;
 *  AppLink.kt adds `segments[0] == "x"` single-segment paths. */
export function parseKotlinDeepLink(src, appLinkSrc = "") {
  const code = stripComments(src ?? "");
  const hosts = [];
  const w = code.indexOf("when (host)");
  if (w >= 0) {
    const block = sliceBraces(code, code.indexOf("{", w));
    for (const m of depthZeroText(block).matchAll(/^\s*((?:"[^"]+"\s*,\s*)*"[^"]+")\s*->/gm)) {
      hosts.push(...allMatches(m[1], /"([^"]+)"/g));
    }
  }
  const paths = allMatches(code, /uri\.path\s*==\s*"(\/[a-z0-9-]+)\/?"/g);
  const twins = /APP_LINK_PATHS\s*=\s*listOf\(([^)]*)\)/.exec(code);
  if (twins) paths.push(...allMatches(twins[1], /"([a-z0-9-]+)"/g).map((p) => `/${p}`));
  const al = stripComments(appLinkSrc ?? "");
  for (const m of al.matchAll(/segments\.size\s*==\s*1\s*&&\s*segments\[0\]\s*==\s*"([a-z0-9-]+)"/g)) {
    paths.push(`/${m[1]}`);
  }
  return { hosts: uniq(hosts), paths: uniq(paths) };
}

/** Landing paths the webapp recognises from `location.pathname`: regex
 *  literals like `/\/join\/?$/` or `/^\/share\/?$/`, `=== "/access"`
 *  comparisons and `isAppLink(url, "/remote")` calls. */
export function parseWebappLandingPaths(src) {
  const code = src ?? "";
  return uniq([
    ...allMatches(code, /\/\^?\\\/([a-z0-9-]+)\\\/\?\$\//g).map((p) => `/${p}`),
    ...allMatches(code, /pathname[^\n;]*===\s*"(\/[a-z0-9-]+)"/g),
    ...allMatches(code, /isAppLink\([^,]+,\s*"(\/[a-z0-9-]+)"\)/g),
  ]);
}

/** `block` with everything inside nested braces blanked (newlines kept), so
 *  the arms of a nested switch/when aren't read as top-level routes. */
function depthZeroText(block) {
  let out = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (quote) {
      if (depth === 0) out += c;
      if (c === "\\") {
        if (depth === 0) out += block[i + 1] ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = c;
    if (c === "{") depth++;
    if (depth === 0 || c === "\n") out += c;
    if (c === "}") depth = Math.max(0, depth - 1);
  }
  return out;
}

/** In-app routes the servers link to, as `route[/seg]`: `appRouteLink("route…")`
 *  calls, `https://<host>/app/route` strings and the legacy `flagship://route`. */
export function parseEmittedDeepLinks(src) {
  const code = stripComments(src ?? "");
  const seg = "([a-z0-9-]+(?:\\/[a-z0-9-]+)?)";
  return uniq([
    ...allMatches(code, new RegExp(`["'\`]flagship:\\/\\/${seg}`, "g")),
    ...allMatches(code, new RegExp(`["'\`]https:\\/\\/[^/"'\`]+\\/app\\/${seg}`, "g")),
    ...allMatches(code, new RegExp(`appRouteLink\\(\\s*["'\`]${seg}`, "g")),
  ]);
}

/** Canonical signed-message tags `flagship/<x>/vN`. */
export function parseTags(src) {
  return uniq(allMatches(src ?? "", /flagship\/([a-z0-9][a-z0-9-]*\/v[0-9]+)\b/g).map((t) => `flagship/${t}`));
}

/** `export interface Name [extends A, B] { field?: T; ... }` → { Name: {fields, extends} }. */
export function parseTsInterfaces(src) {
  const code = stripComments(src ?? "");
  const out = {};
  for (const m of code.matchAll(/export\s+interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+([^{]+))?\s*\{/g)) {
    const body = sliceBraces(code, m.index + m[0].length - 1);
    out[m[1]] = {
      fields: topLevelLines(body)
        .map((l) => /^(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\??\s*:/.exec(l)?.[1])
        .filter(Boolean),
      extends: m[2] ? m[2].split(",").map((s) => s.trim().replace(/<.*$/, "")).filter(Boolean) : [],
    };
  }
  for (const m of code.matchAll(/export\s+type\s+(\w+)\s*=\s*\{/g)) {
    const body = sliceBraces(code, m.index + m[0].length - 1);
    out[m[1]] = {
      fields: topLevelLines(body)
        .map((l) => /^(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\??\s*:/.exec(l)?.[1])
        .filter(Boolean),
      extends: [],
    };
  }
  const resolved = {};
  const fieldsOf = (name, seen = new Set()) => {
    if (seen.has(name) || !out[name]) return [];
    seen.add(name);
    return uniq([...out[name].fields, ...out[name].extends.flatMap((e) => fieldsOf(e, seen))]);
  };
  for (const name of Object.keys(out)) resolved[name] = fieldsOf(name);
  return resolved;
}

/** Swift `struct Name ... {` stored properties (`let`/`var` without a body),
 *  renamed through `CodingKeys` raw values. Nested structs are separate. */
export function parseSwiftStructs(src) {
  const code = stripComments(src ?? "");
  const out = {};
  for (const m of code.matchAll(/\bstruct\s+(\w+)[^{\n]*\{/g)) {
    const body = sliceBraces(code, m.index + m[0].length - 1);
    const lines = topLevelLines(body);
    const fields = [];
    for (const l of lines) {
      if (/\bstatic\b/.test(l)) continue;
      const f = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate)(?:\(set\))?\s+)*(?:let|var)\s+(\w+)\s*:\s*([^={]+?)\s*(=|\{|$)/.exec(l);
      if (!f) continue;
      if (f[3] === "{") continue;
      fields.push(f[1]);
    }
    const keys = /enum\s+CodingKeys[^{]*\{([^}]*)\}/.exec(body);
    const rename = {};
    if (keys) {
      for (const c of keys[1].matchAll(/case\s+([^\n;]+)/g)) {
        for (const part of c[1].split(",")) {
          const kv = /^\s*(\w+)\s*(?:=\s*"([^"]+)")?/.exec(part);
          if (kv) rename[kv[1]] = kv[2] ?? kv[1];
        }
      }
    }
    const named = keys ? fields.filter((f) => f in rename).map((f) => rename[f]) : fields;
    out[m[1]] = uniq(named);
  }
  return out;
}

/** Kotlin `data class Name(...)` constructor `val`/`var` params, renamed by
 *  `@SerialName("json")`. */
export function parseKotlinDataClasses(src) {
  const code = stripComments(src ?? "");
  const out = {};
  for (const m of code.matchAll(/\bdata\s+class\s+(\w+)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const params = sliceParens(code, open);
    const fields = [];
    for (const p of splitTopLevel(params)) {
      const f = /(?:@SerialName\("([^"]+)"\)\s*)?(?:@\w+(?:\([^)]*\))?\s*)*(?:override\s+)?(?:val|var)\s+(\w+)\s*:/.exec(p.replace(/\s+/g, " "));
      if (f) fields.push(f[1] ?? f[2]);
    }
    out[m[1]] = uniq(fields);
  }
  return out;
}

function sliceBraces(code, openIdx) {
  return sliceBalanced(code, openIdx, "{", "}");
}
function sliceParens(code, openIdx) {
  return sliceBalanced(code, openIdx, "(", ")");
}
function sliceBalanced(code, openIdx, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return code.slice(openIdx + 1, i);
  }
  return code.slice(openIdx + 1);
}
/** Statements at bracket depth 0 of `body`, split on newlines and `;`. A
 *  statement that opens a body keeps its brackets (`var x: T {}`), so a
 *  computed property is recognisable and a nested type's fields are not. */
function topLevelLines(body) {
  const lines = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (depth === 0) cur += c;
      if (c === "\\") {
        if (depth === 0) cur += body[i + 1] ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (depth === 0) cur += c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      if (depth === 0) cur += c;
      depth++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) cur += c;
      continue;
    }
    if (depth > 0) continue;
    if (c === ";" || c === "\n") {
      if (cur.trim()) lines.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
function splitTopLevel(params) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += params[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** `paths:` entries of every `on.<event>` block in a workflow file. */
export function parseWorkflowPaths(yml) {
  const out = [];
  let indent = -1;
  for (const line of (yml ?? "").split("\n")) {
    const key = /^(\s*)paths:\s*$/.exec(line);
    if (key) {
      indent = key[1].length;
      continue;
    }
    if (indent < 0) continue;
    const item = /^(\s*)-\s+["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (item && item[1].length > indent) out.push(item[2]);
    else if (line.trim() && !line.trim().startsWith("#")) indent = -1;
  }
  return uniq(out);
}

// ---------------------------------------------------------------------------
// Derived checks
// ---------------------------------------------------------------------------

const P = {
  route: "apps/com/src/route.ts",
  aasa: "apps/web/public/.well-known/apple-app-site-association",
  manifest: "apps/mobile/android/app/src/main/AndroidManifest.xml",
  openPage: "apps/web/public/open/index.html",
  iosDeepLink: "apps/mobile/shared/Sources/FlagshipCore/DeepLink.swift",
  andDeepLink: "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/DeepLink.kt",
  andAppLink: "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/AppLink.kt",
  webapp: "apps/web/public/webapp",
  sw: "apps/web/public/webapp/service-worker.js",
  pushRelay: "packages/protocol/src/pushRelay.ts",
  pushBridge: "packages/control-plane/src/pushBridge.ts",
  screensTs: "packages/server-daemon/src/screens/types.ts",
  screensSwift: "apps/mobile/shared/Sources/FlagshipAPI/Models/ScreensModels.swift",
  screensSwiftMore: ["apps/mobile/shared/Sources/FlagshipAPI/Models/AppStorageModels.swift"],
  screensKt: "apps/mobile/android/app/src/main/java/com/flagshipserver/app/api/ScreensModels.kt",
  golden: "apps/desktop-shared/golden/vm-core-vectors.json",
};
const CONTROL_HOST = "flagshipserver.com";
const SERVER_SOURCES = ["apps/com/src", "packages/control-plane/src", "packages/server-daemon/src"];
/** Not deep links: the build MCP server's resource URIs share the scheme. */
const NOT_DEEP_LINK_FILES = new Set(["packages/server-daemon/src/buildmodes/mcpServer.ts"]);
const PUSH_HANDLERS = {
  ios: [
    "apps/mobile/shared/Sources/FlagshipCore/PushNotifications.swift",
    "apps/mobile/shared/Sources/FlagshipCore/ProvisionPhaseBridge.swift",
    "apps/mobile/shared/Sources/FlagshipAPI/Models/AppAccessModels.swift",
  ],
  android: "apps/mobile/android/app/src/main/java/com/flagshipserver/app/push",
  web: ["apps/web/public/webapp/service-worker.js"],
};

function serverSourceFiles(repo) {
  return SERVER_SOURCES.flatMap((d) => repo.walk(d, [".ts"])).filter((p) => !isTestPath(p));
}

function checkAppLinks(repo) {
  const findings = [];
  const server = parseAppLinkPaths(repo.read(P.route));
  const base = uniq(server.map((p) => p.replace(/\/$/, "")));
  const aasa = repo.read(P.aasa) ? parseAasaPaths(repo.read(P.aasa)) : [];
  const manifest = repo.read(P.manifest) ?? "";
  const android = parseManifestAppLinkPaths(manifest, CONTROL_HOST);
  const open = parseOpenPageLinks(repo.read(P.openPage));
  const swiftConsts = {};
  for (const f of repo.walk("apps/mobile/shared/Sources", [".swift"])) {
    for (const m of (repo.read(f) ?? "").matchAll(/static let (\w+)\s*=\s*"(\/[a-z0-9-]+)"/g)) swiftConsts[m[1]] = m[2];
  }
  const ios = parseSwiftDeepLink(repo.read(P.iosDeepLink), swiftConsts);
  const and = parseKotlinDeepLink(repo.read(P.andDeepLink), repo.read(P.andAppLink));
  const webFiles = repo.walk(P.webapp, [".js"]).filter((f) => !f.includes("/vendor/"));
  const web = uniq(webFiles.flatMap((f) => parseWebappLandingPaths(repo.read(f))));
  if (base.length === 0) findings.push({ key: "server:unparsed", message: `could not read APP_LINK_PATHS from ${P.route}` });
  for (const p of base) {
    if (!aasa.includes(p)) findings.push({ key: `aasa:${p}`, message: `${P.aasa} does not claim ${p}` });
    if (!aasa.includes(`${p}/`)) findings.push({ key: `aasa:${p}/`, message: `${P.aasa} does not claim the trailing-slash ${p}/` });
    if (!android.includes(p)) findings.push({ key: `android-manifest:${p}`, message: `AndroidManifest.xml has no https App Link for ${p}` });
    if (!android.includes(`${p}/`)) findings.push({ key: `android-manifest:${p}/`, message: `AndroidManifest.xml has no https App Link for the trailing-slash ${p}/` });
    if (!(p in open)) findings.push({ key: `open-page:${p}`, message: `${P.openPage} LINKS has no entry for ${p} (no get-the-app copy)` });
    if (!ios.paths.includes(p)) findings.push({ key: `ios-parser:${p}`, message: `iOS DeepLink.parse does not route https ${p}` });
    if (!and.paths.includes(p)) findings.push({ key: `android-parser:${p}`, message: `Android DeepLink/AppLink does not route https ${p}` });
    if (open[p] === true && !web.includes(p)) findings.push({ key: `webapp:${p}`, message: `the open page offers the webapp for ${p} but no webapp module reads that landing path` });
  }
  for (const [where, list] of [["aasa", aasa], ["android-manifest", android], ["open-page", Object.keys(open)]]) {
    for (const p of list) {
      const b = p.replace(/\/$/, "");
      if (b && !b.startsWith("/app") && !base.includes(b)) findings.push({ key: `extra:${where}:${p}`, message: `${where} claims ${p}, which APP_LINK_PATHS does not serve` });
    }
  }
  return { id: "app-links", title: "App-link paths (route.ts vs AASA, manifest, open page, parsers)", findings, data: { server: base, aasa, android, open, ios: ios.paths, androidParser: and.paths, webapp: web } };
}

function checkPushCategories(repo) {
  const findings = [];
  const emitted = new Map();
  /** Categories whose payload carries an app link: the client routes them by
   *  that link (the deep-links check), so they need no category branch. */
  const linked = new Set();
  const add = (cat, where) => {
    if (!emitted.has(cat)) emitted.set(cat, new Set());
    emitted.get(cat).add(where);
  };
  const relay = /PUSH_RELAY_CATEGORIES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(stripComments(repo.read(P.pushRelay) ?? ""));
  for (const c of allMatches(relay?.[1], /"([a-z-]+)"/g)) add(c, "PUSH_RELAY_CATEGORIES");
  const apns = /APNS_ALERTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(repo.read(P.pushBridge) ?? "");
  for (const c of allMatches(apns?.[1], /^\s*"([a-z-]+)":/gm)) add(c, "APNS_ALERTS");
  for (const f of serverSourceFiles(repo)) {
    const code = stripComments(repo.read(f));
    for (const m of code.matchAll(/\bcategory:\s*"([a-z][a-z0-9-]+)"/g)) {
      add(m[1], f);
      const nearLink = /\bdeepLink:/.test(code.slice(m.index, m.index + 600));
      const alertTable = /^(re-pair|quarantine)-/.test(m[1]) && /\bdeepLink:/.test(code);
      if (nearLink || alertTable) linked.add(m[1]);
    }
    for (const c of allMatches(code, /pushUserDevices\([^,]+,\s*"([a-z][a-z0-9-]+)"/g)) add(c, f);
    for (const c of allMatches(code, /\blabel:\s*"((?:re-pair|quarantine)-[a-z0-9-]+)"/g)) {
      add(c, f);
      if (/\bdeepLink:/.test(code)) linked.add(c);
    }
    for (const c of allMatches(code, /_KIND\s*=\s*"([a-z][a-z0-9-]+)"/g)) add(c, f);
  }
  const handlerFiles = {
    ios: PUSH_HANDLERS.ios,
    android: repo.walk(PUSH_HANDLERS.android, [".kt"]),
    web: PUSH_HANDLERS.web,
  };
  const handled = {};
  for (const [client, files] of Object.entries(handlerFiles)) {
    const src = files.map((f) => stripComments(repo.read(f) ?? "")).join("\n");
    handled[client] = [...emitted.keys()].filter((cat) => src.includes(`"${cat}"`) || src.includes(`'${cat}'`)).sort();
  }
  for (const [cat, wheres] of [...emitted.entries()].sort()) {
    if (linked.has(cat)) continue;
    for (const client of Object.keys(handlerFiles)) {
      if (!handled[client].includes(cat)) {
        findings.push({ key: `${client}:${cat}`, message: `${client} push handlers never name "${cat}" (emitted by ${[...wheres].join(", ")})` });
      }
    }
  }
  return { id: "push-categories", title: "Push categories (emitters vs client handlers)", findings, data: { emitted: Object.fromEntries([...emitted].map(([k, v]) => [k, [...v]])), routedByLink: [...linked].sort(), handled } };
}

function checkDeepLinks(repo) {
  const findings = [];
  const emitted = new Map();
  for (const f of serverSourceFiles(repo)) {
    if (NOT_DEEP_LINK_FILES.has(f)) continue;
    for (const l of parseEmittedDeepLinks(repo.read(f))) {
      if (!emitted.has(l)) emitted.set(l, new Set());
      emitted.get(l).add(f);
    }
  }
  const ios = parseSwiftDeepLink(repo.read(P.iosDeepLink)).hosts;
  const and = parseKotlinDeepLink(repo.read(P.andDeepLink)).hosts;
  const manifestHosts = parseManifestSchemeHosts(repo.read(P.manifest));
  const sw = stripComments(repo.read(P.sw) ?? "");
  const fn = sw.indexOf("function webappDeepLink");
  const webRouter = fn >= 0 ? sliceBraces(sw, sw.indexOf("{", fn)) : "";
  const routeTable = /const WEBAPP_ROUTES\s*=\s*\{([^}]*)\}/.exec(sw)?.[1] ?? "";
  const web = uniq([
    ...allMatches(webRouter, /===\s*"([a-z0-9-]+)(?:\/[a-z0-9-]+)?"/g),
    ...allMatches(routeTable, /^\s*"([a-z0-9-]+)(?:\/[a-z0-9-]+)?"\s*:/gm),
  ]);
  for (const [link, files] of [...emitted.entries()].sort()) {
    const host = link.split("/")[0];
    for (const [client, hosts] of [["ios", ios], ["android", and], ["web", web]]) {
      if (!hosts.includes(host)) {
        findings.push({ key: `${client}:app/${link}`, message: `${client} has no route for app/${link} (emitted by ${[...files].join(", ")})` });
      }
    }
  }
  for (const h of ios) if (!and.includes(h)) findings.push({ key: `android-lacks-host:${h}`, message: `iOS routes app/${h}, Android does not` });
  for (const h of and) if (!ios.includes(h)) findings.push({ key: `ios-lacks-host:${h}`, message: `Android routes app/${h}, iOS does not` });
  return { id: "deep-links", title: "In-app links (server /app/<route> emitters vs client routers)", findings, data: { emitted: Object.fromEntries([...emitted].map(([k, v]) => [k, [...v]])), ios, android: and, androidManifest: manifestHosts, web } };
}

function checkSignedTags(repo) {
  const findings = [];
  const roots = {
    ios: ["apps/mobile/shared/Sources", "apps/mobile/ios/Sources", "apps/mobile/ios/App"],
    android: ["apps/mobile/android/app/src/main", "apps/mobile/android/app/src/debug"],
    web: [P.webapp, "apps/web/public/recovery"],
  };
  const exts = [".swift", ".kt", ".js"];
  const sets = {};
  for (const [client, dirs] of Object.entries(roots)) {
    sets[client] = uniq(dirs.flatMap((d) => repo.walk(d, exts)).flatMap((f) => parseTags(repo.read(f))));
  }
  const all = uniq(Object.values(sets).flat());
  for (const tag of all) {
    const have = Object.keys(sets).filter((c) => sets[c].includes(tag));
    for (const c of Object.keys(sets)) {
      if (!sets[c].includes(tag)) findings.push({ key: `${c}:${tag}`, message: `${tag} is in ${have.join("+")} but not ${c}` });
    }
  }
  return { id: "signed-tags", title: "Canonical signed-message tags across iOS, Android, webapp", findings, data: { counts: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])) } };
}

const SWIFT_NAME_ALIASES = { AppStorage: "AppDiskUsage" };

function checkScreensBff(repo) {
  const findings = [];
  const ts = parseTsInterfaces(repo.read(P.screensTs));
  const sw = parseSwiftStructs(repo.read(P.screensSwift));
  for (const extra of P.screensSwiftMore) Object.assign(sw, parseSwiftStructs(repo.read(extra)));
  // SwiftUI owns the name AppStorage, so iOS calls the TS/Kotlin AppStorage AppDiskUsage.
  for (const [tsName, swName] of Object.entries(SWIFT_NAME_ALIASES)) if (sw[swName] && !sw[tsName]) sw[tsName] = sw[swName];
  const kt = parseKotlinDataClasses(repo.read(P.screensKt));
  let compared = 0;
  for (const [name, fields] of Object.entries(ts).sort()) {
    const s = sw[name];
    const k = kt[name];
    if (!s && !k) continue;
    if (!s) findings.push({ key: `ios-type:${name}`, message: `${name} is mirrored in Kotlin but not Swift` });
    if (!k) findings.push({ key: `android-type:${name}`, message: `${name} is mirrored in Swift but not Kotlin` });
    if (!s || !k) continue;
    compared++;
    for (const f of fields) {
      if (s.includes(f) && !k.includes(f)) findings.push({ key: `android-field:${name}.${f}`, message: `${name}.${f}: Swift decodes it, Kotlin does not` });
      if (k.includes(f) && !s.includes(f)) findings.push({ key: `ios-field:${name}.${f}`, message: `${name}.${f}: Kotlin decodes it, Swift does not` });
    }
    for (const [client, mirror] of [["ios", s], ["android", k]]) {
      for (const f of mirror) {
        if (!fields.includes(f)) findings.push({ key: `${client}-extra:${name}.${f}`, message: `${name}.${f} is in the ${client} mirror but not in types.ts (a stale or misspelt key never decodes)` });
      }
    }
  }
  return { id: "screens-bff", title: "Screens BFF fields (types.ts vs ScreensModels.swift vs ScreensModels.kt)", findings, data: { tsTypes: Object.keys(ts).length, swiftTypes: Object.keys(sw).length, kotlinTypes: Object.keys(kt).length, compared } };
}

/** A test names a vector set as `test-vectors/<name>` or as path segments
 *  (`"test-vectors", "<name>.json"`). */
export function readsVectorSet(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`test-vectors["'\\s,/]+${esc}(?![\\w-])`).test(src ?? "");
}

/** A test under apps/web/tests that loads the served webapp sources. */
export function isWebappTest(src) {
  return /public["'\s,/]+webapp/.test(src ?? "");
}

function checkTestVectors(repo) {
  const findings = [];
  const sets = [];
  const pv = join(repo.root, "packages/protocol/test-vectors");
  if (existsSync(pv)) {
    for (const d of readdirSync(pv, { withFileTypes: true })) if (d.isDirectory()) sets.push({ name: d.name, where: "packages/protocol/test-vectors" });
  }
  const top = join(repo.root, "test-vectors");
  if (existsSync(top)) {
    for (const d of readdirSync(top, { withFileTypes: true })) {
      if (d.isFile() && d.name.endsWith(".json") && d.name !== "example-spec.json") sets.push({ name: d.name.replace(/\.json$/, ""), where: "test-vectors" });
    }
  }
  const webTests = repo.walk("apps/web/tests", [".test.ts"]).filter((f) => isWebappTest(repo.read(f)));
  const tsTests = [
    ...repo.walk("packages", [".test.ts"]),
    ...repo.walk("apps/com/test", [".test.ts"]),
    ...repo.walk("tools", [".test.ts"]),
    ...repo.walk("apps/web/tests", [".test.ts"]).filter((f) => !webTests.includes(f)),
  ];
  const consumers = {
    ts: tsTests,
    swift: [...repo.walk("apps/mobile/shared/Tests", [".swift"]), ...repo.walk("apps/mobile/ios/Tests", [".swift"])],
    // src/testDebug is the debug variant's unit-test source set, run by testDebugUnitTest.
    kotlin: [...repo.walk("apps/mobile/android/app/src/test", [".kt"]), ...repo.walk("apps/mobile/android/app/src/testDebug", [".kt"])],
    web: webTests,
  };
  const matrix = {};
  for (const s of sets) {
    matrix[s.name] = {};
    for (const [port, files] of Object.entries(consumers)) {
      const hit = files.find((f) => readsVectorSet(repo.read(f), s.name));
      matrix[s.name][port] = hit ?? null;
      if (!hit) findings.push({ key: `${port}:${s.name}`, message: `no ${port} test reads ${s.where}/${s.name}` });
    }
  }
  const golden = repo.read(P.golden);
  const desktop = {};
  if (golden) {
    const sections = Object.keys(JSON.parse(golden)).filter((k) => !["version", "notes"].includes(k));
    const ports = {
      mac: repo.walk("apps/builder-mac/Tests", [".swift"]),
      windows: repo.walk("apps/builder-windows/tests", [".cs"]),
      linux: repo.walk("apps/builder-linux/tests", [".py"]),
    };
    for (const [port, files] of Object.entries(ports)) {
      const readers = files.filter((f) => (repo.read(f) ?? "").includes("vm-core-vectors"));
      desktop[port] = {};
      for (const sec of sections) {
        const ok = readers.some((f) => new RegExp(`["'\\[.]${sec}\\b`).test(repo.read(f)));
        desktop[port][sec] = ok;
        if (!ok) findings.push({ key: `${port}:vm-core-vectors.${sec}`, message: `no ${port} test reads the vm-core-vectors "${sec}" section` });
      }
    }
  }
  const wanted = ["apps/desktop-shared/golden/**", "packages/flagship-builder/**"];
  for (const wf of [".github/workflows/builder-linux.yml", ".github/workflows/builder-windows.yml"]) {
    const paths = parseWorkflowPaths(repo.read(wf));
    for (const w of wanted) {
      const prefix = w.replace(/\*\*$/, "");
      if (!paths.some((p) => p === w || prefix.startsWith(p.replace(/\*\*$/, "")) || p.startsWith(prefix))) {
        findings.push({ key: `ci:${wf.split("/").pop()}:${w}`, message: `${wf} path filters miss ${w}, so a change there never runs that job` });
      }
    }
  }
  return { id: "test-vectors", title: "Test-vector consumption (protocol sets, desktop golden, CI filters)", findings, data: { matrix, desktop } };
}

export const CHECKS = [checkAppLinks, checkPushCategories, checkDeepLinks, checkSignedTags, checkScreensBff, checkTestVectors, checkVersions];

// ---------------------------------------------------------------------------
// Feature manifest
// ---------------------------------------------------------------------------

export const SURFACES = ["ios", "android", "web", "mac", "win", "linux", "watch"];
const STATUSES = new Set(["present", "partial", "missing", "na"]);

export function checkFeatures(repo, manifest) {
  const errors = [];
  const warnings = [];
  for (const f of manifest.features ?? []) {
    if (!f.id) errors.push({ key: "feature:?", message: "a feature has no id" });
    for (const [surface, s] of Object.entries(f.surfaces ?? {})) {
      const key = `${f.id}:${surface}`;
      if (!SURFACES.includes(surface)) errors.push({ key, message: `unknown surface "${surface}"` });
      if (!STATUSES.has(s.status)) {
        errors.push({ key, message: `bad status "${s.status}"` });
        continue;
      }
      if (s.status !== "present" && s.status !== "na" && !s.reason) errors.push({ key, message: `${s.status} needs a reason` });
      const anchors = s.anchors ?? [];
      if ((s.status === "present" || s.status === "partial") && anchors.length === 0) {
        errors.push({ key, message: `${s.status} needs at least one anchor` });
      }
      const results = anchors.map(([path, re]) => {
        const src = repo.read(path);
        if (src == null) return { path, re, ok: false, why: "file missing" };
        let rx;
        try {
          rx = new RegExp(re, "m");
        } catch (e) {
          return { path, re, ok: false, why: `bad regex: ${e.message}` };
        }
        return { path, re, ok: rx.test(src), why: "no match" };
      });
      s._anchors = results;
      if (s.status === "present" || s.status === "partial") {
        for (const r of results) if (!r.ok) errors.push({ key, message: `anchor broke (${r.why}): ${r.path} /${r.re}/` });
      } else if (s.status === "missing" && results.length > 0 && results.every((r) => r.ok)) {
        warnings.push({ key, message: `marked missing but every anchor now matches; re-check and update its status` });
      }
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Allowlist, report, CLI
// ---------------------------------------------------------------------------

export function applyAllowlist(results, allowlist) {
  const entries = allowlist.entries ?? [];
  const used = new Set();
  for (const r of results) {
    for (const f of r.findings) {
      const i = entries.findIndex((e) => e.check === r.id && e.key === f.key);
      if (i >= 0) {
        f.allowed = entries[i].reason;
        used.add(i);
      }
    }
    r.red = r.findings.filter((f) => !f.allowed).length;
    r.allowed = r.findings.length - r.red;
  }
  return entries.filter((_, i) => !used.has(i));
}

function sinceReport(root, ref) {
  const trees = [
    ["ios", /^apps\/mobile\/(ios|shared)\//],
    ["android", /^apps\/mobile\/android\//],
    ["web", /^apps\/web\/public\/webapp\//],
    ["mac", /^apps\/builder-mac\//],
    ["win", /^apps\/builder-windows\//],
    ["linux", /^apps\/builder-linux\//],
  ];
  const log = execFileSync("git", ["-C", root, "log", "--no-merges", "--name-only", "--format=@@%h%x09%s", `${ref}..HEAD`], { encoding: "utf8", maxBuffer: 64 << 20 });
  const out = [];
  for (const chunk of log.split("@@").filter(Boolean)) {
    const [head, ...files] = chunk.split("\n").filter(Boolean);
    const [sha, subject] = head.split("\t");
    const touched = uniq(files.flatMap((f) => trees.filter(([, re]) => re.test(f)).map(([n]) => n)));
    if (touched.length === 1) out.push({ sha, subject, tree: touched[0] });
  }
  return out;
}

const STATUS_CELL = { present: "present", partial: "PARTIAL", missing: "MISSING", na: "n/a" };

function markdownReport(results, features, featureCheck, staleAllow) {
  const lines = ["# Parity report", ""];
  lines.push("| Check | Red | Allowlisted |", "|---|---:|---:|");
  for (const r of results) lines.push(`| ${r.title} | ${r.red} | ${r.allowed} |`);
  lines.push(`| Feature anchors (parity/features.json) | ${featureCheck.errors.length} | - |`, "");
  for (const r of results) {
    const red = r.findings.filter((f) => !f.allowed);
    if (!red.length) continue;
    lines.push(`## ${r.title}`, "");
    for (const f of red) lines.push(`- \`${f.key}\`: ${f.message}`);
    lines.push("");
  }
  if (featureCheck.errors.length) {
    lines.push("## Feature anchors that broke", "");
    for (const e of featureCheck.errors) lines.push(`- \`${e.key}\`: ${e.message}`);
    lines.push("");
  }
  if (featureCheck.warnings.length) {
    lines.push("## Feature warnings", "");
    for (const e of featureCheck.warnings) lines.push(`- \`${e.key}\`: ${e.message}`);
    lines.push("");
  }
  const groups = [
    ["Phone apps", ["ios", "android", "web", "watch"]],
    ["Studio", ["mac", "win", "linux"]],
  ];
  for (const [label, cols] of groups) {
    const rows = (features.features ?? []).filter((f) => cols.some((c) => f.surfaces?.[c]));
    if (!rows.length) continue;
    const used = cols.filter((c) => rows.some((f) => f.surfaces?.[c]));
    lines.push(`## Feature matrix: ${label}`, "");
    lines.push(`| Feature | ref | ${used.join(" | ")} |`, `|---|---|${used.map(() => "---").join("|")}|`);
    const notes = [];
    for (const f of rows) {
      const cells = used.map((c) => {
        const s = f.surfaces?.[c];
        if (!s) return "";
        if (s.reason && s.status !== "present") notes.push(`- ${f.title} / ${c}: ${s.reason}`);
        return STATUS_CELL[s.status] ?? s.status;
      });
      lines.push(`| ${f.title} | ${f.ref} | ${cells.join(" | ")} |`);
    }
    lines.push("", ...notes, "");
  }
  if (staleAllow.length) {
    lines.push("## Allowlist entries that no longer match anything (remove them)", "");
    for (const e of staleAllow) lines.push(`- ${e.check} \`${e.key}\``);
    lines.push("");
  }
  return lines.join("\n");
}

export function run({ root, args = [] }) {
  const repo = makeRepo(root);
  const results = CHECKS.map((c) => c(repo));
  const allowPath = join(root, "parity/allowlist.json");
  const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : { entries: [] };
  const staleAllow = applyAllowlist(results, allowlist);
  const featPath = join(root, "parity/features.json");
  const features = existsSync(featPath) ? JSON.parse(readFileSync(featPath, "utf8")) : { features: [] };
  const featureCheck = checkFeatures(repo, features);
  const red = results.reduce((n, r) => n + r.red, 0) + featureCheck.errors.length;
  const statusCounts = {};
  for (const f of features.features ?? []) {
    for (const [surface, s] of Object.entries(f.surfaces ?? {})) {
      statusCounts[surface] ??= { present: 0, partial: 0, missing: 0, na: 0 };
      if (s.status in statusCounts[surface]) statusCounts[surface][s.status]++;
    }
  }
  return { repo, results, staleAllow, features, featureCheck, red, statusCounts };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const since = opt("--since");
  const { results, staleAllow, features, featureCheck, red, statusCounts } = run({ root, args });
  const sinceList = since ? sinceReport(root, since) : null;

  if (args.includes("--json")) {
    const out = {
      generatedAt: new Date().toISOString(),
      red,
      checks: results.map((r) => ({ id: r.id, title: r.title, red: r.red, allowed: r.allowed, findings: r.findings, data: r.data })),
      features: {
        errors: featureCheck.errors,
        warnings: featureCheck.warnings,
        statusCounts,
        matrix: (features.features ?? []).map((f) => ({ id: f.id, title: f.title, ref: f.ref, surfaces: Object.fromEntries(Object.entries(f.surfaces ?? {}).map(([k, s]) => [k, { status: s.status, reason: s.reason, handle: s.handle }])) })),
      },
      staleAllowlist: staleAllow,
      ...(sinceList ? { since: { ref: since, singleTreeCommits: sinceList } } : {}),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (args.includes("--report")) {
    process.stdout.write(`${markdownReport(results, features, featureCheck, staleAllow)}\n`);
  } else {
    for (const r of results) {
      console.log(`${r.red ? "RED  " : "ok   "} ${r.id.padEnd(16)} ${String(r.red).padStart(3)} red, ${r.allowed} allowlisted`);
      for (const f of r.findings.filter((x) => !x.allowed)) console.log(`        ${f.key}: ${f.message}`);
    }
    console.log(`${featureCheck.errors.length ? "RED  " : "ok   "} ${"features".padEnd(16)} ${String(featureCheck.errors.length).padStart(3)} broken anchors, ${featureCheck.warnings.length} warnings`);
    for (const e of [...featureCheck.errors, ...featureCheck.warnings]) console.log(`        ${e.key}: ${e.message}`);
    for (const e of staleAllow) console.log(`warn  stale allowlist entry ${e.check} ${e.key}`);
  }
  if (sinceList && !args.includes("--json")) {
    console.log(`\nCommits since ${since} touching exactly one client tree (does another client need the same change?):`);
    for (const c of sinceList) console.log(`  [${c.tree}] ${c.sha} ${c.subject}`);
  }
  process.exitCode = red > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
