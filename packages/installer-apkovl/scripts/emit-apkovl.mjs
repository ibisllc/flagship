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

// Plumb SOURCE_DATE_EPOCH through to the tar mtime field. Falls back to
// 0 when unset (still deterministic) — see docs/runbooks/iso-reproducibility.md.
const epoch = process.env.SOURCE_DATE_EPOCH
  ? Number.parseInt(process.env.SOURCE_DATE_EPOCH, 10)
  : undefined;

const bytes = buildFlagshipApkovl(
  {
    bootstrap: readFileSync(join(here, "flagship-bootstrap.start"), "utf8"),
    trailerProbe: readFileSync(join(here, "flagship-trailer-probe"), "utf8"),
    trailerValidate: readFileSync(join(here, "flagship-trailer-validate"), "utf8"),
  },
  epoch !== undefined && Number.isFinite(epoch) ? { mtime: epoch } : undefined,
);

const out = process.argv[2];
if (out) {
  writeFileSync(out, bytes);
  process.stderr.write(`wrote ${out} (${bytes.length} bytes)\n`);
} else {
  process.stdout.write(bytes);
}
