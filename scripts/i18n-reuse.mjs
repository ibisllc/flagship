#!/usr/bin/env node
// i18n-reuse — the same English sentence is translated once.
//
//   node scripts/i18n-reuse.mjs <target-surface> [--from a,b,c] [--dry]
//
// The apps and Studios share most of their copy ("Try again", the pairing and backup sentences). For every string of
// <target-surface> that has no translation yet, look for a surface whose English is the same once placeholders are
// ignored (%1$s, %@, %lld, {0}, <1> all count as "argument n"), and copy that translation with the placeholders
// rewritten in the target's style and order. Nothing is overwritten; `lint` still checks the result.
import { ROOT, targets, readEn, readTr, writeTr } from "./lib/i18n-kv.mjs";

const args = process.argv.slice(2);
const target = args[0];
const from = (args.includes("--from") ? args[args.indexOf("--from") + 1].split(",") : ["ios", "android", "studio-mac", "studio-windows", "studio-linux", "wear", "watch", "ios-widgets", "watch-widgets"]).filter((s) => s !== target);
const dry = args.includes("--dry");

const TOKEN = /%(?:(\d+)\$)?(?:l{1,2}|h{1,2})?[sdfgiuxXeEc@]|\{(\d+)\}/g;
const norm = (s) => { let n = 0; return s.replace(TOKEN, () => `⟦${n++}⟧`); };
const key = (s) => norm(s).replace(/\s+/g, " ").trim();
const tokensOf = (s) => [...s.matchAll(TOKEN)].map((m) => ({ text: m[0], index: m[1] ? Number(m[1]) - 1 : m[2] !== undefined ? Number(m[2]) : null }));

/** donorEn/donorTr in the donor's token style -> text in the target's token style. */
function convert(donorEn, donorTr, targetEn) {
  const dEn = tokensOf(donorEn), tEn = tokensOf(targetEn);
  if (dEn.length !== tEn.length) return null;
  // position (order of appearance) in the donor English of each argument index
  const order = dEn.map((t, i) => (t.index ?? i));
  let out = donorTr;
  const dTr = tokensOf(donorTr);
  if (dTr.length !== dEn.length) return null;
  const used = [];
  let i = 0;
  out = donorTr.replace(TOKEN, (m, p1, p2) => {
    const idx = p1 ? Number(p1) - 1 : p2 !== undefined ? Number(p2) : i; // which argument this token refers to (0-based)
    i++;
    const pos = order.indexOf(idx);
    if (pos < 0 || !tEn[pos]) { used.push(null); return m; }
    used.push(pos);
    // the target token for the same argument; positional style needs an explicit index when the order changed
    const style = tEn[pos].text;
    if (/%\d+\$/.test(style)) return style.replace(/%\d+\$/, `%${pos + 1}$`);
    if (/^\{\d+\}$/.test(style)) return `{${pos}}`;
    return style;
  });
  if (used.includes(null)) return null;
  // `%@`/`%lld` are order-bound: only reusable when the donor kept the argument order
  const bare = tEn.every((t) => !/%\d+\$|^\{/.test(t.text));
  if (bare && used.some((u, k) => u !== k)) return null;
  return out;
}

const tEn = readEn(target);
const index = new Map();
for (const s of from) {
  const en = readEn(s);
  const trs = Object.fromEntries(targets.map((l) => [l.code, readTr(s, l.code)]));
  for (const [k, v] of Object.entries(en)) {
    if (typeof v.en !== "string" || v.translatable === false) continue;
    const kk = key(v.en);
    const e = index.get(kk) ?? { donors: [] };
    e.donors.push({ surface: s, key: k, en: v.en, trs });
    index.set(kk, e);
  }
}
let total = 0;
for (const l of targets) {
  const tr = readTr(target, l.code);
  let n = 0;
  for (const [k, v] of Object.entries(tEn)) {
    if (tr[k] != null || typeof v.en !== "string" || v.translatable === false) continue;
    const hit = index.get(key(v.en));
    if (!hit) continue;
    for (const d of hit.donors) {
      const t = d.trs[l.code][d.key];
      if (typeof t !== "string") continue;
      const c = convert(d.en, t, v.en);
      if (c) { tr[k] = c; n++; break; }
    }
  }
  if (n && !dry) writeTr(target, l.code, tr, Object.keys(tEn));
  total += n;
  console.log(`${target} ${l.code}: +${n} reused`);
}
process.exit(0);
