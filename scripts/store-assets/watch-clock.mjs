#!/usr/bin/env node
// The Apple Watch simulator's clock can't be overridden (`simctl status_bar` is iOS-only) and runs on the Mac's
// time: this sets the clock in a watch capture to the store art's 9:41, drawn in the watch's own face (SF Compact,
// from this Mac's system fonts) at the place and height of the clock it replaces. Only the clock's pixels change.
//
//   node scripts/store-assets/watch-clock.mjs <capture.png> <text, e.g. 9:41> [--out other.png]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [file, text] = process.argv.slice(2);
const o = process.argv.indexOf("--out");
const out = o > 0 ? process.argv[o + 1] : file;
if (!file || !text) { console.error("usage: watch-clock.mjs <capture.png> <text> [--out file]"); process.exit(2); }
const FONT = "/System/Library/Fonts/SFCompact.ttf";
if (!fs.existsSync(FONT)) { console.error(`${FONT} is missing: this needs macOS's SF Compact`); process.exit(1); }

const b = await chromium.launch();
try {
  const page = await b.newPage();
  const png = fs.readFileSync(file).toString("base64");
  const font = fs.readFileSync(FONT).toString("base64");
  const result = await page.evaluate(async ({ png, font, text }) => {
    const face = new FontFace("WatchClock", `url(data:font/ttf;base64,${font})`, { weight: "100 900" });
    await face.load();
    document.fonts.add(face);
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    // the clock: the bright pixels in the top-right corner (black elsewhere around it)
    const x0 = Math.round(img.width * 0.5), y1 = Math.round(img.height * 0.17);
    const d = g.getImageData(x0, 0, img.width - x0, y1).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < y1; y++) for (let x = 0; x < img.width - x0; x++) {
      const i = (y * (img.width - x0) + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 3 * 140) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (maxX < 0) return { error: "no clock found in the top-right corner" };
    minX += x0; maxX += x0;
    const digitH = maxY - minY + 1;
    // SF Compact's digits stand 0.705 em tall
    const size = digitH / 0.705;
    g.fillStyle = "#000";
    g.fillRect(minX - 4, minY - 4, maxX - minX + 9, digitH + 8);
    // what is left of the old clock to the left (a wider old time) is covered too
    g.font = `500 ${size}px WatchClock`;
    g.fontKerning = "normal";
    const w = g.measureText(text).width;
    g.fillRect(Math.min(minX, maxX - w) - 6, minY - 4, maxX - Math.min(minX, maxX - w) + 11, digitH + 8);
    g.fillStyle = "#fff";
    g.textAlign = "right";
    g.textBaseline = "alphabetic";
    g.fillText(text, maxX + 1, maxY + 1);
    const blob = await c.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { png: btoa(s), box: [minX, minY, maxX, maxY] };
  }, { png, font, text });
  if (result.error) { console.error(`${file}: ${result.error}`); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(result.png, "base64"));
} finally {
  await b.close();
}
