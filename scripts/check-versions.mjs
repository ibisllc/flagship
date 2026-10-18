#!/usr/bin/env node
// One product version for every surface (owner decision 2026-10-18).
//
// release/version.json is the single source of truth:
//   product            the user-visible version on every surface ("0.2")
//   label              the maturity word shown beside it ("Beta")
//   iosVersion/iosBuild   the App Store pair (must climb past the approved 1.0 (4))
//   androidVersionCode    the Play code (only ever climbs; wear = this + 1,000,000)
//   studio             the desktop Studios' release version ("0.2.0")
//
// Not covered, on purpose: protocol and wire versions (CLIENT_PROTOCOL_LEVEL,
// envelope tags) and the webapp shell number (SHELL_VERSION); they are separate.
//
//   node scripts/check-versions.mjs           fail (exit 1) if any surface drifts
//   node scripts/check-versions.mjs --write   rewrite the generated surfaces from the file
//   --root <dir>                              check another checkout
//
// `npm run parity` runs the same check (as the "versions" check).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION_FILE = "release/version.json";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseVersion(text) {
  const v = JSON.parse(text);
  const errors = [];
  if (!/^\d+\.\d+$/.test(v.product ?? "")) errors.push(`product must look like "0.2" (got ${JSON.stringify(v.product)})`);
  if (!/^[A-Za-z]+$/.test(v.label ?? "")) errors.push(`label must be one word (got ${JSON.stringify(v.label)})`);
  if (!/^\d+\.\d+$/.test(v.iosVersion ?? "")) errors.push(`iosVersion must look like "1.1" (got ${JSON.stringify(v.iosVersion)})`);
  if (!Number.isInteger(v.iosBuild) || v.iosBuild < 1) errors.push("iosBuild must be a positive integer");
  if (!Number.isInteger(v.androidVersionCode) || v.androidVersionCode < 1) errors.push("androidVersionCode must be a positive integer");
  if (!/^\d+\.\d+\.\d+$/.test(v.studio ?? "")) errors.push(`studio must look like "0.2.0" (got ${JSON.stringify(v.studio)})`);
  else if (v.studio.split(".").slice(0, 2).join(".") !== v.product) errors.push(`studio ${v.studio} must start with the product version ${v.product}`);
  return { v, errors };
}

/** "0.2.0" -> "0.2 Beta" for a release, anything else (a dev build) unchanged. */
export const display = (v) => `${v.product} ${v.label}`;

/**
 * Each surface: where it lives, what the file must say, and how to rewrite it.
 * `pattern` captures the part that comes from the version file; `want` is what
 * it must equal. A generated surface can be fixed by --write; a "pinned" one
 * (no `fix`) only reports.
 */
export function surfaces(v) {
  const s = [];
  const add = (id, path, pattern, want, why, { fix = true, flags = "m" } = {}) => s.push({ id, path, pattern: new RegExp(pattern, flags), want, why, fix });

  add("website:hero", "apps/web/public/index.html", `(<span>v)([^<]*)(</span>\\s*<span class="sep">·</span>\\s*<span>since )`, `${display(v)}`, `homepage hero badge reads "v${display(v)}"`);
  add("webapp:product", "apps/web/public/webapp/lib/buildInfo.js", `(export const PRODUCT_VERSION = ")([^"]*)(")`, v.product, "webapp product version");
  add("webapp:label", "apps/web/public/webapp/lib/buildInfo.js", `(export const PRODUCT_LABEL = ")([^"]*)(")`, v.label, "webapp product label");

  add("ios:project.yml:version", "apps/mobile/ios/App/project.yml", `(MARKETING_VERSION: ")([^"]*)(")`, v.iosVersion, "iOS store version");
  add("ios:project.yml:build", "apps/mobile/ios/App/project.yml", `(CURRENT_PROJECT_VERSION: ")([^"]*)(")`, String(v.iosBuild), "iOS store build");
  add("ios:pbxproj:version", "apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj", `(MARKETING_VERSION = )([^;]*)(;)`, v.iosVersion, "iOS store version (project)", { flags: "gm" });
  add("ios:pbxproj:build", "apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj", `(CURRENT_PROJECT_VERSION = )([^;]*)(;)`, String(v.iosBuild), "iOS store build (project)", { flags: "gm" });
  add("ios:about:product", "apps/mobile/ios/Sources/FlagshipUI/Shell/ProductVersion.swift", `(static let product = ")([^"]*)(")`, v.product, "iOS About product version");
  add("ios:about:label", "apps/mobile/ios/Sources/FlagshipUI/Shell/ProductVersion.swift", `(static let label = ")([^"]*)(")`, v.label, "iOS About label");

  add("mac:plist", "apps/builder-mac/Info.plist", `(<key>CFBundleShortVersionString</key>\\s*<string>)([^<]*)(</string>)`, v.studio, "Mac Studio bundle version");
  add("mac:label", "apps/builder-mac/Sources/FlagshipBuilderCore/StudioVersion.swift", `(static let label = ")([^"]*)(")`, v.label, "Mac Studio About label");
  add("linux:label", "apps/builder-linux/version.py", `(LABEL = ")([^"]*)(")`, v.label, "Linux Studio About label");
  add("windows:label", "apps/builder-windows/src/StudioVersion.cs", `(Label = ")([^"]*)(")`, v.label, "Windows Studio About label");
  return s;
}

/** Surfaces that must read release/version.json themselves instead of holding a copy. */
export const READERS = [
  ["android:app", "apps/mobile/android/app/build.gradle.kts", ["release/version.json", `releaseVersion["androidVersionCode"]`, `releaseVersion["product"]`, `releaseVersion["label"]`]],
  ["android:wear", "apps/mobile/android/wear/build.gradle.kts", ["release/version.json", `1_000_000 + (releaseVersion["androidVersionCode"]`, `releaseVersion["product"]`]],
  ["mac:makefile", "apps/builder-mac/Makefile", ["release/version.json", "CFBundleShortVersionString"]],
  ["studio-release.yml", ".github/workflows/studio-release.yml", ["release/version.json"]],
];

/** A literal version in a build file that should have come from the file. */
const FORBIDDEN = [
  ["android:app", "apps/mobile/android/app/build.gradle.kts", /versionCode\s*=\s*\d/, "versionCode must come from release/version.json"],
  ["android:app", "apps/mobile/android/app/build.gradle.kts", /versionName\s*=\s*"/, "versionName must come from release/version.json"],
  ["android:wear", "apps/mobile/android/wear/build.gradle.kts", /versionCode\s*=\s*[\d_]+\s*$/m, "wear versionCode must be phone + 1,000,000 from release/version.json"],
  ["android:wear", "apps/mobile/android/wear/build.gradle.kts", /versionName\s*=\s*"/, "versionName must come from release/version.json"],
];

/** @param {{read:(rel:string)=>string|null}} repo */
export function checkVersions(repo) {
  const findings = [];
  const raw = repo.read(VERSION_FILE);
  if (raw == null) {
    return { id: "versions", title: "One product version on every surface", findings: [{ key: VERSION_FILE, message: "release/version.json is missing" }], data: {} };
  }
  let parsed;
  try {
    parsed = parseVersion(raw);
  } catch (e) {
    return { id: "versions", title: "One product version on every surface", findings: [{ key: VERSION_FILE, message: `not valid JSON: ${e.message}` }], data: {} };
  }
  for (const e of parsed.errors) findings.push({ key: VERSION_FILE, message: e });
  const { v } = parsed;
  for (const sf of surfaces(v)) {
    const src = repo.read(sf.path);
    if (src == null) {
      findings.push({ key: sf.id, message: `${sf.path} is missing` });
      continue;
    }
    const all = [...src.matchAll(new RegExp(sf.pattern.source, sf.pattern.flags.includes("g") ? sf.pattern.flags : `${sf.pattern.flags}g`))];
    if (all.length === 0) {
      findings.push({ key: sf.id, message: `${sf.path}: ${sf.why}: pattern not found` });
      continue;
    }
    for (const m of all) {
      if (m[2] !== sf.want) findings.push({ key: sf.id, message: `${sf.path}: ${sf.why} is "${m[2]}", release/version.json says "${sf.want}"` });
    }
  }
  for (const [id, path, needles] of READERS) {
    const src = repo.read(path);
    if (src == null) {
      findings.push({ key: id, message: `${path} is missing` });
      continue;
    }
    for (const n of needles) if (!src.includes(n)) findings.push({ key: id, message: `${path} no longer reads ${n} (every surface takes its version from release/version.json)` });
  }
  for (const [id, path, rx, why] of FORBIDDEN) {
    const src = repo.read(path);
    if (src != null && rx.test(src)) findings.push({ key: id, message: `${path}: ${why}` });
  }
  return { id: "versions", title: "One product version on every surface (release/version.json)", findings, data: { product: v.product, label: v.label } };
}

/** Rewrite the generated surfaces from the file; returns the paths it changed. */
export function writeVersions(root) {
  const { v, errors } = parseVersion(readFileSync(join(root, VERSION_FILE), "utf8"));
  if (errors.length) throw new Error(errors.join("; "));
  const changed = new Set();
  for (const sf of surfaces(v)) {
    const abs = join(root, sf.path);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const rx = new RegExp(sf.pattern.source, sf.pattern.flags.includes("g") ? sf.pattern.flags : `${sf.pattern.flags}g`);
    const next = src.replace(rx, (_all, a, _old, c) => `${a}${sf.want}${c}`);
    if (next !== src) {
      writeFileSync(abs, next);
      changed.add(sf.path);
    }
  }
  return [...changed];
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--root");
  const root = resolve(ri >= 0 ? args[ri + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (args.includes("--write")) {
    const changed = writeVersions(root);
    console.log(changed.length ? `rewrote:\n  ${changed.join("\n  ")}` : "nothing to rewrite");
  }
  const repo = { read: (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null) };
  const r = checkVersions(repo);
  if (r.findings.length === 0) {
    console.log(`ok   versions: every surface reads ${r.data.product} ${r.data.label}`);
    return;
  }
  for (const f of r.findings) console.log(`RED  ${f.key}: ${f.message}`);
  console.log("Fix: edit release/version.json, then `node scripts/check-versions.mjs --write`.");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
