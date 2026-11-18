// voi.ci's front door (docs/voici-front-door.md): the static page per language the build renders for voi.ci/, the
// language rule it and the site share, and the footer link that brings a page's visitors to it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSite, storeLinks } from "../build.mjs";
import { isFrancophoneTag, parseAcceptLanguage, pickLanguage } from "../src/lang.js";
import { LOCALES } from "../src/strings.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const vectors = (f: string) => JSON.parse(readFileSync(join(repo, f), "utf8")) as { ga?: string[]; cases: Array<{ accept: string; expect: string }> };
const codes = LOCALES.map((l: { code: string }) => l.code);

describe("the front door's language", () => {
  it("follows the shared rule (test-vectors/language-negotiation.json)", () => {
    const v = vectors(join("test-vectors", "language-negotiation.json"));
    for (const c of v.cases) expect(pickLanguage(parseAcceptLanguage(c.accept), ["en", ...v.ga!]), c.accept).toBe(c.expect);
  });

  it("gives French to a French reader whose own language doesn't ship (test-vectors/voici-front-language.json)", () => {
    for (const c of vectors(join("test-vectors", "voici-front-language.json")).cases) expect(pickLanguage(parseAcceptLanguage(c.accept), codes), c.accept).toBe(c.expect);
  });

  it("reads navigator.languages the same way", () => {
    expect(pickLanguage(["fr-CI", "en-US"], codes)).toBe("fr");
    expect(pickLanguage(["wo-SN"], codes)).toBe("fr");
    expect(pickLanguage(["zh-TW", "ja"], codes)).toBe("ja");
    expect(isFrancophoneTag("en-CI")).toBe(true);
    expect(isFrancophoneTag("en-GB")).toBe(false);
  });
});

describe("the front door page", () => {
  const b = buildSite();
  const pages = b.front as Record<string, string>;

  it("is built for every shipped language, in that language", () => {
    expect(Object.keys(pages).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(pages[code], code).toContain(`<html lang="${code}"`);
      expect(pages[code], code).toContain(`<link rel="canonical" href="%ORIGIN%/?lang=${code}">`);
    }
    expect(pages.en).toContain("A page of your own.");
    expect(pages.fr).toContain("Une page bien à vous.");
    expect(pages.fr).not.toContain("A page of your own.");
  });

  it("runs no script and has no inline style, and its one stylesheet carries SRI", () => {
    const sri = "sha384-" + createHash("sha384").update(b.files.get("style.css")!).digest("base64");
    for (const [code, html] of Object.entries(pages)) {
      expect(html, code).not.toMatch(/<script/i);
      expect(html, code).not.toMatch(/<style/i);
      expect(html, code).not.toMatch(/\sstyle=/i);
      expect(html, code).not.toMatch(/\son[a-z]+=/i);
      expect(html, code).toContain(`<link rel="stylesheet" href="/-/${b.dir}/style.css" integrity="${sri}">`);
    }
  });

  it("loads nothing from anywhere else, and links out only over https", () => {
    for (const [code, html] of Object.entries(pages)) {
      for (const m of html.matchAll(/<link [^>]*href="([^"]+)"/g)) expect(m[1]!.startsWith(`/-/${b.dir}/`) || m[1]!.startsWith("%ORIGIN%/"), `${code}: ${m[1]}`).toBe(true);
      expect(html, code).not.toMatch(/<(img|iframe|object|embed|video|audio|source)\b/i);
      for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) expect(/^(https:\/\/|\/)/.test(m[1]!), `${code}: ${m[1]}`).toBe(true);
    }
  });

  it("sends people to the stores (from app-stores.js), the webapp and the app's page editor, never to a sign-up here", () => {
    const stores = storeLinks();
    expect(stores.ios).toMatch(/^https:\/\/apps\.apple\.com\//);
    expect(stores.android).toMatch(/^https:\/\/play\.google\.com\//);
    for (const html of Object.values(pages)) {
      expect(html).toContain(`href="${stores.ios}"`);
      expect(html).toContain(`href="${stores.android}"`);
      expect(html).toContain('href="https://webapp.%APEX%/"');
      expect(html).toContain('href="https://%APEX%/app/page-editor"');
      expect(html).not.toMatch(/<form|<input/i);
    }
    expect(() => storeLinks("const STORES = {};")).toThrow();
  });

  it("names every language for search engines and offers each as a plain link", () => {
    for (const [code, html] of Object.entries(pages)) {
      for (const l of codes) {
        expect(html, code).toContain(`<link rel="alternate" hreflang="${l}" href="%ORIGIN%/?lang=${l}">`);
        expect(html, code).toContain(`href="/?lang=${l}"`);
      }
      expect(html, code).toContain('<link rel="alternate" hreflang="x-default" href="%ORIGIN%/">');
      expect(html, code).toContain('<meta name="robots" content="index, follow">');
      expect(html, code).toMatch(new RegExp(`href="/\\?lang=${code}" hreflang="${code}" lang="${code}" aria-current="true"`));
    }
  });

  it("keeps the 404 and 410 shells out of search results, and the page shell as it was", () => {
    expect(b.workerModule).toContain("VOICI_FRONT_DOOR");
    expect(b.shell).not.toContain("noindex");
    const mod = b.workerModule;
    const shell404 = JSON.parse(/VOICI_SITE_SHELL_404 = (".*");/.exec(mod)![1]!);
    expect(shell404).toContain('<meta name="robots" content="noindex">');
  });
});

/** JPEG segment markers before the scan, and the frame's width and height. */
function jpegInfo(b: Buffer) {
  const markers: number[] = [];
  let size: [number, number] | null = null;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    const m = b[i + 1]!;
    markers.push(m);
    if (m >= 0xc0 && m <= 0xc2) size = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { markers, size };
}

describe("the front door's share card (docs/voici-and-messages.md §2.10)", () => {
  it("is a 1200×630 JPEG under 256 KiB with no metadata segment", () => {
    const b = readFileSync(join(repo, "apps/voici-site/src/share-card.jpg"));
    expect([b[0], b[1], b[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(b.length).toBeLessThan(256 * 1024);
    const info = jpegInfo(b);
    expect(info.size).toEqual([1200, 630]);
    expect(info.markers.filter((m) => m >= 0xe1 && m <= 0xef)).toEqual([]);
  });

  it("every language's front door names it as og:image and twitter:image with a large card", () => {
    const site = buildSite();
    expect(site.files.has("share-card.jpg")).toBe(true);
    for (const html of Object.values(site.front) as string[]) {
      const img = `%ORIGIN%/-/${site.dir}/share-card.jpg`;
      expect(html).toContain(`<meta property="og:image" content="${img}">`);
      expect(html).toContain(`<meta name="twitter:image" content="${img}">`);
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).toContain('<meta property="og:image:width" content="1200">');
    }
  });
});
