#!/usr/bin/env node
// The rendered store art as one folder per store / device / language, zipped, for an upload from another machine
// (the browser session uploads by hand; nothing here talks to a store). Refuses anything a store must never get:
// a webapp stand-in, a missing capture, an image the render check rejects. Adds a contact sheet per language.
//
//   node scripts/store-assets/upload-pack.mjs <out-dir>
//        <out-dir>/flagship-store-art-<version>/appstore/<class>/<App Store locale>/<slide>.png
//                                              playstore/<class>/<Play locale>/<slide>.png, playstore/icon.png
//                                              contact-sheets/<lang>.png
//        and <out-dir>/flagship-store-art-<version>.zip
//
// Run `npm run store-assets:render` and `npm run store-assets:release-check` first (this script runs the check too).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = process.argv[2];
if (!out) { console.error("usage: upload-pack.mjs <out-dir>"); process.exit(2); }

execFileSync("node", [path.join(ROOT, "scripts/store-assets/render.mjs"), "check", "--release"], { stdio: "inherit" });

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "store/store.json"), "utf8"));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "release/version.json"), "utf8")).product ?? "release";
const { files } = JSON.parse(fs.readFileSync(path.join(ROOT, "store/out/manifest.json"), "utf8"));
const wanted = new Set(config.classes.flatMap((c) => c.slides.map((s) => `${c.store}/${c.class}/${s}`)));
const name = `flagship-store-art-${version}`;
const dir = path.join(path.resolve(out), name);
if (fs.existsSync(dir)) { console.error(`${dir} exists: pick another <out-dir> or move it away`); process.exit(1); }

let n = 0;
for (const f of files) {
  if (!wanted.has(`${f.store}/${f.class}/${f.slide}`)) continue; // an image an older slide order left behind
  if (f.capture && f.capture.kind !== "native") throw new Error(`${f.path}: capture is ${f.capture.kind}, never uploaded`);
  const to = f.slide === "icon"
    ? path.join(dir, f.store, "icon.png")
    : path.join(dir, f.store, f.class, f.storeLanguage, `${f.slide}.png`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f.path), to);
  n++;
}

const { chromium } = await import("playwright");
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1800, height: 1000 } });
fs.mkdirSync(path.join(dir, "contact-sheets"), { recursive: true });
for (const lang of new Set(files.map((f) => f.lang))) {
  const review = path.join(ROOT, "store/out/review", `${lang}.html`);
  if (!fs.existsSync(review)) continue;
  await page.goto(pathToFileURL(review).href);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: ".row { flex-wrap: wrap; overflow: visible; }" }); // every slide on the sheet, no sideways scroll
  await page.screenshot({ path: path.join(dir, "contact-sheets", `${lang}.png`), fullPage: true });
}
await b.close();

execFileSync("zip", ["-qr", `${name}.zip`, name], { cwd: path.resolve(out) });
console.log(`${n} images in ${dir}\nzip: ${path.join(path.resolve(out), `${name}.zip`)}`);
