#!/usr/bin/env node
// Emits flagship.apkovl.tar.gz to stdout.
// Reads the three source scripts (bootstrap, trailer-probe, trailer-validate)
// from packages/installer-apkovl/scripts/ and packages them with the format
// from buildFlagshipApkovl().

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFlagshipApkovl } from "../src/buildApkovl.js";

const here = dirname(fileURLToPath(import.meta.url));

const bytes = buildFlagshipApkovl({
  bootstrap: readFileSync(join(here, "flagship-bootstrap.start"), "utf8"),
  trailerProbe: readFileSync(join(here, "flagship-trailer-probe"), "utf8"),
  trailerValidate: readFileSync(join(here, "flagship-trailer-validate"), "utf8"),
});

const out = process.argv[2];
if (out) {
  writeFileSync(out, bytes);
  process.stderr.write(`wrote ${out} (${bytes.length} bytes)\n`);
} else {
  process.stdout.write(bytes);
}
