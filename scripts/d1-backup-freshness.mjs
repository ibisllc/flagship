#!/usr/bin/env node
// Exit 1 when the newest D1 backup is older than the limit (default 36 hours),
// missing, or not the shape d1-backup.sh writes. Reads latest.json (path as the
// first argument); `--max-hours N` changes the limit; `--now ISO` is for tests.
import { readFileSync } from "node:fs";

export function checkFreshness(text, nowMs, maxHours = 36) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, reason: "latest.json is not JSON" };
  }
  const takenMs = Date.parse(j?.takenAt ?? "");
  if (!Number.isFinite(takenMs)) return { ok: false, reason: "latest.json has no takenAt" };
  if (typeof j.key !== "string" || !/^d1\/daily\/.+\.sql\.gpg$/.test(j.key)) return { ok: false, reason: "latest.json names no backup object" };
  if (!(j.bytes > 0)) return { ok: false, reason: "latest.json says the backup is empty" };
  const ageH = (nowMs - takenMs) / 3_600_000;
  if (ageH > maxHours) return { ok: false, reason: `the newest backup is ${ageH.toFixed(1)} hours old (limit ${maxHours}): ${j.key}`, ageH };
  return { ok: true, reason: `newest backup ${ageH.toFixed(1)} hours old: ${j.key}`, ageH };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!file) {
    console.error("usage: d1-backup-freshness.mjs latest.json [--max-hours 36]");
    process.exit(2);
  }
  const r = checkFreshness(readFileSync(file, "utf8"), opt("--now") ? Date.parse(opt("--now")) : Date.now(), Number(opt("--max-hours") ?? 36));
  console.log(r.ok ? `OK: ${r.reason}` : `STALE: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
