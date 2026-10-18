#!/usr/bin/env node
// The iOS apps ship no mock clients, fixtures, gym seams or developer mode in
// Release builds (owner, 2026-10-16): all of it lives behind `#if DEBUG`, so
// the mock gym (UITests on Debug builds) and the unit tests keep it.
//
//   node scripts/ios-release-clean.mjs                 source check (CI: scripts/ios-release-clean.test.ts)
//   node scripts/ios-release-clean.mjs --app <X.app>   scan a built Release app's binaries
//   node scripts/ios-release-clean.mjs --build         build Release for a generic iOS device, then scan it
//                                     [--derived-data <dir>] [--keep]   (hold the shared native-build lock around it)
//
// The source check reads every Swift file the app, watch app and widgets
// compile and fails on any gym or mock symbol a Release build would compile.
// The binary check runs `strings` over every Mach-O in the bundle (app,
// extensions, watch app) and fails on the same names, so a symbol that slips
// past the source check (a new mock, a macro) is still caught.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = join(ROOT, "apps/mobile");

/** Swift sources compiled into the shipped app, its extensions and the watch app. */
export const RELEASE_SOURCE_DIRS = [
  "shared/Sources",
  "ios/Sources",
  "ios/App/Sources",
  "ios/App/Shared",
  "ios/App/WatchApp",
  "ios/App/WatchWidgets",
  "ios/App/WidgetExtension",
];

/** Names that only the gym, the unit tests or developer mode may use. */
export const FORBIDDEN = [
  { id: "mock type", re: /\b\w*Mock[A-Z]\w*/ },
  { id: "gym fixtures", re: /\b(DemoFixtures|ServiceAccessFixture|samplePods\w*|ServerShareDemo\.(ownerRows|activity|link|sessions|entries|invitation|startup|secretHex|memberPub))\b/ },
  { id: "gym seam", re: /\b(GymSeams|GymLaunch|GymSweepSeams|GymOrderCanonical|GymMocks|GymProbe\w*|SecurityNoticeGym|gymIRK|gymAdminRoot|gymForce\w*)\b/ },
  { id: "developer mode", re: /\b(DeveloperSettings|DeveloperScreen|useLiveClient|mockLatency\w*)\b|Developer menu|flagship\.dev\./ },
  { id: "smoke launch argument", re: /"-smoke-|"-apex-host"|"-gym-notice/ },
];

/** Strings a Release binary must not contain (checked with `strings`). */
export const FORBIDDEN_IN_BINARY = [
  /Mock(Screens|FlagshipServer|QrRelay|PairingRelay|SecretMailbox|LockPower|FrontPage|Leads|ServiceAccess|ServiceUninstall|ServerTransfer|ServerMigration|BuilderPair|DemoConnect|Browser|WebAuthn|OrderSigners|SuggestWords|DbTable|Box)/,
  /DemoFixtures|ServiceAccessFixture|samplePods/,
  /GymSeams|GymLaunch|GymSweepSeams|GymOrderCanonical|GymMocks|GymProbe|SecurityNoticeGym/,
  /DeveloperSettings|DeveloperScreen|useLiveClient|mockLatency|Developer menu|flagship\.dev\./,
  /-smoke-mode|-smoke-onboarding|-apex-host|-gym-notice/,
  /sign in as .demo.|MOCK mode/,
];

function swiftFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...swiftFiles(p));
    else if (name.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** The code of one line with `//` comments and string-free tails removed. */
function codeOf(line, state) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf("*/", i);
      if (end < 0) return out;
      state.block = false;
      i = end + 2;
      continue;
    }
    const c = line[i];
    if (!inString && c === "/" && line[i + 1] === "/") break;
    if (!inString && c === "/" && line[i + 1] === "*") {
      state.block = true;
      i += 2;
      continue;
    }
    if (c === "\\" && inString) {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"') inString = !inString;
    out += c;
    i++;
  }
  return out;
}

/**
 * Lines a Release build compiles that name a forbidden symbol. Tracks
 * `#if DEBUG` / `#if !DEBUG` / `#else` / `#endif` nesting; any other
 * condition is neutral (both branches may be Release code).
 */
export function scanSwift(text, file = "<text>") {
  const findings = [];
  const stack = []; // each: "debug" | "release" | "neutral"
  const state = { block: false };
  const lines = text.split("\n");
  lines.forEach((raw, idx) => {
    const t = raw.trim();
    const dir = /^#(if|elseif|else|endif)\b\s*(.*)$/.exec(t);
    if (dir) {
      const [, kw, cond] = dir;
      const c = cond.replace(/\/\/.*$/, "").trim();
      if (kw === "if") stack.push(c === "DEBUG" ? "debug" : c === "!DEBUG" ? "release" : "neutral");
      else if (kw === "endif") stack.pop();
      else if (kw === "else") {
        const top = stack.pop();
        stack.push(top === "debug" ? "release" : top === "release" ? "debug" : "neutral");
      } else {
        const top = stack.pop();
        stack.push(top === "debug" ? "release" : "neutral");
      }
      return;
    }
    const code = codeOf(raw, state);
    if (stack.includes("debug")) return;
    for (const f of FORBIDDEN) {
      for (const m of code.matchAll(new RegExp(f.re.source, "g"))) {
        findings.push({ file, line: idx + 1, rule: f.id, match: m[0], text: t });
      }
    }
  });
  return findings;
}

export function scanSources(mobileRoot = MOBILE) {
  const findings = [];
  for (const d of RELEASE_SOURCE_DIRS) {
    for (const f of swiftFiles(join(mobileRoot, d))) {
      findings.push(...scanSwift(readFileSync(f, "utf8"), relative(ROOT, f)));
    }
  }
  return findings;
}

function machOFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...machOFiles(p));
      continue;
    }
    if (st.size < 4096) continue;
    const fd = readFileSync(p).subarray(0, 4);
    const magic = fd.readUInt32BE(0);
    if ([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe].includes(magic)) out.push(p);
  }
  return out;
}

export function scanBinaryStrings(text) {
  const hits = new Set();
  for (const line of text.split("\n")) {
    for (const re of FORBIDDEN_IN_BINARY) {
      const m = re.exec(line);
      if (m) hits.add(m[0]);
    }
  }
  return [...hits].sort();
}

export function scanApp(appPath) {
  const files = machOFiles(appPath);
  const results = [];
  for (const f of files) {
    const r = spawnSync("strings", ["-a", f], { encoding: "utf8", maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`strings failed on ${f}: ${r.stderr}`);
    results.push({ file: relative(appPath, f) || ".", hits: scanBinaryStrings(r.stdout) });
  }
  return results;
}

function build(derivedData) {
  const env = { ...process.env };
  if (!env.DEVELOPER_DIR && existsSync("/Applications/Xcode-27.1.0-Release.Candidate.app")) {
    env.DEVELOPER_DIR = "/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer";
  }
  const args = [
    "-project", join(MOBILE, "ios/App/FlagshipApp.xcodeproj"),
    "-scheme", "FlagshipApp",
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-derivedDataPath", derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ];
  console.error(`xcodebuild ${args.join(" ")}`);
  const r = spawnSync("xcodebuild", args, { env, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`xcodebuild failed (exit ${r.status})`);
  return join(derivedData, "Build/Products/Release-iphoneos/FlagshipApp.app");
}

function main() {
  const args = process.argv.slice(2);
  const src = scanSources();
  for (const f of src) console.log(`${f.file}:${f.line}: ${f.rule} (${f.match}): ${f.text}`);
  console.log(`source check: ${src.length ? `${src.length} finding(s)` : "clean"}`);
  let bad = src.length > 0;

  let app = null;
  const i = args.indexOf("--app");
  if (i >= 0) app = resolve(args[i + 1] ?? "");
  let derived = null;
  if (args.includes("--build")) {
    const d = args.indexOf("--derived-data");
    derived = d >= 0 ? resolve(args[d + 1]) : mkdtempSync(join(tmpdir(), "ios-release-clean-"));
    mkdirSync(derived, { recursive: true });
    app = build(derived);
  }
  if (app) {
    if (!existsSync(app)) throw new Error(`no app at ${app}`);
    const res = scanApp(app);
    for (const r of res) {
      console.log(`${r.file}: ${r.hits.length ? `FOUND ${r.hits.join(", ")}` : "clean"}`);
      if (r.hits.length) bad = true;
    }
    console.log(`binary check: ${res.length} Mach-O file(s) in ${relative(ROOT, app) || app}`);
    if (derived && !args.includes("--keep")) rmSync(derived, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
