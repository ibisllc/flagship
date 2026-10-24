#!/usr/bin/env node
// Set what new servers are built on (release/box-release.json `newBoxStack`) and regenerate
// everything that carries it: the generated BOX_RELEASE constants, the preseed engine bundle and its
// native copies (Mac Studio, Android), the engine's golden vectors and the bootstrap byte pin.
// scripts/release.sh calls it when the release gym says arch-v2 is not ready (exit 5).
//
//   node scripts/set-new-box-stack.mjs arch-v2|classic
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const REPO = new URL("..", import.meta.url).pathname;
const stack = process.argv[2];
if (stack !== "arch-v2" && stack !== "classic") {
  console.error("usage: set-new-box-stack.mjs arch-v2|classic");
  process.exit(2);
}
const run = (cmd, args, cwd = REPO) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const relFile = join(REPO, "release/box-release.json");
const rel = JSON.parse(readFileSync(relFile, "utf8"));
if (rel.newBoxStack === stack) {
  console.log(`new boxes are already built on ${stack}`);
  process.exit(0);
}
rel.newBoxStack = stack;
writeFileSync(relFile, JSON.stringify(rel, null, 2) + "\n");

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
console.log(`new boxes are now built on ${stack}; commit release/box-release.json and the regenerated files`);
