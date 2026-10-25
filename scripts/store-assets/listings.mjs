#!/usr/bin/env node
// Store listing texts: App Store and Google Play metadata in every ga language (store/listings/<lang>.json).
// docs/store-assets/README.md "Store listing texts" is the how-to.
//
//   node scripts/store-assets/listings.mjs check     every ga language has a listing, every field is present and
//                                                    within its store's limit, keywords are clean, keep-terms kept
//   node scripts/store-assets/listings.mjs counts    the same check, plus a table of every field's length
//
// Lengths are counted in Unicode code points, the way App Store Connect and the Play Console count characters.
// Check the limits against the stores' own pages before a release; they are listed once, here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, "store/listings");
const locales = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/locales.json"), "utf8"));

export const LIMITS = {
  appstore: { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 },
  playstore: { title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500 },
};
const KEEP = ["Flagship"];
const len = (s) => [...s].length;

export function checkListings() {
  const problems = [];
  const rows = [];
  for (const loc of locales.locales.filter((l) => l.status === "ga")) {
    const file = path.join(DIR, `${loc.code}.json`);
    if (!fs.existsSync(file)) { problems.push(`${loc.code}: store/listings/${loc.code}.json is missing`); continue; }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { problems.push(`${loc.code}: ${e.message}`); continue; }
    if (doc.lang !== loc.code) problems.push(`${loc.code}: "lang" is ${JSON.stringify(doc.lang)}`);
    if (loc.code !== locales.source && doc.review !== "machine draft: needs native review" && !/^reviewed by /.test(doc.review ?? ""))
      problems.push(`${loc.code}: "review" must say "machine draft: needs native review" until a native reviewer signs it ("reviewed by <name>, <date>")`);
    for (const [store, fields] of Object.entries(LIMITS)) {
      for (const [field, max] of Object.entries(fields)) {
        const v = doc[store]?.[field];
        if (typeof v !== "string" || !v.trim()) { problems.push(`${loc.code}: ${store}.${field} is missing`); continue; }
        const n = len(v);
        rows.push({ lang: loc.code, field: `${store}.${field}`, n, max });
        if (n > max) problems.push(`${loc.code}: ${store}.${field} is ${n} characters (limit ${max})`);
        if (v !== v.trim()) problems.push(`${loc.code}: ${store}.${field} has leading or trailing space`);
        if (/[!！]/.test(v)) problems.push(`${loc.code}: ${store}.${field}: no exclamation marks (brief §2)`);
        if (/<[a-z/][^>]*>/i.test(v)) problems.push(`${loc.code}: ${store}.${field}: the stores take plain text, not HTML`);
      }
      for (const field of Object.keys(doc[store] ?? {}))
        if (!(field in fields)) problems.push(`${loc.code}: ${store}.${field} is not a field the pipeline knows`);
    }
    const kw = doc.appstore?.keywords;
    if (typeof kw === "string") {
      const words = kw.split(",");
      if (words.some((w) => w !== w.trim())) problems.push(`${loc.code}: appstore.keywords: no spaces around commas (they count against the 100)`);
      if (words.some((w) => !w)) problems.push(`${loc.code}: appstore.keywords: empty keyword`);
      const seen = new Set();
      for (const w of words.map((x) => x.trim().toLowerCase())) { if (seen.has(w)) problems.push(`${loc.code}: appstore.keywords repeats "${w}"`); seen.add(w); }
      if (/flagship/i.test(kw)) problems.push(`${loc.code}: appstore.keywords: the app name is already indexed, don't spend keywords on it`);
    }
    for (const term of KEEP)
      for (const field of ["appstore.description", "playstore.fullDescription"]) {
        const [s, f] = field.split(".");
        if (typeof doc[s]?.[f] === "string" && !doc[s][f].includes(term)) problems.push(`${loc.code}: ${field} drops keep-term "${term}"`);
      }
  }
  for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (!f.endsWith(".json")) continue;
    const code = f.slice(0, -5);
    if (!locales.locales.some((l) => l.code === code)) problems.push(`store/listings/${f}: not a language in i18n/locales.json`);
  }
  return { problems, rows };
}

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd !== "check" && cmd !== "counts") { console.error("usage: listings.mjs check | counts"); process.exit(2); }
  const { problems, rows } = checkListings();
  if (cmd === "counts") {
    const fields = [...new Set(rows.map((r) => r.field))];
    const langs = [...new Set(rows.map((r) => r.lang))];
    console.log(["field".padEnd(28), "limit".padStart(5), ...langs.map((l) => l.padStart(7))].join(" "));
    for (const f of fields) {
      const max = rows.find((r) => r.field === f).max;
      console.log([f.padEnd(28), String(max).padStart(5), ...langs.map((l) => String(rows.find((r) => r.lang === l && r.field === f)?.n ?? "-").padStart(7))].join(" "));
    }
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("store listings: ok");
}
