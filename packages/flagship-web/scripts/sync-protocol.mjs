#!/usr/bin/env node
// Copies the browser port of the voi.ci / Messages protocol (chunk A, docs/voici-and-messages.md §14 A) from the
// webapp into flagship-web, byte for byte, so the library is self-contained (a website that reuses it serves
// packages/flagship-web/src as it is) while the webapp stays the one place the port is edited.
//
//   node packages/flagship-web/scripts/sync-protocol.mjs          copy
//   node packages/flagship-web/scripts/sync-protocol.mjs --check  exit 1 when a copy drifted (tests run this)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const from = join(root, "apps", "web", "public", "webapp");
const to = join(here, "..", "src", "proto");

/** Relative paths under webapp/ and under src/proto/ (the same layout, so the imports stay untouched). */
export const PROTOCOL_FILES = [
  "lib/voiciCore.js",
  "lib/voiciText.js",
  "lib/voiciPage.js",
  "lib/voiciMessages.js",
  "lib/voiciProtocol.js",
  "vendor/noble-post-quantum/pq-seal.js",
];

export function protocolDrift() {
  const out = [];
  for (const f of PROTOCOL_FILES) {
    const a = readFileSync(join(from, f));
    const p = join(to, f);
    if (!existsSync(p) || !readFileSync(p).equals(a)) out.push(f);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const drift = protocolDrift();
    if (drift.length) {
      console.error(`flagship-web: protocol copies differ from the webapp port: ${drift.join(", ")}\nrun: node packages/flagship-web/scripts/sync-protocol.mjs`);
      process.exit(1);
    }
    console.log("flagship-web: protocol copies match the webapp port");
  } else {
    for (const f of PROTOCOL_FILES) {
      mkdirSync(dirname(join(to, f)), { recursive: true });
      writeFileSync(join(to, f), readFileSync(join(from, f)));
    }
    console.log(`flagship-web: copied ${PROTOCOL_FILES.length} files into src/proto/`);
  }
}
