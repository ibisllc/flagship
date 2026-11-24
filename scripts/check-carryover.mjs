#!/usr/bin/env node
// Runbooks a release must not leave behind. A runbook in docs/runbooks/ that carries the two header lines
//   Must be done before: <product version>
//   Status: OPEN
// fails this check as soon as release/version.json's product version reaches that version, until its status says
// DONE. Run by scripts/release.sh preflight and by vitest (check-carryover.test.ts), so a release cannot skip it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const parts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
export function atOrAbove(v, floor) {
  const a = parts(v), b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function openCarryovers(root = ROOT) {
  const product = JSON.parse(fs.readFileSync(path.join(root, "release/version.json"), "utf8")).product;
  const dir = path.join(root, "docs/runbooks");
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const head = fs.readFileSync(path.join(dir, f), "utf8").split("\n").slice(0, 12).join("\n");
    const before = head.match(/^Must be done before:\s*(\S+)/m)?.[1];
    const status = head.match(/^Status:\s*(\S+)/m)?.[1];
    if (!before) continue;
    const entry = { file: `docs/runbooks/${f}`, before, status: status ?? "missing", product };
    if (status !== "DONE" && atOrAbove(product, before)) out.push(entry);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const open = openCarryovers();
  for (const o of open) {
    console.error(`carry-over: ${o.file} must be done before ${o.before} (product is ${o.product}), status ${o.status}`);
  }
  if (open.length) {
    console.error("Do the runbook, then set its Status to DONE <date> and log what was done. It is never skipped.");
    process.exit(1);
  }
  console.log("carry-over runbooks: ok");
}
