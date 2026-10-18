import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Source-level release scans for the clients that ship without a native build
// step to scan (AGENTS.md "GA close-out" item 3). iOS has
// scripts/ios-release-clean.mjs; Android's built-APK check is
// apps/mobile/android/scripts/check-release-clean.sh. These keep the webapp,
// the public site, the .com Worker and Android's main source sets honest in
// plain `vitest`, with no Xcode or Gradle.
//
// Demo ACCOUNTS (evaluation) are a shipped feature, not a dev flip: nothing
// here forbids the demo sign-in path, `DemoAccount`, `demoServer` or the
// admin-secret-gated /api/dev/sample-user routes.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, accept: (p: string) => boolean, skip: (p: string) => boolean = () => false): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, accept, skip));
    else if (accept(p)) out.push(p);
  }
  return out;
}

function codeLines(file: string): Array<{ n: number; text: string }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !/^\s*(\*|\/\/|\/\*|#)/.test(text));
}

function scan(files: string[], forbidden: Array<{ id: string; re: RegExp }>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const { n, text } of codeLines(f)) {
      for (const { id, re } of forbidden) {
        if (re.test(text)) hits.push(`${relative(ROOT, f)}:${n} [${id}] ${text.trim().slice(0, 120)}`);
      }
    }
  }
  return hits;
}

describe("webapp and public site ship no developer surface", () => {
  const PUBLIC = join(ROOT, "apps/web/public");
  const files = walk(
    PUBLIC,
    (p) => /\.(js|html|json)$/.test(p),
    (p) => /\/(vendor|downloads|fonts)$/.test(p),
  );

  it("the phone simulator page is gone", () => {
    expect(existsSync(join(PUBLIC, "dev"))).toBe(false);
  });

  it("no debug flags, mock clients, fixtures or developer menus in shipped pages", () => {
    const hits = scan(files, [
      { id: "debug url flag", re: /[?&]debug=1|searchParams\.get\(["']debug["']\)/ },
      { id: "developer mode", re: /\buseLiveClient\b|\bmockLatency\w*|Developer menu|flagship\.dev\.|DeveloperSettings|developerMode/ },
      { id: "mock or fixture", re: /\b(Mock[A-Z]\w*|DemoFixtures|ServiceAccessFixture|samplePods\w*)\b/ },
      { id: "phone simulator", re: /phone simulator|\/dev\/create-server/i },
      { id: "removed debug endpoint", re: /\/api\/dev\/(late-log|rescue|destroy|server|upload-iso)\b/ },
    ]);
    expect(hits).toEqual([]);
  });

  it("the only /api/dev route a page may call is the demo sample-user one", () => {
    const hits = scan(files, [{ id: "dev route", re: /\/api\/dev\/(?!sample-user\b)/ }]);
    expect(hits).toEqual([]);
  });
});

describe(".com Worker serves only the demo routes under /api/dev", () => {
  it("controlPlaneRoutes has exactly one /api/dev prefix, sample-user", () => {
    const src = readFileSync(join(ROOT, "apps/com/src/controlPlaneRoutes.ts"), "utf8");
    const routes = new Set([...src.matchAll(/\/api\/dev\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
    expect([...routes]).toEqual(["sample-user"]);
    expect(src).not.toMatch(/DEV_(LATE_LOG|RESCUE|DESTROY|SERVER_INFO|UPLOAD_ISO)/);
  });

  it("demo account support is intact", () => {
    const src = readFileSync(join(ROOT, "apps/com/src/controlPlaneRoutes.ts"), "utf8");
    expect(src).toContain("DEMO_IRK_KEK");
    expect(src).toContain("DEMO_USER_PAIR");
    expect(readFileSync(join(ROOT, "scripts/sample-user.mjs"), "utf8")).toContain("cleanup");
  });
});

describe("Android release sources carry no mock, gym or developer code", () => {
  const ANDROID = join(ROOT, "apps/mobile/android");
  const FORBIDDEN = [
    { id: "mock or fixture class", re: /\b(Mock[A-Z][A-Za-z0-9]*|DemoFixtures|SmokeMode|SmokeModeConfig|GymSeams|GymProbe|FixedPodClients|FakePasskeyApp|DeveloperSettings|DeveloperScreen[A-Za-z]*)\b/ },
    { id: "debug-only string", re: /flagship\.smoke|flagship\.apexHost|unlock developer|Developer unlocked|useLiveClient|mockLatency|fake-passkey/ },
  ];

  it("app/src/main, wear/src/main and app/src/release are clean", () => {
    const files = [
      ...walk(join(ANDROID, "app/src/main"), (p) => p.endsWith(".kt")),
      ...walk(join(ANDROID, "app/src/release"), (p) => p.endsWith(".kt")),
      ...walk(join(ANDROID, "wear/src/main"), (p) => p.endsWith(".kt")),
    ];
    expect(files.length).toBeGreaterThan(50);
    expect(scan(files, FORBIDDEN)).toEqual([]);
  });

  it("the manifests are not debuggable, test-only or cleartext", () => {
    for (const m of ["app/src/main/AndroidManifest.xml", "wear/src/main/AndroidManifest.xml"]) {
      const xml = readFileSync(join(ANDROID, m), "utf8");
      expect(xml, m).not.toMatch(/android:debuggable\s*=\s*"true"|android:testOnly\s*=\s*"true"|usesCleartextTraffic\s*=\s*"true"/);
    }
  });
});
