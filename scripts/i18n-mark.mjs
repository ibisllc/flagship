#!/usr/bin/env node
// i18n-mark <surface> <n,n,...>  — mark entries of the last `dump` batch as not translatable
// (developer diagnostics, identifiers, protocol markers). Their English stays in the resource files.
import fs from "node:fs";
import { readEn, writeEn } from "./lib/i18n-kv.mjs";
const [surface, list] = process.argv.slice(2);
const batch = JSON.parse(fs.readFileSync(`/tmp/i18n-batch-${surface}.json`, "utf8"));
const en = readEn(surface);
for (const n of list.split(",").filter(Boolean)) if (en[batch[n]]) en[batch[n]].translatable = false;
writeEn(surface, en);
console.log(`marked ${list.split(",").filter(Boolean).length} entries of ${surface}`);
