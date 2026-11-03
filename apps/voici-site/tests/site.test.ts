// The voi.ci site's rules (docs/voici-and-messages.md §4.2, §4.4, §12): reproducible build with SRI, strings all
// through i18n, and source-grep checks that keep anything a visitor or a page sends from ever being parsed as HTML
// or run as code. Then the renderer itself, on a tiny fake DOM, with hostile content.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDrift, buildSite } from "../build.mjs";
import { checkI18n } from "../i18n.mjs";
import { routeOf, siteConfig } from "../src/config.js";

const root = join(import.meta.dirname, "..");
const srcDir = join(root, "src");
const webDir = join(root, "..", "..", "packages", "flagship-web", "src");
const own = readdirSync(srcDir).filter((f) => f.endsWith(".js"));
const libFiles = readdirSync(webDir).filter((f) => f.endsWith(".js"));
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");
/** Source without its comments (the rules below are about code, and dom.js's header names what it forbids). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("voi.ci build", () => {
  it("the committed build is exactly what the sources build to", () => {
    expect(buildDrift()).toEqual([]);
  });

  it("the shell carries SRI on every script, stylesheet and module, and no inline script or style", () => {
    const b = buildSite();
    const shell = b.shell;
    expect(shell).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(shell).not.toMatch(/<style/);
    expect(shell).not.toMatch(/\sstyle=/);
    expect(shell).not.toMatch(/\son[a-z]+=/i);
    const sri = (p: string) => "sha384-" + createHash("sha384").update(b.files.get(p)!).digest("base64");
    const js = [...b.files.keys()].filter((p) => p.endsWith(".js") && p !== "sw.js");
    expect(b.files.has("sw.js")).toBe(true);
    expect(shell).not.toContain("sw.js");
    for (const p of js) {
      const tag = p === "app.js" ? `<script type="module" src="/-/${b.dir}/app.js" integrity="${sri(p)}">` : `<link rel="modulepreload" href="/-/${b.dir}/${p}" integrity="${sri(p)}">`;
      expect(shell, p).toContain(tag);
    }
    expect(shell).toContain(`<link rel="stylesheet" href="/-/${b.dir}/style.css" integrity="${sri("style.css")}">`);
    const manifest = JSON.parse(b.files.get("MANIFEST.json")!.toString("utf8"));
    expect(createHash("sha256").update(b.files.get("MANIFEST.json")!).digest("hex")).toBe(b.build);
    for (const [p, h] of Object.entries(manifest.files)) expect(createHash("sha256").update(b.files.get(p)!).digest("hex"), p).toBe(h);
    expect(b.dir).toBe(b.build.slice(0, 16));
  });

  it("every string goes through i18n and every ga language has it", () => {
    expect(checkI18n()).toEqual([]);
  });
});

describe("voi.ci source rules (§12)", () => {
  const all = [...own.map((f) => [f, code(read(srcDir, f))]), ...libFiles.map((f) => [`flagship-web/${f}`, code(read(webDir, f))])] as [string, string][];

  it("never parses HTML or evaluates code", () => {
    const banned = [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\s*\(/,
      /new\s+Function\b/,
      /DOMParser/,
      /createContextualFragment/,
      /srcdoc/,
      /setAttribute\(\s*["'`]on/i,
      /setAttribute\(\s*["'`]style/i,
      /\.style\.[a-zA-Z]+\s*=/,
      /\.style\.cssText/,
      /javascript:/i,
      /setTimeout\(\s*["'`]/,
      /importScripts/,
      /localStorage\.setItem\([^)]*(threadSeed|privateKey)/,
    ];
    for (const [f, s] of all) for (const b of banned) expect(b.test(s), `${f}: ${b}`).toBe(false);
  });

  it("renders only through the dom.js allow-list (no raw createElement outside it, except text-only spans)", () => {
    for (const [f, s] of all) {
      if (f === "dom.js" || f.startsWith("flagship-web/")) continue;
      const raw = s.match(/createElement(NS)?\(/g) ?? [];
      if (f === "icons.js") expect(raw.length, f).toBe(1);
      else expect(raw.length, f).toBe(0);
    }
  });

  it("talks to the network only without credentials, and opens links with noopener", () => {
    for (const [f, s] of all) {
      for (const m of s.matchAll(/\bf\(|fetch\(/g)) void m;
      expect(/credentials:\s*["']include["']/.test(s), f).toBe(false);
      for (const m of s.matchAll(/target:\s*"_blank"[^}]*/g)) expect(m[0], f).toMatch(/rel:\s*"noopener/);
      expect(/window\.open\([^)]*\)/.test(s) && !/noopener/.test(s), f).toBe(false);
    }
    const deliver = read(webDir, "deliver.js");
    expect(deliver).toContain('credentials: "omit"');
    expect(read(webDir, "verify.js")).toContain('credentials: "omit"');
  });

  it("keeps the browser key non-extractable", () => {
    const env = read(webDir, "envelope.js");
    expect(env).toMatch(/generateKey\(\{ name: "ECDSA", namedCurve: "P-256" \}, false,/);
    for (const [f, s] of all) expect(/exportKey\(\s*["'](pkcs8|jwk)["']/.test(s), f).toBe(false);
  });

  it("has no third-party origin anywhere in the site", () => {
    const allowed = /https:\/\/(voi\.ci|gym\.voi\.ci|files\.voi\.ci|files\.gym\.voi\.ci|\$\{)/;
    for (const [f, s] of own.map((x) => [x, read(srcDir, x)]) as [string, string][]) {
      for (const m of s.matchAll(/https:\/\/[^\s"'`)]+/g)) {
        if (f === "strings.js") continue;
        expect(allowed.test(m[0]) || /^https:\/\/(flagshipserver\.com|gym\.flagshipserver\.com)$/.test(m[0]), `${f}: ${m[0]}`).toBe(true);
      }
    }
    const css = read(srcDir, "style.css");
    expect(css).not.toMatch(/url\(\s*["']?(https?:|\/\/)/);
    expect(css).not.toMatch(/@import/);
  });
});

describe("voi.ci config and routes", () => {
  it("knows only voi.ci and gym.voi.ci (dev only on localhost)", () => {
    const doc = { querySelector: () => null } as unknown as Document;
    expect(siteConfig({ hostname: "voi.ci" } as Location, doc)).toMatchObject({ apex: "flagshipserver.com", files: "https://files.voi.ci", origin: "https://voi.ci" });
    expect(siteConfig({ hostname: "gym.voi.ci" } as Location, doc)).toMatchObject({ apex: "gym.flagshipserver.com", files: "https://files.gym.voi.ci" });
    expect(siteConfig({ hostname: "evil.example" } as Location, doc)).toBeNull();
    const devDoc = { querySelector: () => ({ getAttribute: () => JSON.stringify({ origin: "https://voi.ci", host: "voi.ci", apex: "x", services: "y", files: "http://z", apiBase: "http://z" }) }) } as unknown as Document;
    expect(siteConfig({ hostname: "evil.example" } as Location, devDoc)).toBeNull();
    expect(siteConfig({ hostname: "127.0.0.1" } as Location, devDoc)).toMatchObject({ dev: true });
    expect(siteConfig({ hostname: "voi.ci" } as Location, devDoc)).toMatchObject({ dev: false, apex: "flagshipserver.com" });
  });

  it("routes /<username> and /-/about only", () => {
    expect(routeOf("/alice")).toEqual({ view: "page", username: "alice" });
    expect(routeOf("/alice/")).toEqual({ view: "page", username: "alice" });
    expect(routeOf("/-/about")).toEqual({ view: "about" });
    for (const p of ["/", "/Alice", "/a/b", "/alice--x", "/-alice", "/%3Cscript%3E", "/-/x"]) expect(routeOf(p).view, p).toBe("missing");
  });
});
