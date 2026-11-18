#!/usr/bin/env node
// Draws voi.ci's front-door share card (docs/voici-and-messages.md §2.10, docs/voici-front-door.md §6): the fixed
// 1200×630 picture link previews show for https://voi.ci/. No words but the wordmark, so one card serves every
// language. Writes apps/voici-site/src/share-card.jpg (a JPEG screenshot: JFIF only, no EXIF or colour profile).
//
//   node apps/voici-site/dev/share-card.mjs && node apps/voici-site/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const font = readFileSync(join(repo, "apps/web/public/fonts/Geist-Variable.woff2")).toString("base64");
const out = join(here, "..", "src", "share-card.jpg");

// The page's classic tokens (src/style.css): canvas, surface, ink, muted, rule, the teal accent.
const html = `<!doctype html><html><head><style>
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
html, body { margin: 0; width: 1200px; height: 630px; background: #f7f6f2; font-family: Geist, sans-serif; color: #14140f; }
.mark { position: absolute; left: 100px; top: 210px; font-size: 168px; font-weight: 700; letter-spacing: -6px; line-height: 1; }
.dot { color: #14b8a6; }
.rule { position: absolute; left: 100px; right: 100px; top: 520px; height: 2px; background: #e5e3dc; }
.page { position: absolute; left: 760px; top: 90px; width: 340px; height: 380px; background: #fff; border: 2px solid #e5e3dc; border-radius: 28px; }
.ph { position: absolute; left: 40px; top: 40px; width: 96px; height: 96px; border-radius: 50%; background: #c8c5bb; }
.l1 { position: absolute; left: 40px; top: 164px; width: 200px; height: 22px; border-radius: 11px; background: #14140f; }
.l2 { position: absolute; left: 40px; top: 204px; width: 150px; height: 16px; border-radius: 8px; background: #c8c5bb; }
.btn { position: absolute; left: 40px; top: 260px; width: 260px; height: 56px; border-radius: 28px; background: #14b8a6; }
</style></head><body>
<div class="mark">voi<span class="dot">.</span>ci</div>
<div class="page"><div class="ph"></div><div class="l1"></div><div class="l2"></div><div class="btn"></div></div>
<div class="rule"></div>
</body></html>`;

/** Drops every APPn segment but APP0 (JFIF): Chrome writes an ICC profile in APP2, and the card carries no metadata. */
function stripAppSegments(b) {
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    const len = b.readUInt16BE(i + 2);
    const m = b[i + 1];
    if (!(m >= 0xe1 && m <= 0xef)) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const shot = await page.screenshot({ type: "jpeg", quality: 88 });
await browser.close();
const jpeg = stripAppSegments(shot);
writeFileSync(out, jpeg);
console.log(`wrote ${out} (${jpeg.length} bytes)`);
