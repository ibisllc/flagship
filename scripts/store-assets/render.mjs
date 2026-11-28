#!/usr/bin/env node
// Store art: App Store and Google Play screenshots, the feature graphic and the icon, in every ga language.
// docs/store-assets/README.md is the how-to; docs/store-assets/store-assets-brief.md the design.
//
//   node scripts/store-assets/render.mjs [render] [--lang ja,de] [--class iphone-6.9] [--no-stand-in]
//        captures + templates + i18n/store -> store/out/<store>/<lang>/<class>/<id>-<theme>.png,
//        store/out/manifest.json and the contact sheets store/out/review/<lang>.html
//   node scripts/store-assets/render.mjs check [--release]
//        every language x class x slide exists at its exact size, matches its manifest hash and its caption fit;
//        lists the missing captures. --release also fails on any missing capture or webapp stand-in.
//   node scripts/store-assets/render.mjs fit
//        lays out every caption in every size without writing images (part of `npm run i18n`).
//
// Captures come from store/captures/<platform>/<lang>/<device>/<id>.png (native capture tests, see
// docs/store-assets/capture-plan.md). Where one is missing, a webapp capture of the same screen
// (store/captures/webapp/<lang>/<phone|tablet>/<id>.png, scripts/store-assets/capture-webapp.spec.ts) stands in,
// marked on the image and in the manifest; with neither, the screen is a red "CAPTURE MISSING" frame naming the
// file and the gym state that should produce it. So the pipeline always runs end to end.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, locales, readEn, readTr } from "../lib/i18n-kv.mjs";

const STORE = path.join(ROOT, "store");
const OUT = path.join(STORE, "out");
const CAPTURES = path.join(STORE, "captures");
const TEMPLATES = path.join(STORE, "templates");
const ICON = path.join(ROOT, "apps/mobile/ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
const config = JSON.parse(fs.readFileSync(path.join(STORE, "store.json"), "utf8"));
const SLIDES = Object.fromEntries(config.slides.map((s) => [s.id, s]));

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "render";
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);

export const shipped = () => locales.locales.filter((l) => l.status === "ga");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Width and height from a PNG's IHDR. */
export function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  if (b.toString("latin1", 1, 4) !== "PNG") throw new Error(`${rel(file)} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** The caption strings of one language, English where a translation is missing (the check reports those). */
export function strings(lang) {
  const en = readEn("store");
  const tr = lang === locales.source ? {} : readTr("store", lang);
  return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, tr[k] ?? v.en]));
}

const storeLang = (loc, store) => (store === "appstore" ? loc.appStoreId : loc.playStoreId) ?? loc.code;

/** Every image the stores need for one language, with what draws it. */
export function plan(lang) {
  const loc = locales.locales.find((l) => l.code === lang);
  const s = strings(lang);
  const jobs = [];
  for (const cls of config.classes) {
    if (cls.neutral && lang !== locales.source) continue;
    cls.slides.forEach((id, i) => {
      const slide = SLIDES[id];
      const tone = cls.template === "feature" ? "dark" : i % 2 ? "dark" : "light";
      const isWatch = !!slide.watch;
      const template = slide.closing ? "closing" : cls.template;
      const capFrom = isWatch ? (cls.watchCaptures ?? cls.captures) : cls.captures;
      const device = isWatch ? (capFrom?.platform === "ios" ? "apple-watch" : "wear-os") : cls.device;
      const file = cls.neutral
        ? path.join(OUT, cls.store, `${cls.class}.png`)
        : path.join(OUT, cls.store, lang, cls.class, id === slide.theme ? `${id}.png` : `${id}-${slide.theme}.png`);
      const needsCapture = !["closing", "feature", "icon"].includes(template);
      // the feature graphic crops a phone capture (slide.phone); slide 01 draws a second capture over its device
      const capture = needsCapture ? findCapture(lang, capFrom, id, isWatch ? null : cls.standIn)
        : template === "feature" && slide.phone ? findCapture(lang, slide.phone, slide.phone.id, null) : null;
      const inset = slide.inset && needsCapture && !isWatch ? findCapture(lang, slide.inset, id, null) : null;
      jobs.push({
        lang, store: cls.store, storeLang: cls.neutral ? null : storeLang(loc, cls.store), cls: cls.class, id, theme: slide.theme, template, tone, device,
        w: cls.w, h: cls.h, file, isWatch, first: i === 0 && id === "01", deviceW: cls.deviceW, fit: cls.fit?.[id] ?? slide.fit, lines: slide.lines,
        sub: template === "feature" && slide.strings ? s[`${slide.strings}_sub`] ?? null : null,
        eyebrow: slide.strings && !slide.closing && template !== "feature" && template !== "watch" ? { num: id, theme: s[`${slide.strings}_theme`] } : null,
        caption: template === "watch" || !slide.strings ? null : s[slide.caption ?? `${slide.strings}_caption`],
        capture, inset,
        state: slide.state, screen: slide.screen,
      });
    });
  }
  return jobs;
}

function findCapture(lang, from, id, standIn) {
  const native = path.join(CAPTURES, from.platform, lang, from.device, `${id}.png`);
  const nominal = config.captureSize[`${from.platform}/${from.device}`];
  if (fs.existsSync(native)) return { kind: "native", file: native, size: pngSize(native), nominal, wanted: native };
  const fallback = standIn && !flag("no-stand-in") ? path.join(CAPTURES, "webapp", lang, standIn, `${id}.png`) : null;
  if (fallback && fs.existsSync(fallback)) return { kind: "stand-in", file: fallback, size: pngSize(fallback), nominal, wanted: native };
  return { kind: "missing", file: null, size: nominal, nominal, wanted: native };
}

/** A capture for the page: its file URL and size, and what its sidecar JSON says (the voi.ci frame's tap point). */
function imageOf(c) {
  if (!c?.file) return null;
  const side = c.file.replace(/\.png$/, ".json");
  const extra = fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, "utf8")) : {};
  return { src: pathToFileURL(c.file).href, w: c.size[0], h: c.size[1], kind: c.kind, ...extra };
}

function specOf(job) {
  const c = job.capture;
  return {
    w: job.w, h: job.h, lang: job.lang, tone: job.tone, device: job.device, watch: job.isWatch, first: job.first,
    deviceW: job.deviceW, fit: job.fit, sub: job.sub,
    eyebrow: job.eyebrow, caption: job.caption,
    captionScale: job.template === "feature" ? 0.088 : 0.05, captionFloor: job.template === "feature" ? 0.065 : 0.045,
    maxLines: job.template === "closing" ? 3 : (job.lines ?? 2), // the closing card has no device under it
    splitSentences: (job.lines ?? 2) > 2,
    capture: imageOf(c),
    inset: job.inset ? { ...(imageOf(job.inset) ?? { missing: rel(job.inset.wanted) }), aspect: job.inset.size[0] / job.inset.size[1] } : null,
    captureAspect: c ? c.size[0] / c.size[1] : 1,
    missing: c && c.kind === "missing" ? { path: rel(c.wanted), state: job.state ? `world=${job.state}` : null, screen: job.screen } : null,
    foot: { left: "", standIn: c?.kind === "stand-in" },
    iconSrc: pathToFileURL(ICON).href,
  };
}

async function browser() {
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("playwright is not installed: npm install (the repo already depends on it), then npx playwright install chromium"); }
  return chromium.launch();
}

const headers = new Map();
/** Where the ringing screen's header (avatar, name, status, the encryption line) ends and its buttons start, as
 *  fractions of the capture, and how far right the header reaches: slide 01's browser frame is placed so it covers
 *  none of them (store review: "end-to-end encrypted · quantum-safe" was half hidden). Read from the pixels, so it
 *  follows each device's and language's own layout. */
async function headerOf(page, file) {
  if (!headers.has(file)) {
    const png = fs.readFileSync(file).toString("base64");
    headers.set(file, await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const { width: w, height: h } = img;
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      const at = (x, y) => (y * w + x) * 4;
      const bg = at(4, h >> 1); // the screen's edge, mid-height: never text (the centre can be the status line)
      const ink = (y) => {
        let left = -1, right = -1;
        for (let x = 0; x < w; x += 2) {
          const i = at(x, y);
          if (Math.abs(d[i] - d[bg]) + Math.abs(d[i + 1] - d[bg + 1]) + Math.abs(d[i + 2] - d[bg + 2]) > 36) { if (left < 0) left = x; right = x; }
        }
        return left < 0 ? null : [left, right];
      };
      // below the status bar: the header is the first block of ink, the buttons the next after a long empty run
      const gap = Math.round(h * 0.08);
      let y = Math.round(h * 0.07), top = -1, bottom = -1, right = 0, empty = 0;
      for (; y < h; y++) {
        const r = ink(y);
        if (r) {
          if (top < 0) top = y;
          else if (empty >= gap) break;
          bottom = y; right = Math.max(right, r[1]); empty = 0;
        } else if (top >= 0) empty++;
      }
      return y < h ? { bottom: bottom / h, buttons: y / h, right: right / w } : null; // no gap found: the default place
    }, png));
  }
  return headers.get(file);
}

/** Lay out (and with `shoot`, screenshot) every job; returns the per-job fit. */
async function run(jobs, { shoot }) {
  const b = await browser();
  const pages = new Map();
  const results = [];
  try {
    for (const job of jobs) {
      let page = pages.get(job.template);
      if (!page) {
        page = await b.newPage({ deviceScaleFactor: 1 });
        await page.goto(pathToFileURL(path.join(TEMPLATES, `${job.template}.html`)).href);
        pages.set(job.template, page);
      }
      await page.setViewportSize({ width: job.w, height: job.h });
      const spec = specOf(job);
      if (spec.inset && spec.capture) spec.capture.header = await headerOf(page, job.capture.file);
      const r = await page.evaluate((spec) => window.renderSlide(spec), spec);
      if (r.broken.length) throw new Error(`${rel(job.file)}: image failed to load: ${r.broken.join(", ")}`);
      if (r.fonts.length) throw new Error(`${rel(job.file)}: font failed to load: ${r.fonts.join(", ")}`);
      if (shoot) {
        fs.mkdirSync(path.dirname(job.file), { recursive: true });
        await page.screenshot({ path: job.file, clip: { x: 0, y: 0, width: job.w, height: job.h }, omitBackground: job.template === "icon" });
      }
      results.push({ job, fit: r.fit });
    }
  } finally {
    await b.close();
  }
  return results;
}

const overflowOf = (r) => (r.fit?.overflow ? `${r.job.lang} ${r.job.store}/${r.job.cls} ${r.job.id}: caption needs ${r.fit.lines} lines${r.fit.overflowX ? " and a word is wider than the box" : ""} even at the smallest size: shorten "${r.fit.text.replace(/\n/g, "\\n")}" in i18n/store/${r.job.lang}.json` : null);

// ---- render ----------------------------------------------------------------------------------------------------

async function render() {
  const langs = opt("lang")?.split(",") ?? shipped().map((l) => l.code);
  const only = opt("class")?.split(",");
  const jobs = langs.flatMap(plan).filter((j) => !only || only.includes(j.cls));
  const t0 = Date.now();
  const results = await run(jobs, { shoot: true });
  const manifestFile = path.join(OUT, "manifest.json");
  const old = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")).files : [];
  const fresh = results.map(({ job, fit }) => {
    const [w, h] = pngSize(job.file);
    return {
      path: rel(job.file), store: job.store, storeLanguage: job.storeLang, lang: job.lang, class: job.cls, slide: job.id, theme: job.theme,
      tone: job.tone, width: w, height: h, sha256: sha256(fs.readFileSync(job.file)),
      caption: job.caption, captionLines: fit.lines ?? 0, captionScale: fit.scale ?? null, captionOverflow: !!fit.overflow,
      capture: captureRecord(job.capture),
      ...(job.inset ? { inset: captureRecord(job.inset) } : {}),
    };
  });
  const byPath = new Map(old.map((f) => [f.path, f]));
  for (const f of fresh) byPath.set(f.path, f);
  const files = [...byPath.values()].filter((f) => fs.existsSync(path.join(ROOT, f.path))).sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(manifestFile, JSON.stringify({ about: "Written by scripts/store-assets/render.mjs; checked by `render.mjs check`.", files }, null, 1) + "\n");
  for (const lang of new Set(files.map((f) => f.lang))) writeReview(lang, files);
  writeReviewIndex(files);
  const problems = results.map(overflowOf).filter(Boolean);
  const counts = fresh.reduce((a, f) => ((a[f.capture?.kind ?? "none"] = (a[f.capture?.kind ?? "none"] ?? 0) + 1), a), {});
  console.log(`rendered ${fresh.length} images in ${((Date.now() - t0) / 1000).toFixed(1)} s (captures: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")})`);
  console.log(`review: ${rel(path.join(OUT, "review/index.html"))}`);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}

function captureRecord(c) {
  return c ? { kind: c.kind, path: c.file ? rel(c.file) : null, wanted: rel(c.wanted), sha256: c.file ? sha256(fs.readFileSync(c.file)) : null } : null;
}

// ---- review sheets ---------------------------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function writeReview(lang, files) {
  const mine = files.filter((f) => f.lang === lang || (f.storeLanguage === null && lang === locales.source));
  const en = strings(locales.source);
  const s = strings(lang);
  const loc = locales.locales.find((l) => l.code === lang);
  const groups = [];
  for (const cls of config.classes) {
    const shots = mine.filter((f) => f.class === cls.class && f.store === cls.store);
    if (!shots.length) continue;
    groups.push(`<section><h2>${esc(cls.store === "appstore" ? "App Store" : "Google Play")} · ${esc(cls.class)} <small>${cls.w} × ${cls.h}</small></h2>
<div class="row" style="--ar:${cls.w / cls.h}">${shots.map((f) => {
      const href = path.relative(path.join(OUT, "review"), path.join(ROOT, f.path)).split(path.sep).join("/");
      const tag = f.capture?.kind === "missing" ? `<em class="bad" title="capture missing">missing</em>` : f.capture?.kind === "stand-in" ? `<em class="warn" title="webapp stand-in: not for upload">stand-in</em>` : f.capture ? `<em class="ok" title="native capture">native</em>` : "";
      return `<figure><a href="${esc(href)}"><img loading="lazy" src="${esc(href)}" alt="${esc(f.caption ?? f.slide)}"></a><figcaption><b>${esc(f.slide)}</b> ${tag}${f.captionOverflow ? `<em class="bad">overflow</em>` : ""}${f.captionScale && f.captionScale < 1 ? ` <i title="caption size after fitting">${Math.round(f.captionScale * 100)} %</i>` : ""}</figcaption></figure>`;
    }).join("")}</div></section>`);
  }
  const keys = Object.keys(en).filter((k) => /_caption$/.test(k));
  const table = `<table><tr><th>key</th><th>English</th><th>${esc(loc?.native ?? lang)}</th></tr>${keys.map((k) => `<tr><td><code>${k}</code></td><td>${esc(en[k])}</td><td lang="${lang}">${esc(s[k]).replace(/\n/g, "<span class=br>↵</span><br>")}</td></tr>`).join("")}</table>`;
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>Store art review: ${esc(loc?.name ?? lang)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@font-face { font-family: Geist; font-weight: 100 900; src: url("../../fonts/Geist-Variable.woff2"); }
@font-face { font-family: "Geist Mono"; font-weight: 100 900; src: url("../../fonts/GeistMono-Variable.woff2"); }
:root { --bg:#F7F6F2; --ink:#14140F; --muted:#555149; --rule:#E5E3DC; --teal:#14B8A6; color-scheme: light; }
body { margin:0; padding:32px 24px 64px; background:var(--bg); color:var(--ink); font:15px/1.5 Geist, system-ui, sans-serif; }
h1 { font-weight:500; letter-spacing:-0.02em; margin:0 0 4px; } p { color:var(--muted); margin:0 0 24px; max-width:70ch; }
nav a { font:500 12px "Geist Mono", monospace; letter-spacing:.1em; text-transform:uppercase; color:var(--ink); margin-right:16px; }
h2 { font:500 12px "Geist Mono", monospace; letter-spacing:.12em; text-transform:uppercase; border-top:1px solid var(--rule); padding-top:16px; margin:32px 0 12px; }
h2 small { color:var(--muted); letter-spacing:.04em; }
.row { display:flex; gap:12px; overflow-x:auto; padding-bottom:8px; }
figure { margin:0; flex:none; width:calc(var(--thumb, 300px) * var(--ar)); }
figure img { display:block; height:var(--thumb, 300px); width:100%; border:1px solid var(--rule); box-sizing:border-box; }
figcaption { font:12px "Geist Mono", monospace; margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:baseline; }
em { font-style:normal; padding:0 4px; border-radius:2px; white-space:nowrap; font-size:11px; } .bad { background:#B91C1C; color:#fff; } .warn { background:#944D05; color:#fff; } .ok { background:#166534; color:#fff; } i { color:var(--muted); font-style:normal; }
.controls { margin:0 0 8px; font:12px "Geist Mono", monospace; } .controls button { font:inherit; margin-right:6px; background:none; border:1px solid #C8C5BB; padding:4px 8px; border-radius:4px; cursor:pointer; }
table { border-collapse:collapse; margin-top:32px; } td, th { border-top:1px solid var(--rule); padding:8px 12px 8px 0; text-align:left; vertical-align:top; } th { font:500 11px "Geist Mono", monospace; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.br { color:var(--teal); }
</style></head><body>
<nav>${shipped().map((l) => `<a href="${l.code}.html">${esc(l.code)}</a>`).join("")}<a href="index.html">all</a></nav>
<h1>Store art, ${esc(loc?.name ?? lang)}</h1>
<p>Regenerate with <code>npm run store-assets</code>. The first three slides of each row are what a store search shows; "search" sets the thumbnails to about the size the App Store uses there. Click a slide for full size. Captions are machine drafts until a native reviewer signs them off (i18n/REVIEW.md).</p>
<div class="controls">thumbnail: <button data-h="110px">search</button><button data-h="300px">sheet</button><button data-h="640px">large</button></div>
${groups.join("\n")}
${table}
<script>for (const b of document.querySelectorAll("[data-h]")) b.onclick = () => document.body.style.setProperty("--thumb", b.dataset.h);</script>
</body></html>
`;
  fs.mkdirSync(path.join(OUT, "review"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "review", `${lang}.html`), html);
}

function writeReviewIndex(files) {
  const rows = shipped().map((l) => {
    const mine = files.filter((f) => f.lang === l.code);
    const k = (kind) => mine.filter((f) => f.capture?.kind === kind).length;
    return `<tr><td><a href="${l.code}.html">${esc(l.native)}</a></td><td>${mine.length}</td><td>${k("native")}</td><td>${k("stand-in")}</td><td>${k("missing")}</td><td>${mine.filter((f) => f.captionOverflow).length}</td></tr>`;
  });
  fs.writeFileSync(path.join(OUT, "review", "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Store art review</title>
<style>body{margin:32px 24px;background:#F7F6F2;color:#14140F;font:15px/1.5 system-ui,sans-serif}td,th{padding:6px 16px 6px 0;text-align:left;border-top:1px solid #E5E3DC}a{color:#0F766E}</style></head><body>
<h1>Store art review</h1><table><tr><th>language</th><th>images</th><th>native captures</th><th>webapp stand-ins</th><th>missing captures</th><th>caption overflows</th></tr>${rows.join("")}</table></body></html>
`);
}

// ---- check -----------------------------------------------------------------------------------------------------

/** Problems with the rendered set (empty: complete, exact sizes, hashes match, nothing stale). */
export function checkOutputs({ release = false } = {}) {
  const problems = [];
  const notes = [];
  const manifestFile = path.join(OUT, "manifest.json");
  if (!fs.existsSync(manifestFile)) return { problems: [`${rel(manifestFile)} is missing: run npm run store-assets`], notes };
  const files = new Map(JSON.parse(fs.readFileSync(manifestFile, "utf8")).files.map((f) => [f.path, f]));
  const missingCaptures = new Set();
  const standIns = new Set();
  for (const l of shipped()) {
    for (const job of plan(l.code)) {
      const p = rel(job.file);
      const f = files.get(p);
      if (!f) { problems.push(`${p}: not rendered`); continue; }
      if (!fs.existsSync(job.file)) { problems.push(`${p}: in the manifest but not on disk`); continue; }
      const [w, h] = pngSize(job.file);
      if (w !== job.w || h !== job.h) problems.push(`${p}: ${w} x ${h}, the store wants ${job.w} x ${job.h}`);
      if (f.width !== w || f.height !== h) problems.push(`${p}: manifest says ${f.width} x ${f.height}`);
      if (sha256(fs.readFileSync(job.file)) !== f.sha256) problems.push(`${p}: hash differs from the manifest (edited by hand?)`);
      if ((f.caption ?? null) !== (job.caption ?? null)) problems.push(`${p}: caption changed since it was rendered: run npm run store-assets`);
      if (f.captionOverflow) problems.push(`${p}: caption overflows its box`);
      const ins = job.inset;
      if (ins) {
        if (ins.kind !== f.inset?.kind || (ins.file && sha256(fs.readFileSync(ins.file)) !== f.inset.sha256)) problems.push(`${p}: its capture changed since it was rendered: run npm run store-assets`);
        if (ins.kind !== "native") missingCaptures.add(rel(ins.wanted));
      }
      const c = job.capture;
      if (c) {
        const was = f.capture?.kind;
        if (c.kind !== was || (c.file && sha256(fs.readFileSync(c.file)) !== f.capture.sha256)) problems.push(`${p}: its capture changed since it was rendered: run npm run store-assets`);
        if (c.kind !== "native") missingCaptures.add(rel(c.wanted));
        if (c.kind === "stand-in") standIns.add(p);
        if (c.kind === "native" && c.nominal && (c.size[0] !== c.nominal[0] || c.size[1] !== c.nominal[1])) notes.push(`${rel(c.file)} is ${c.size.join(" x ")}, expected ${c.nominal.join(" x ")} (scaled to fit)`);
      }
    }
  }
  if (missingCaptures.size) {
    // one line per capture folder: "store/captures/ios/ja/iphone-6.9/ 01 02 03 04 05"
    const byDir = new Map();
    for (const f of [...missingCaptures].sort()) {
      const dir = f.slice(0, f.lastIndexOf("/") + 1);
      byDir.set(dir, [...(byDir.get(dir) ?? []), path.basename(f, ".png")]);
    }
    const lines = [...byDir].map(([dir, ids]) => `${dir} ${ids.join(" ")}`);
    (release ? problems : notes).push(`${missingCaptures.size} native captures missing in ${byDir.size} folders (docs/store-assets/capture-plan.md):\n  ${lines.join("\n  ")}`);
  }
  if (standIns.size) (release ? problems : notes).push(`${standIns.size} images use a webapp stand-in and must not be uploaded`);
  return { problems, notes };
}

async function fit() {
  const jobs = shipped().flatMap((l) => plan(l.code)).filter((j) => j.caption);
  const results = await run(jobs, { shoot: false });
  return results.map(overflowOf).filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === "render") await render();
  else if (cmd === "check") {
    const { problems, notes } = checkOutputs({ release: flag("release") });
    if (notes.length) console.log(notes.join("\n"));
    if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
    console.log("store art: ok");
  } else if (cmd === "fit") {
    const p = await fit();
    if (p.length) { console.error(p.join("\n")); process.exit(1); }
    console.log("store captions: every caption fits");
  } else {
    console.error("usage: render.mjs [render] [--lang ..] [--class ..] [--no-stand-in] | check [--release] | fit");
    process.exit(2);
  }
}
