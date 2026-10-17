import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// GA rule (owner, 2026-10-16): the shipped webapp carries no developer mode
// and no mock or fixture data. The web gym's fakes live in the test harness
// (apps/web/e2e, tools/gym), never in apps/web/public/webapp.
const WEBAPP = join(__dirname, "..", "public", "webapp");

export const FORBIDDEN: Array<[RegExp, string]> = [
  [/[?&]debug=1|\.get\(\s*["']debug["']\s*\)/, "the ?debug=1 developer flag"],
  [/["']flagship\.debug["']/, "the sticky flagship.debug localStorage key"],
  [/\bisDebug\s*\(/, "an isDebug() developer gate"],
  [/settings-debug-toggle|settings-developer-row|Show developer tools/, "Settings' developer section"],
  [/orders-debug|Send order \(debug\)/, "the debug send-order panel"],
  [/\bmock(?!up)/i, "mock code or data"],
  [/\bfixtures?\b/i, "fixture code or data"],
  [/__gym|smoke-mode|useLiveClient|mockLatency/i, "a gym or developer seam"],
];

function shippedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...shippedFiles(p));
    else if (/\.(js|mjs|html|css|json|webmanifest|svg)$/.test(name)) out.push(p);
  }
  return out;
}

export function findDevToolMarkers(files: Array<{ path: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const [re, what] of FORBIDDEN) {
        if (re.test(line)) hits.push(`${path}:${i + 1}: ${what}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe("shipped webapp has no developer tools or mock data", () => {
  it("no shipped file carries a debug flag, developer panel, mock or fixture", () => {
    const files = shippedFiles(WEBAPP).map((p) => ({ path: relative(WEBAPP, p), text: readFileSync(p, "utf8") }));
    expect(files.length).toBeGreaterThan(50);
    // gym branch only: the live gym's identity-adoption seam (gated to the
    // gym host in app.js, see installGymAdoptSeam); main carries none.
    const hits = findDevToolMarkers(files).filter((h) => !/^app\.js:\d+: a gym or developer seam: .*__gymAdopt/.test(h));
    expect(hits).toEqual([]);
  });

  it("catches each marker it is meant to catch", () => {
    const planted = [
      'if (new URLSearchParams(location.search).get("debug") === "1") {}',
      'localStorage.setItem("flagship.debug", "1");',
      "if (isDebug()) show();",
      '<input type="checkbox" id="settings-debug-toggle" />',
      'import { enterOrdersDebug } from "./views/orders-debug.js";',
      "export class MockScreensClient {}",
      'import pods from "../fixtures/pods.json";',
      "window.__gymSeed = {};",
    ];
    for (const line of planted) {
      expect(findDevToolMarkers([{ path: "planted.js", text: line }]), line).toHaveLength(1);
    }
    // Real features that only look similar stay allowed.
    for (const line of [
      'const KEY_STORE = "flagship.debugKey.";',
      "attach a screenshot or mockup",
      '"server.debug-access.granted": { label: "Debug access turned on" },',
    ]) {
      expect(findDevToolMarkers([{ path: "ok.js", text: line }]), line).toEqual([]);
    }
  });
});
