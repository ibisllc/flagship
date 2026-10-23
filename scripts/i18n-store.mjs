#!/usr/bin/env node
// i18n-store — the captions on the App Store and Google Play art (docs/store-assets/store-assets-brief.md §6).
//
//   node scripts/i18n-store.mjs build    render every store image (= scripts/store-assets/render.mjs)
//   node scripts/i18n-store.mjs check    the gate (`npm run i18n`): lint, ga completeness, stale English, the CJK
//                                        fonts cover every caption, every caption fits its box at every store size
//                                        (laid out in headless Chromium), and, when store/out exists, the
//                                        rendered set is complete, exact-size and matches its manifest
//   node scripts/i18n-store.mjs dump | merge | midx | status | lint | accept <key>|--all
//
// i18n/store is keyed by name (slide1_caption …), so a changed English sentence keeps its old translations until
// they are translated again and `accept`ed; `check` lists them. Captions in ja / zh-Hans may carry "\n" where the
// line should break. The art itself is never committed (store/out is ignored); it is rebuilt from captures.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, locales, readEn, readTr, runCommon, lintSurface } from "./lib/i18n-kv.mjs";

const SURFACE = "store";
const args = process.argv.slice(2);
const cmd = args[0];
const RENDER = path.join(ROOT, "scripts/store-assets/render.mjs");

function textProblems() {
  const problems = [...lintSurface(SURFACE)];
  const en = readEn(SURFACE);
  for (const l of locales.locales.filter((x) => x.status === "ga" && x.code !== locales.source)) {
    const tr = readTr(SURFACE, l.code);
    const missing = Object.keys(en).filter((k) => en[k].translatable !== false && tr[k] == null);
    if (missing.length) problems.push(`${SURFACE}/${l.code} is ga but lacks ${missing.length} captions (first: ${missing[0]})`);
    for (const [k, t] of Object.entries(tr)) {
      if (typeof t !== "string") continue;
      if (/[。．]\s*$/.test(t)) problems.push(`${l.code}: ${k}: store headlines end without 。 (brief §6): ${t}`);
      if (/[!！]/.test(t)) problems.push(`${l.code}: ${k}: no exclamation marks in store art (brief §2): ${t}`);
    }
  }
  for (const [k, v] of Object.entries(en)) if (/!/.test(v.en)) problems.push(`en: ${k}: no exclamation marks in store art (brief §2)`);
  // the vendored CJK fonts are cut to the captions: a new character needs a new cut
  const cov = JSON.parse(fs.readFileSync(path.join(ROOT, "store/fonts/cjk-coverage.json"), "utf8"));
  for (const [lang, c] of Object.entries(cov)) {
    const have = new Set([...c.chars]);
    const need = Object.values(readTr(SURFACE, lang)).filter((t) => typeof t === "string").join("");
    const lacking = [...new Set([...need].filter((ch) => ch.codePointAt(0) > 0x7f && !/\s/.test(ch) && !have.has(ch)))];
    if (lacking.length) problems.push(`store/fonts/${c.file} has no glyph for ${lacking.join("")} (${lang}): run python3 scripts/store-assets/subset-cjk.py`);
  }
  return problems;
}

if (cmd === "build") {
  const r = spawnSync("node", [RENDER, "render", ...args.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
} else if (cmd === "check") {
  const problems = textProblems();
  if (!problems.length) {
    const fit = spawnSync("node", [RENDER, "fit"], { encoding: "utf8" });
    if (fit.status !== 0) problems.push(...(fit.stderr || fit.stdout).trim().split("\n"));
  }
  if (fs.existsSync(path.join(ROOT, "store/out/manifest.json"))) {
    const { checkOutputs } = await import("./store-assets/render.mjs");
    // new captures are the renderer's business (`npm run store-assets` reports them); captions are this gate's
    problems.push(...checkOutputs().problems.filter((p) => !/its capture changed/.test(p)));
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-store: ok");
} else if (!runCommon(SURFACE, args)) {
  console.error("usage: i18n-store.mjs build | check | dump | merge | status | lint | accept <key>|--all");
  process.exit(2);
}
