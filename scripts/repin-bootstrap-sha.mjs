#!/usr/bin/env node
// Re-pin the bootstrap's byte-identity hash after a box release changes it.
//
// The encrypted Debian bootstrap embeds release/box-release.json (SEC-INSTALL-001), so every new box
// release changes its SHA-256. packages/flagship-builder/tests/userdata.test.ts pins that hash, and the
// Swift builder's engine tests pin the SAME value (the two builders must emit identical bytes). This
// builds the script exactly as that test does (from the built package: run `npx tsc -b` first), reads
// the literal the test pins, and replaces it everywhere it is pinned.
//
//   node scripts/repin-bootstrap-sha.mjs           print what would change
//   node scripts/repin-bootstrap-sha.mjs --write   rewrite the pins (scripts/release.sh calls this)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const TEST_FILE = "packages/flagship-builder/tests/userdata.test.ts";
const TEST_NAME = "the encrypted DEBIAN bootstrap is BYTE-IDENTICAL to the Swift twin";

const { buildBootstrapScript, DEFAULT_BOOT_HOST } = await import(join(REPO, "packages/flagship-builder/dist/userdata.js"));
const actual = createHash("sha256")
  .update(
    buildBootstrapScript({
      ref: "a".repeat(40),
      repoUrl: "https://github.com/ibisllc/flagship.git",
      encryptRoot: true,
      bootUnlockMode: "auto",
      bootHost: DEFAULT_BOOT_HOST,
    }),
  )
  .digest("hex");

const test = readFileSync(join(REPO, TEST_FILE), "utf8");
const at = test.indexOf(TEST_NAME);
if (at < 0) {
  console.error(`the pin test "${TEST_NAME}" is not in ${TEST_FILE}`);
  process.exit(1);
}
const block = test.slice(at, test.indexOf("\n  });", at));
const pinned = /"([0-9a-f]{64})"/.exec(block)?.[1];
if (!pinned) {
  console.error("the pin test has no 64-hex literal");
  process.exit(1);
}
if (pinned === actual) {
  console.log("the bootstrap pin is current");
  process.exit(0);
}
const files = execFileSync("git", ["grep", "-l", pinned], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`${pinned} -> ${actual} in:\n  ${files.join("\n  ")}`);
if (process.argv.includes("--write")) {
  for (const f of files) {
    const p = join(REPO, f);
    writeFileSync(p, readFileSync(p, "utf8").split(pinned).join(actual));
  }
  console.log("rewritten");
}
