#!/usr/bin/env node
// Regenerate everything that carries release/box-release.json after it changed: the generated
// BOX_RELEASE constants, the packages that compile them, the preseed engine bundle and its native
// copies (Mac Studio, Android), the engine's golden vectors and the bootstrap byte pin.
// scripts/set-new-box-stack.mjs and scripts/set-app-browser.mjs call it; run it alone after editing
// release/box-release.json by hand.
//
//   node scripts/box-release-regen.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = new URL("..", import.meta.url).pathname;

export function regenerateBoxRelease() {
  const run = (cmd, args, cwd = REPO) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
  run("node", ["scripts/gen-box-release.mjs", "--write"]);
  run("npx", ["tsc", "-b", "packages/protocol", "packages/flagship-builder", "packages/control-plane"]);
  run("npm", ["run", "-s", "bundle:engine"], join(REPO, "packages/flagship-builder"));
  const bundle = join(REPO, "packages/flagship-builder/engine/preseed-engine.js");
  for (const d of ["apps/builder-mac/Sources/FlagshipBuilderCore/Resources", "apps/mobile/android/app/src/main/assets"]) {
    copyFileSync(bundle, join(REPO, d, "preseed-engine.js"));
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(bundle, "utf8"), ctx);
  const vectorsFile = join(REPO, "packages/flagship-builder/engine/golden/preseed-vectors.json");
  const vectors = JSON.parse(readFileSync(vectorsFile, "utf8"));
  for (const v of vectors.vectors) {
    v.expectedPreseed = ctx.FlagshipPreseed.buildPreseedFromRecipe(v.recipeJson, v.burnOptsJson);
    v.expectedInstallBlobJson = ctx.FlagshipPreseed.buildInstallBlobJsonFromRecipe(v.recipeJson);
  }
  writeFileSync(vectorsFile, JSON.stringify(vectors, null, 2) + "\n");
  copyFileSync(vectorsFile, join(REPO, "apps/builder-mac/Tests/FlagshipBuilderTests/Resources/preseed-vectors.json"));
  run("node", ["scripts/repin-bootstrap-sha.mjs", "--write"]);
}

/** Write one field of release/box-release.json; false when it already had that value. */
export function setBoxReleaseField(field, value) {
  const relFile = join(REPO, "release/box-release.json");
  const rel = JSON.parse(readFileSync(relFile, "utf8"));
  if (rel[field] === value) return false;
  rel[field] = value;
  writeFileSync(relFile, JSON.stringify(rel, null, 2) + "\n");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) regenerateBoxRelease();
