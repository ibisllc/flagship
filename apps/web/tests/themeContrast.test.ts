import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Teal has three roles (owner, 2026-10-17): --teal fills carry dark ink,
// --accent-graphic is the lighter step for icons, rings, focus and large
// headings (WCAG 3:1, on every surface), --accent is the deep step for small text and
// links (WCAG 4.5:1). --ok/--warn/--err are text-safe on paper too. iOS and Android mirror these values; change them here first.

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

type Tokens = Record<string, string>;

function block(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`no ${opener}`);
  let i = css.indexOf("{", at);
  const start = i + 1;
  let depth = 0;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`unclosed ${opener}`);
}

function decls(body: string): Tokens {
  const out: Tokens = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function resolve(t: Tokens, name: string, depth = 0): string {
  const v = t[name];
  if (v === undefined) throw new Error(`token ${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && depth < 6) return resolve(t, ref[1]!, depth + 1);
  return v;
}

type Rgba = [number, number, number, number];
function parse(v: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgba) {
    const p = rgba[1]!.split(",").map((x) => parseFloat(x));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`cannot parse colour ${v}`);
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)).concat(1) as Rgba;
}

function lum([r, g, b]: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function colour(t: Tokens, name: string): Rgba {
  return parse(resolve(t, name));
}

interface Sheet {
  name: string;
  light: Tokens;
  dark: Tokens;
  mediaDark?: Tokens;
}

function load(file: string, darkOpener: string, mediaOpener?: string): Sheet {
  const css = readFileSync(join(PUBLIC, file), "utf8");
  const light = decls(block(css, ":root {"));
  const darkOnly = decls(block(css, darkOpener));
  const mediaDark = mediaOpener ? decls(block(css, mediaOpener)) : undefined;
  return { name: file, light, dark: { ...light, ...darkOnly }, mediaDark };
}

const sheets: Sheet[] = [
  load("webapp/style.css", ':root[data-theme="dark"] {', "@media (prefers-color-scheme: dark) {"),
  load("tokens.css", ':root[data-theme="dark"] {'),
];

const ALL_SURFACES = ["--canvas", "--canvas-2", "--surface", "--surface-sunken", "--surface-elev"] as const;
function surfaces(t: Tokens, list: readonly string[]): string[] {
  return list.filter((s) => t[s] !== undefined);
}

describe.each(sheets)("teal roles in $name", (sheet) => {
  for (const theme of ["light", "dark"] as const) {
    const t = sheet[theme];

    describe(theme, () => {
      it("--accent (small text, links) reads at 4.5:1 on every surface", () => {
        for (const s of surfaces(t, ALL_SURFACES)) {
          expect(ratio(colour(t, "--accent"), colour(t, s)), `--accent on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("--accent-press (pressed and active text) reads at 4.5:1 on every surface", () => {
        for (const s of surfaces(t, ALL_SURFACES)) {
          expect(ratio(colour(t, "--accent-press"), colour(t, s)), `--accent-press on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("--accent-graphic (icons, focus, rings, large headings) reads at 3:1", () => {
        for (const s of surfaces(t, ALL_SURFACES)) {
          expect(ratio(colour(t, "--accent-graphic"), colour(t, s)), `--accent-graphic on ${s}`).toBeGreaterThanOrEqual(3);
        }
      });

      it("--accent stays text-safe on the tinted selection wash", () => {
        const wash = over(colour(t, "--accent-soft"), colour(t, "--canvas"));
        expect(ratio(colour(t, "--accent"), wash)).toBeGreaterThanOrEqual(4.5);
      });

      it("status text (--ok, --warn, --err) reads at 4.5:1 on every surface and on its own wash", () => {
        for (const [fg, wash] of [["--ok", "--ok-soft"], ["--warn", "--warn-soft"], ["--err", "--err-soft"]] as const) {
          for (const s of surfaces(t, ALL_SURFACES)) {
            expect(ratio(colour(t, fg), colour(t, s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
            const tinted = over(colour(t, wash), colour(t, s));
            expect(ratio(colour(t, fg), tinted), `${fg} on ${wash} over ${s}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("ink on a teal fill reads at 4.5:1 (rest and hover)", () => {
        const ink = colour(t, t["--on-teal"] ? "--on-teal" : "--accent-on");
        expect(ratio(ink, colour(t, "--teal"))).toBeGreaterThanOrEqual(4.5);
        expect(ratio(ink, colour(t, "--teal-bright"))).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("keeps the light fill teal and the pinned accent steps", () => {
    expect(resolve(sheet.light, "--teal").toUpperCase()).toBe("#14B8A6");
    expect(resolve(sheet.light, "--accent").toUpperCase()).toBe("#0F766E");
    expect(resolve(sheet.light, "--accent-graphic").toUpperCase()).toBe("#0E9488");
    expect(resolve(sheet.light, "--ok").toUpperCase()).toBe("#166534");
    expect(resolve(sheet.light, "--warn").toUpperCase()).toBe("#944D05");
    expect(resolve(sheet.light, "--err").toUpperCase()).toBe("#B91C1C");
    expect(resolve(sheet.dark, "--ok").toUpperCase()).toBe("#4ADE80");
    expect(resolve(sheet.dark, "--warn").toUpperCase()).toBe("#FBBF24");
    expect(resolve(sheet.dark, "--err").toUpperCase()).toBe("#F87171");
    expect(resolve(sheet.dark, "--accent").toUpperCase()).toBe("#2DD4BF");
    expect(resolve(sheet.dark, "--accent-graphic").toUpperCase()).toBe("#2DD4BF");
  });

  if (sheet.mediaDark) {
    it("the system-dark block matches the pinned dark theme", () => {
      for (const k of ["--accent", "--accent-graphic", "--accent-press", "--accent-soft"]) {
        expect(sheet.mediaDark![k], k).toBe(sheet.dark[k]);
      }
    });
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "vendor" || name === "downloads" || name === "fonts" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|html|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no teal fill colour is used as text", () => {
  it("text never takes --teal or --teal-bright (use --accent or --accent-graphic)", () => {
    const offenders: string[] = [];
    for (const f of walk(PUBLIC)) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (/(^|[^-\w])color:\s*var\(--teal(-bright)?\)/.test(line)) {
          offenders.push(`${relative(PUBLIC, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
