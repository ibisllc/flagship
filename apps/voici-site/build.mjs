#!/usr/bin/env node
// Builds the voi.ci site (docs/voici-and-messages.md §4.2): no bundler, the ES modules as written. Reproducible: the
// output depends only on the files read here, so CI (and tests/site.test.ts) rebuild and compare byte for byte.
//
//   node apps/voici-site/build.mjs           write the build
//   node apps/voici-site/build.mjs --check   exit 1 when the committed build differs from a fresh one
//
// Output (C: the `.com` Worker has exactly one static-assets directory, apps/web/public, so the build lives there):
//   apps/web/public/_voici/<dir>/...          every file of the site, served immutable at https://voi.ci/-/<dir>/...
//   apps/web/public/_voici/<dir>/MANIFEST.json  {v:1, files:{<path>: <sha256>}}; <build> = SHA-256 of these bytes,
//                                             <dir> = its first 16 hex; the about page shows <build>
//   apps/com/src/voiciSiteBuild.generated.ts  the build id, the file list (the Worker serves only listed paths) and
//                                             the shell HTML (served for every page; every script and stylesheet in
//                                             it carries SRI, and every module is modulepreloaded with its SRI)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFrontDoor } from "./src/front.js";
import { FRANCOPHONE_LANGUAGES, FRANCOPHONE_REGIONS } from "./src/lang.js";
import { LOCALES, STRINGS } from "./src/strings.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..");
export const OUT = join(REPO, "apps", "web", "public", "_voici");
export const WORKER_MODULE = join(REPO, "apps", "com", "src", "voiciSiteBuild.generated.ts");

const SITE_FILES = ["app.js", "call.js", "config.js", "dom.js", "i18n.js", "icons.js", "lang.js", "messages.js", "page.js", "report.js", "sheet.js", "strings.js", "style.css", "sw.js"];
const EXTRA = [
  ["qrEncoder.js", "apps/web/public/qrEncoder.js"],
  ["favicon.svg", "apps/web/public/favicon.svg"],
  ["fonts/Geist-Variable.woff2", "apps/web/public/fonts/Geist-Variable.woff2"],
  ["fonts/GeistMono-Variable.woff2", "apps/web/public/fonts/GeistMono-Variable.woff2"],
];
const FLAGSHIP_WEB = join(REPO, "packages", "flagship-web", "src");
export const SERVICE_WORKER = "sw.js";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sri = (b) => "sha384-" + createHash("sha384").update(b).digest("base64");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** The two store listings, read from apps/web/public/app-stores.js (the one place they live). */
export function storeLinks(source = readFileSync(join(REPO, "apps", "web", "public", "app-stores.js"), "utf8")) {
  const url = (id) => {
    const m = new RegExp(`\\b${id}:\\s*\\{\\s*url:\\s*"(https://[^"]+)"`).exec(source);
    if (!m) throw new Error(`app-stores.js has no ${id} store url`);
    return m[1];
  };
  return { ios: url("ios"), android: url("android") };
}

/** One translator per language, the same lookup as src/i18n.js t(). */
const translator = (code) => (source, ...args) =>
  ((code !== "en" && STRINGS[code]?.[source]) || source).replace(/\{(\d+)\}/g, (m, n) => (args[Number(n)] !== undefined ? String(args[Number(n)]) : m));

/** The whole build in memory: {dir, build, files: Map<relPath, Buffer>, shell, workerModule}. */
export function buildSite() {
  const files = new Map();
  for (const f of SITE_FILES) files.set(f, readFileSync(join(here, "src", f)));
  for (const [to, from] of EXTRA) files.set(to, readFileSync(join(REPO, from)));
  for (const p of walk(FLAGSHIP_WEB)) files.set("flagship-web/" + relative(FLAGSHIP_WEB, p).split("\\").join("/"), readFileSync(p));
  const paths = [...files.keys()].sort();
  const manifest = Buffer.from(JSON.stringify({ v: 1, files: Object.fromEntries(paths.map((p) => [p, sha256(files.get(p))])) }, null, 1) + "\n");
  const build = sha256(manifest);
  const dir = build.slice(0, 16);
  files.set("MANIFEST.json", manifest);
  const base = `/-/${dir}`;
  // sw.js is the reply-alert service worker, a classic script the site registers (served as /-/sw.js), not a module.
  const modules = paths.filter((p) => p.endsWith(".js") && p !== "app.js" && p !== SERVICE_WORKER);
  // `status`: the shell `.com` sends as its 404 or 410 on voi.ci (docs/voici-namespace-spec.md, Resolution), so the
  // page shows the right sentence in the visitor's language; the page shell has none. `noindex`: the page shell of an
  // owner who did not turn on "Show in search engines" (docs/voici-and-messages.md §4.4), and of a page taken down.
  const shellFor = (status, noindex = false) =>
    "<!doctype html>\n" +
    '<html lang="en" data-theme="classic">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<meta name="voici-build" content="${build}">\n` +
    (status ? `<meta name="voici-status" content="${status}">\n` : "") +
    (status || noindex ? '<meta name="robots" content="noindex">\n' : "") +
    "<title>voi.ci</title>\n" +
    `<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">\n` +
    `<link rel="preload" href="${base}/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>\n` +
    `<link rel="stylesheet" href="${base}/style.css" integrity="${sri(files.get("style.css"))}">\n` +
    modules.map((p) => `<link rel="modulepreload" href="${base}/${p}" integrity="${sri(files.get(p))}">\n`).join("") +
    `<script type="module" src="${base}/app.js" integrity="${sri(files.get("app.js"))}"></script>\n` +
    "</head>\n" +
    "<body>\n" +
    '<div id="app"></div>\n' +
    "</body>\n" +
    "</html>\n";
  const shell = shellFor(null);
  // The front door (docs/voici-front-door.md): one static page per shipped language, served by the Worker at `/`.
  const stores = storeLinks();
  const front = Object.fromEntries(
    LOCALES.map((l) => [l.code, renderFrontDoor({ t: translator(l.code), lang: l.code, dir: l.dir, locales: LOCALES, base, styleSri: sri(files.get("style.css")), stores })]),
  );
  const listed = [...files.keys()].sort();
  const workerModule =
    "// GENERATED by `node apps/voici-site/build.mjs` (docs/voici-and-messages.md §4.2). Do not edit.\n" +
    "// The voi.ci site build the Worker serves: its id, the only paths under /-/<dir>/ it answers, and the shell.\n" +
    `export const VOICI_SITE_BUILD = ${JSON.stringify(build)};\n` +
    `export const VOICI_SITE_DIR = ${JSON.stringify(dir)};\n` +
    `export const VOICI_SITE_FILES: ReadonlySet<string> = new Set(${JSON.stringify(listed, null, 2)});\n` +
    `export const VOICI_SITE_SHELL = ${JSON.stringify(shell)};\n` +
    "// The page shell for a page hidden from search engines (the default: its index has no showInSearch 1).\n" +
    `export const VOICI_SITE_SHELL_NOINDEX = ${JSON.stringify(shellFor(null, true))};\n` +
    "// The same shell as voi.ci's 404 (unknown, reserved, unpublished, a held name) and 410 (a removed link or code).\n" +
    `export const VOICI_SITE_SHELL_404 = ${JSON.stringify(shellFor("404"))};\n` +
    `export const VOICI_SITE_SHELL_410 = ${JSON.stringify(shellFor("410"))};\n` +
    "// The front door at voi.ci/ (docs/voici-front-door.md), one page per language; %ORIGIN% and %APEX% are filled per environment.\n" +
    `export const VOICI_FRONT_DOOR: Readonly<Record<string, string>> = ${JSON.stringify(front, null, 1)};\n` +
    "// For the front door's language choice (apps/voici-site/src/lang.js).\n" +
    `export const VOICI_FRANCOPHONE_REGIONS: ReadonlySet<string> = new Set(${JSON.stringify(FRANCOPHONE_REGIONS)});\n` +
    `export const VOICI_FRANCOPHONE_LANGUAGES: ReadonlySet<string> = new Set(${JSON.stringify(FRANCOPHONE_LANGUAGES)});\n`;
  return { dir, build, files, shell, front, workerModule };
}

/** Differences between a fresh build and what is on disk (empty when they match). */
export function buildDrift(b = buildSite()) {
  const out = [];
  const want = new Map([...b.files].map(([p, v]) => [`${b.dir}/${p}`, v]));
  const have = existsSync(OUT) ? walk(OUT).map((p) => relative(OUT, p).split("\\").join("/")) : [];
  for (const p of have) if (!want.has(p)) out.push(`extra: _voici/${p}`);
  for (const [p, v] of want) {
    const f = join(OUT, p);
    if (!existsSync(f)) out.push(`missing: _voici/${p}`);
    else if (!readFileSync(f).equals(v)) out.push(`differs: _voici/${p}`);
  }
  if (!existsSync(WORKER_MODULE) || readFileSync(WORKER_MODULE, "utf8") !== b.workerModule) out.push("differs: apps/com/src/voiciSiteBuild.generated.ts");
  return out;
}

export function writeSite(b = buildSite()) {
  rmSync(OUT, { recursive: true, force: true });
  for (const [p, v] of b.files) {
    const f = join(OUT, b.dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, v);
  }
  writeFileSync(WORKER_MODULE, b.workerModule);
  return b;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const d = buildDrift();
    if (d.length) {
      console.error(`voi.ci build is stale (run node apps/voici-site/build.mjs):\n  ${d.join("\n  ")}`);
      process.exit(1);
    }
    console.log("voi.ci build matches its sources");
  } else {
    const b = writeSite();
    console.log(`voi.ci build ${b.build}\n  ${b.files.size} files in apps/web/public/_voici/${b.dir}/`);
  }
}
