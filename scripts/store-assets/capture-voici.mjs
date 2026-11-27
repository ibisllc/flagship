#!/usr/bin/env node
// Slide 01's second frame (docs/store-assets/capture-plan.md): the caller's side of a voi.ci call. The real voi.ci
// site (apps/voici-site, its dev server with signed sample pages) on voi.ci/river-otter, in every ga language, with
// the Call button held down, at a phone's width. No network: the dev server answers for `.com`.
//
//   node scripts/store-assets/capture-voici.mjs [--lang ja,de]
//        -> store/captures/voici/<lang>/browser/01.png (1170 x 1230: a 390 x 410 viewport at 3x) and 01.json, where the
//           Call button sits (fractions of the image), for the template's touch mark
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDevServer } from "../../apps/voici-site/dev/serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const locales = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/locales.json"), "utf8"));
const i = process.argv.indexOf("--lang");
const langs = i > 0 ? process.argv[i + 1].split(",") : locales.locales.filter((l) => l.status === "ga").map((l) => l.code);
const browserLocale = (code) => ({ en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", "pt-BR": "pt-BR", ja: "ja-JP", "zh-Hans": "zh-CN" })[code] ?? code;

const port = 4800 + Math.floor(Math.random() * 1000);
const dev = await startDevServer({ port });
const browser = await chromium.launch();
try {
  for (const lang of langs) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 410 }, deviceScaleFactor: 3, locale: browserLocale(lang), colorScheme: "light", isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${dev.origin}/river-otter`);
    const call = page.locator(".call-btn").first();
    await call.waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    // The Call button held down: its pressed look, the moment before the call starts.
    const box = await call.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const out = path.join(ROOT, "store/captures/voici", lang, "browser", "01.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    const vp = page.viewportSize();
    fs.writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify({ tap: [(box.x + box.width / 2) / vp.width, (box.y + box.height / 2) / vp.height] }) + "\n");
    await page.mouse.up();
    console.log(`${lang}: ${path.relative(ROOT, out)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await dev.close();
}
