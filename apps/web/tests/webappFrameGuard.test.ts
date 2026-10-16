import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFramed } from "../public/webapp/lib/frameGuard.js";

const WEBAPP = join(__dirname, "..", "public", "webapp");

describe("webapp frame guard", () => {
  it("is app.js's first import, so nothing boots in a frame", () => {
    const app = readFileSync(join(WEBAPP, "app.js"), "utf8");
    const firstImport = app.match(/^import .*$/m)?.[0];
    expect(firstImport).toBe('import "./lib/frameGuard.js";');
  });

  it("tells a top-level window from a framed one", () => {
    const top = {} as { top: unknown; self: unknown };
    top.top = top;
    top.self = top;
    expect(isFramed(top)).toBe(false);
    expect(isFramed({ top: {}, self: {} })).toBe(true);
    const crossOrigin = {
      self: {},
      get top(): unknown {
        throw new Error("SecurityError");
      },
    };
    expect(isFramed(crossOrigin)).toBe(true);
  });
});

describe("webapp shell runs under a CSP without 'unsafe-inline' scripts", () => {
  it("index.html has no inline script, inline handler or javascript: URL", () => {
    const html = readFileSync(join(WEBAPP, "index.html"), "utf8");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag).toMatch(/\bsrc="/);
    }
    expect(html).not.toMatch(/<script\b[^>]*>[^<\s]/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("no shell module builds inline handlers, evals or uses javascript: URLs", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js") || e.name.endsWith(".html")) files.push(p);
      }
    };
    walk(WEBAPP);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\beval\(|new Function\(/);
      expect(src, f).not.toMatch(/<[a-z][^>]*\son(click|load|error|change|input|submit|key\w+|mouse\w+|focus|blur)\s*=/i);
      expect(src, f).not.toMatch(/["'`]javascript:/i);
    }
  });
});
