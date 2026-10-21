#!/usr/bin/env node
// i18n-check — every localisation check in one command (also `npm run i18n`).
//
//   node scripts/i18n-check.mjs            run the drift / placeholder / glossary / ga-completeness checks of every surface
//   node scripts/i18n-check.mjs status     translated-string coverage per surface and language
//
// A language marked "ga" in i18n/locales.json must be complete on every surface it ships on; "draft" languages
// may be partial (their strings are generated but not packaged or served).
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ROOT, locales, targets, readEn, readTr } from "./lib/i18n-kv.mjs";

const run = (script, ...a) => spawnSync("node", [path.join(ROOT, "scripts", script), ...a], { encoding: "utf8" });
const CHECKS = [
  ["web", "i18n-web.mjs", ["check"]],
  ["webapp (PWA)", "i18n-pwa.mjs", ["check"]],
  ["android + wear", "i18n-android.mjs", ["check"]],
  ["ios + watch", "i18n-ios.mjs", ["check"]],
  ["studio-linux", "i18n-linux.mjs", ["check"]],
  ["studio-windows", "i18n-windows.mjs", ["check"]],
  ["server", "i18n-server.mjs", ["check"]],
  ["box pages", "i18n-box.mjs", ["check"]],
];

if (process.argv[2] === "status") {
  const surfaces = fs.readdirSync(path.join(ROOT, "i18n"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "web").map((d) => d.name);
  const rows = [["surface", "strings", ...targets.map((l) => l.code)]];
  for (const s of surfaces) {
    const en = Object.entries(readEn(s)).filter(([, v]) => v.translatable !== false);
    if (!en.length) continue;
    rows.push([s, String(en.length), ...targets.map((l) => { const tr = readTr(s, l.code); return `${Math.round((100 * en.filter(([k]) => tr[k] != null).length) / en.length)}%`; })]);
  }
  const segs = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/web/segments.json"), "utf8"));
  const n = Object.keys(segs).length;
  rows.push(["web", String(n), ...targets.map((l) => { const f = path.join(ROOT, `i18n/web/${l.code}.json`); const tr = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; return `${Math.round((100 * Object.keys(segs).filter((k) => tr[k]).length) / n)}%`; })]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  "));
  process.exit(0);
}

let failed = 0;
for (const [name, script, a] of CHECKS) {
  const r = run(script, ...a);
  const out = (r.stdout + r.stderr).trim().split("\n").slice(-3).join("\n");
  if (r.status === 0) console.log(`ok    ${name}`);
  else { failed++; console.log(`FAIL  ${name}\n${(r.stdout + r.stderr).trim().split("\n").slice(0, 12).map((l) => "      " + l).join("\n")}`); }
}
process.exit(failed ? 1 : 0);
