#!/usr/bin/env node
// Re-pin the bootstrap's byte-identity hash after a box release changes it.
//
// The encrypted Debian bootstrap embeds release/box-release.json (SEC-INSTALL-001), so every new box
// release changes its SHA-256. packages/flagship-builder/tests/userdata.test.ts pins that hash, and the
// Swift builder's engine tests pin the SAME value (the two builders must emit identical bytes). This runs
// the TS test, reads the hash it actually produced, and replaces the old literal everywhere it is pinned.
//
//   node scripts/repin-bootstrap-sha.mjs           print what would change
//   node scripts/repin-bootstrap-sha.mjs --write   rewrite the pins (scripts/release.sh calls this)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const TEST_FILE = "packages/flagship-builder/tests/userdata.test.ts";
const TEST_NAME = "the encrypted DEBIAN bootstrap is BYTE-IDENTICAL to the Swift twin";

const r = spawnSync("npx", ["vitest", "run", TEST_FILE, "-t", TEST_NAME, "--reporter=json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
const result = report.testResults.flatMap((f) => f.assertionResults).find((a) => a.title.includes("encrypted DEBIAN bootstrap"));
if (!result) {
  console.error("the bootstrap pin test did not run");
  process.exit(1);
}
if (result.status === "passed") {
  console.log("the bootstrap pin is current");
  process.exit(0);
}
const msg = (result.failureMessages ?? []).join("\n");
const m = /expected '([0-9a-f]{64})' to be '([0-9a-f]{64})'/.exec(msg);
if (!m) {
  console.error("the bootstrap pin test failed for another reason:\n" + msg.slice(0, 2000));
  process.exit(1);
}
const [, actual, pinned] = m;
const files = execFileSync("git", ["grep", "-l", pinned], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`${pinned} -> ${actual} in:\n  ${files.join("\n  ")}`);
if (process.argv.includes("--write")) {
  for (const f of files) {
    const p = join(REPO, f);
    writeFileSync(p, readFileSync(p, "utf8").split(pinned).join(actual));
  }
  console.log("rewritten");
}
