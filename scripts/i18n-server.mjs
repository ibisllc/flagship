#!/usr/bin/env node
// i18n-server — keeps the text the server sends to phones in step with the iOS string catalog.
//
//   node scripts/i18n-server.mjs sync    add every APNs alert sentence in packages/control-plane/src/pushBridge.ts
//                                        to i18n/ios/en.json as a hand-kept entry (scripts/i18n-ios.mjs harvest keeps those)
//   node scripts/i18n-server.mjs check   fail when a sentence the server sends is not an iOS catalog key
//
// APNs shows aps.alert.loc-key through the app's Localizable.strings, so each sentence must be a key there.
import fs from "node:fs";
import path from "node:path";
import { ROOT, readEn, writeEn } from "./lib/i18n-kv.mjs";

const FILE = path.join(ROOT, "packages/control-plane/src/pushBridge.ts");
const src = fs.readFileSync(FILE, "utf8");
const block = src.slice(src.indexOf("const APNS_ALERTS"), src.indexOf("export function apnsAlertFor"));
const sentences = [...new Set([...block.matchAll(/body:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')))];

const cmd = process.argv[2];
const en = readEn("ios");
if (cmd === "sync") {
  for (const s of sentences) en[s] = { ...(en[s] ?? {}), en: s, ctx: "packages/control-plane/src/pushBridge.ts (APNs alert, shown by iOS from loc-key)", manual: true };
  writeEn("ios", en);
  console.log(`${sentences.length} server sentences are iOS catalog keys`);
} else if (cmd === "check") {
  const missing = sentences.filter((s) => !en[s]);
  if (missing.length) { console.error(`not in i18n/ios/en.json (run node scripts/i18n-server.mjs sync):\n${missing.join("\n")}`); process.exit(1); }
  console.log("i18n-server: ok");
} else { console.error("usage: i18n-server.mjs sync | check"); process.exit(2); }
