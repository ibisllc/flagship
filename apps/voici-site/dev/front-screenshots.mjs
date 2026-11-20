#!/usr/bin/env node
// Screenshots of voi.ci's front door (docs/voici-front-door.md) for review: desktop and phone, light and dark, French
// (an Ivorian browser, fr-CI) and English, plus a page's footer with "Make your page" and an unknown name. Fails
// on any console error or CSP violation, like dev/screenshots.mjs.
//
//   node apps/voici-site/build.mjs && node apps/voici-site/dev/front-screenshots.mjs [outDir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startDevServer } from "./serve.mjs";

const out = process.argv[2] ?? join(process.cwd(), "voici-front-screenshots");
mkdirSync(out, { recursive: true });
const port = 4800 + Math.floor(Math.random() * 500);
const dev = await startDevServer({ port });
const browser = await chromium.launch();
const sizes = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } };
const problems = [];
const files = [];

async function shot(name, size, scheme, locale, path, { full = true, bottom = false, ready = "body" } = {}) {
  const ctx = await browser.newContext({ viewport: sizes[size], colorScheme: scheme, locale, deviceScaleFactor: 2, hasTouch: size === "phone", isMobile: size === "phone" });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`${name}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  await page.goto(dev.origin + path);
  await page.waitForSelector(ready);
  await page.evaluate(() => document.fonts.ready);
  if (bottom) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(250);
  const file = join(out, `${name}-${size}-${scheme}.png`);
  await page.screenshot({ path: file, fullPage: full });
  await ctx.close();
  files.push(file);
}

for (const size of ["desktop", "phone"]) {
  for (const scheme of ["light", "dark"]) {
    await shot("front-fr", size, scheme, "fr-CI", "/");
    await shot("front-en", size, scheme, "en-US", "/");
    await shot("front-fold-fr", size, scheme, "fr-CI", "/", { full: false });
  }
}
await shot("front-wolof-browser", "phone", "light", "wo-SN", "/", { full: false });
for (const scheme of ["light", "dark"]) {
  await shot("page-footer-fr", "phone", scheme, "fr-CI", "/alice", { full: false, bottom: true, ready: ".page:not([aria-busy])" });
  await shot("page-footer-en", "desktop", scheme, "en-US", "/alice", { full: false, bottom: true, ready: ".page:not([aria-busy])" });
}
await shot("unknown-name-fr", "phone", "light", "fr-CI", "/nobody", { full: false, ready: ".page:not([aria-busy])" });

await browser.close();
await dev.close();
console.log(files.join("\n"));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
