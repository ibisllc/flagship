import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The open-in-app page (/join, /share … /app/<route>) and /studio are served by the Worker at their
// own URL in the visitor's language (apps/com/src/localeRedirect.ts localisedAssetPath), from the
// copies scripts/i18n-web.mjs builds under /<webPath>/. Every live language must have them, with
// every sentence translated, and no site script may write English into a translated page.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUBLIC = join(ROOT, "apps/web/public");
const locales = JSON.parse(readFileSync(join(ROOT, "i18n/locales.json"), "utf8")) as {
  source: string;
  locales: Array<{ code: string; status: string; webPath?: string }>;
};
const live = locales.locales.filter((l) => l.status === "ga" && l.code !== locales.source);

const sentences = (html: string, attr: string) =>
  [...html.matchAll(new RegExp(`<p ${attr}="([^"]+)">([^<]*)</p>`, "g"))].map((m) => [m[1]!, m[2]!.trim()] as const);

describe("pages served at a fixed URL exist in every live language", () => {
  const englishOpen = readFileSync(join(PUBLIC, "open/index.html"), "utf8");
  const route = readFileSync(join(ROOT, "apps/com/src/route.ts"), "utf8");
  const list = /APP_LINK_PATHS[^=]*=\s*new Set\(\s*\[([^\]]*)\]/.exec(route)?.[1] ?? "";
  const appLinks = [...list.matchAll(/"(\/[a-z-]+)"/g)].map((m) => m[1]!);

  it("the English open-in-app page has a headline and a line for every app link", () => {
    expect(appLinks.length).toBeGreaterThan(5);
    for (const p of appLinks) expect(englishOpen, p).toContain(`data-link="${p}"`);
    // The script picks from the page; it carries no sentence of its own.
    const script = englishOpen.slice(englishOpen.lastIndexOf("<script>"));
    expect(script).not.toMatch(/Get the app/);
  });

  for (const l of live) {
    it(`${l.code}: open/index.html and studio/index.html are built and translated`, () => {
      for (const page of ["open/index.html", "studio/index.html"]) {
        const file = join(PUBLIC, l.webPath!, page);
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file, "utf8")).toContain(`<html lang="${l.code}"`);
      }
      const open = readFileSync(join(PUBLIC, l.webPath!, "open/index.html"), "utf8");
      const en = new Map(sentences(englishOpen, "data-part").map(([, t], i) => [i, t]));
      const tr = sentences(open, "data-part");
      expect(tr.length).toBe(en.size);
      tr.forEach(([, t], i) => expect(t, `${l.code} sentence ${i}`).not.toBe(en.get(i)));
      for (const p of appLinks) expect(open, p).toContain(`data-link="${p}"`);
    });
  }
});

describe("site scripts take their words from the page", () => {
  it("the status board and the security report form show only sentences that are in the page", () => {
    const status = readFileSync(join(PUBLIC, "status/index.html"), "utf8");
    const statusScript = status.slice(status.indexOf("const HISTORY_LEN"));
    for (const word of ['"operational"', '"degraded"', '"Auto-refresh: "', '"(local error)"', '" in "']) {
      expect(statusScript).not.toContain(word);
    }
    expect(status).toContain('id="status-messages" hidden');
    const security = readFileSync(join(PUBLIC, "security.html"), "utf8");
    const formScript = security.slice(security.indexOf('<script type="module">'));
    expect(formScript).not.toMatch(/"Submitting|Thank you|Network error/);
    expect(security).toContain('id="report-messages" hidden');
    // The report's component is submitted in English whatever the page's language.
    expect(security).not.toMatch(/<option>[^<]*<\/option>/);
  });

  it("theme.js never writes an English label into a translated page", () => {
    const theme = readFileSync(join(PUBLIC, "theme.js"), "utf8");
    expect(theme).not.toMatch(/Switch to (light|dark) theme/);
  });
});
