// release/version.json is the one source for every surface's version
// (owner decision 2026-10-18). This pins the real tree to it and proves the
// checker notices each kind of drift.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { checkVersions, parseVersion, surfaces, writeVersions, READERS } from "./check-versions.mjs";

const ROOT = resolve(__dirname, "..");
// The drift cases below start from what the real file says, so a release bump touches only the pin in the first test.
const V = parseVersion(readFileSync(join(ROOT, "release/version.json"), "utf8")).v;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const repoAt = (root: string) => ({
  read: (rel: string) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch {
      return null;
    }
  },
});

function copyOfTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "versions-"));
  const rels = new Set<string>(["release/version.json"]);
  const v = parseVersion(readFileSync(join(ROOT, "release/version.json"), "utf8")).v;
  for (const s of surfaces(v)) rels.add(s.path);
  for (const [, path] of READERS) rels.add(path);
  for (const rel of rels) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

describe("release/version.json", () => {
  it("is valid and carries the 0.4 Beta product version", () => {
    const { v, errors } = parseVersion(readFileSync(join(ROOT, "release/version.json"), "utf8"));
    expect(errors).toEqual([]);
    expect(v.product).toBe("0.4");
    expect(v.label).toBe("Beta");
    expect(v.iosVersion).toBe("1.3");
    expect(v.iosBuild).toBe(12);
    expect(v.androidVersionCode).toBe(16);
    expect(v.studio).toBe("0.4.0");
    expect(v.marketplace).toBe(false);
  });

  it("carries the marketplace switch to the webapp, iOS and Android", () => {
    expect(readFileSync(join(ROOT, "apps/web/public/webapp/lib/buildInfo.js"), "utf8")).toContain(`export const MARKETPLACE_ENABLED = ${V.marketplace};`);
    expect(readFileSync(join(ROOT, "apps/mobile/shared/Sources/FlagshipCore/ProductFeatures.swift"), "utf8")).toContain(`public static let marketplace = ${V.marketplace}`);
    expect(readFileSync(join(ROOT, "apps/mobile/android/app/build.gradle.kts"), "utf8")).toContain('buildConfigField("boolean", "MARKETPLACE", releaseVersion["marketplace"].toString())');
  });

  it("puts the Wear OS app one million above the phone's version code", () => {
    const kts = readFileSync(join(ROOT, "apps/mobile/android/wear/build.gradle.kts"), "utf8");
    expect(kts).toMatch(/versionCode = 1_000_000 \+ \(releaseVersion\["androidVersionCode"\] as Number\)\.toInt\(\)/);
    expect(1_000_000 + V.androidVersionCode).toBe(1_000_016);
  });

  it("keeps the iOS version above the approved 1.0 (4) and Android above Play's 8", () => {
    const { v } = parseVersion(readFileSync(join(ROOT, "release/version.json"), "utf8"));
    expect(Number(v.iosVersion.split(".")[1])).toBeGreaterThan(0);
    expect(v.iosBuild).toBeGreaterThan(4);
    expect(v.androidVersionCode).toBeGreaterThan(8);
  });

  it("is what every surface in this tree says", () => {
    expect(checkVersions(repoAt(ROOT)).findings).toEqual([]);
  });

  it("puts the label beside the number on the homepage", () => {
    const html = readFileSync(join(ROOT, "apps/web/public/index.html"), "utf8");
    expect(html).toContain(`<span>v${V.product} ${V.label}</span>`);
    expect(html).not.toMatch(/v0\.1 alpha/);
  });

  it("shows the product version in the webapp About and the shell build beside it", () => {
    const html = readFileSync(join(ROOT, "apps/web/public/webapp/index.html"), "utf8");
    expect(html).toContain('id="about-version"');
    const app = readFileSync(join(ROOT, "apps/web/public/webapp/app.js"), "utf8");
    expect(app).toContain("aboutVersionLine()");
  });

  it("stamps Android from the file: no literal versionCode or versionName", () => {
    for (const f of ["app", "wear"]) {
      const kts = readFileSync(join(ROOT, `apps/mobile/android/${f}/build.gradle.kts`), "utf8");
      expect(kts).not.toMatch(/versionCode\s*=\s*[\d_]+\s*$/m);
      expect(kts).not.toMatch(/versionName\s*=\s*"/);
    }
  });
});

describe("drift is caught", () => {
  const drift = (rel: string, from: string | RegExp, to: string) => {
    const dir = copyOfTree();
    const p = join(dir, rel);
    const before = readFileSync(p, "utf8");
    const after = before.replace(from, to);
    expect(after).not.toBe(before);
    writeFileSync(p, after);
    return { dir, findings: checkVersions(repoAt(dir)).findings };
  };

  it("an old homepage badge", () => {
    const { findings } = drift("apps/web/public/index.html", `<span>v${V.product} ${V.label}</span>`, "<span>v0.1 alpha</span>");
    expect(findings.map((f: { key: string }) => f.key)).toEqual(["website:hero"]);
  });

  it("a stale iOS build number or store version", () => {
    expect(drift("apps/mobile/ios/App/project.yml", `CURRENT_PROJECT_VERSION: "${V.iosBuild}"`, 'CURRENT_PROJECT_VERSION: "4"').findings[0].key).toBe("ios:project.yml:build");
    expect(drift("apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj", new RegExp(`MARKETING_VERSION = ${escapeRe(V.iosVersion)};`, "g"), "MARKETING_VERSION = 1.0;").findings.length).toBe(2);
  });

  it("a hard-coded Android version code", () => {
    const { findings } = drift("apps/mobile/android/app/build.gradle.kts", /versionCode = \(releaseVersion\["androidVersionCode"\] as Number\)\.toInt\(\)/, "versionCode = 8");
    expect(findings.some((f: { message: string }) => /versionCode/.test(f.message))).toBe(true);
  });

  it("the Mac bundle still on 0.1.0", () => {
    expect(drift("apps/builder-mac/Info.plist", `<string>${V.studio}</string>`, "<string>0.1.0</string>").findings[0].key).toBe("mac:plist");
  });

  it("a Studio workflow that stopped reading the file", () => {
    const { findings } = drift(".github/workflows/studio-release.yml", /release\/version\.json/g, "version.txt");
    expect(findings.some((f: { key: string }) => f.key === "studio-release.yml")).toBe(true);
  });

  it("--write puts a drifted tree back", () => {
    const dir = copyOfTree();
    const dot = V.product.indexOf(".");
    const next = `${V.product.slice(0, dot)}.${Number(V.product.slice(dot + 1)) + 1}`;
    writeFileSync(
      join(dir, "release/version.json"),
      JSON.stringify({ product: next, label: "Beta", iosVersion: V.iosVersion, iosBuild: V.iosBuild + 1, androidVersionCode: V.androidVersionCode + 1, studio: `${next}.0`, marketplace: V.marketplace }),
    );
    expect(checkVersions(repoAt(dir)).findings.length).toBeGreaterThan(0);
    const changed = writeVersions(dir);
    expect(changed).toContain("apps/web/public/index.html");
    expect(checkVersions(repoAt(dir)).findings).toEqual([]);
    expect(readFileSync(join(dir, "apps/web/public/index.html"), "utf8")).toContain(`<span>v${next} Beta</span>`);
  });

  it("a Rust crate version that is not the product version (the relay reported 0.3.0 in 0.4)", () => {
    const { findings } = drift("rust/Cargo.toml", /\[workspace\.package\]\nversion = "[^"]*"/, '[workspace.package]\nversion = "0.0.1"');
    expect(findings.map((f: { key: string }) => f.key)).toEqual(["rust:workspace"]);
    const dir = copyOfTree();
    const toml = join(dir, "rust/Cargo.toml");
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/(\[workspace\.package\]\nversion = ")[^"]*/, "$10.0.1"));
    expect(writeVersions(dir)).toContain("rust/Cargo.toml");
    expect(readFileSync(toml, "utf8")).toContain(`[workspace.package]\nversion = "${V.product}.0"`);
  });

  it("no Studio carries an Experimental tag (owner, 2026-11-20)", () => {
    for (const f of ["apps/web/public/app-stores.js", "apps/builder-windows/src/StudioVersion.cs", "apps/builder-linux/version.py"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/experimental/i);
    }
  });

  it("a webapp or iOS marketplace switch that disagrees with the file", () => {
    expect(drift("apps/web/public/webapp/lib/buildInfo.js", `MARKETPLACE_ENABLED = ${V.marketplace};`, `MARKETPLACE_ENABLED = ${!V.marketplace};`).findings.map((f: { key: string }) => f.key)).toEqual(["webapp:marketplace"]);
    expect(drift("apps/mobile/shared/Sources/FlagshipCore/ProductFeatures.swift", `marketplace = ${V.marketplace}`, `marketplace = ${!V.marketplace}`).findings.map((f: { key: string }) => f.key)).toEqual(["ios:marketplace"]);
  });

  it("an Android build that stopped reading the marketplace switch", () => {
    const { findings } = drift("apps/mobile/android/app/build.gradle.kts", /buildConfigField\("boolean", "MARKETPLACE", [^\n]*/, 'buildConfigField("boolean", "MARKETPLACE", "true")');
    expect(findings.some((f: { key: string; message: string }) => f.key === "android:app" && /marketplace/.test(f.message))).toBe(true);
  });

  it("--write flips the marketplace switch on every generated surface", () => {
    const dir = copyOfTree();
    writeFileSync(join(dir, "release/version.json"), JSON.stringify({ ...V, marketplace: !V.marketplace }));
    expect(checkVersions(repoAt(dir)).findings.map((f: { key: string }) => f.key).sort()).toEqual(["ios:marketplace", "webapp:marketplace"]);
    expect(writeVersions(dir).sort()).toEqual(["apps/mobile/shared/Sources/FlagshipCore/ProductFeatures.swift", "apps/web/public/webapp/lib/buildInfo.js"]);
    expect(checkVersions(repoAt(dir)).findings).toEqual([]);
  });

  it("a marketplace switch that is not a boolean", () => {
    expect(parseVersion(JSON.stringify({ ...V, marketplace: "off" })).errors.join(" ")).toMatch(/marketplace must be true or false/);
  });

  it("a studio version that disagrees with the product version", () => {
    const { errors } = parseVersion(JSON.stringify({ product: "0.2", label: "Beta", iosVersion: "1.1", iosBuild: 5, androidVersionCode: 9, studio: "0.3.0", marketplace: false }));
    expect(errors.join(" ")).toMatch(/must start with the product version/);
  });
});
