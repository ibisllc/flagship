#!/usr/bin/env node
// Set what new servers are built on (release/box-release.json `newBoxStack`) and regenerate
// everything that carries it (scripts/box-release-regen.mjs): the generated BOX_RELEASE constants,
// the preseed engine bundle and its native copies (Mac Studio, Android), the engine's golden vectors
// and the bootstrap byte pin. scripts/release.sh calls it when the release gym says arch-v2 is not
// ready (exit 5).
//
//   node scripts/set-new-box-stack.mjs arch-v2|classic
import { regenerateBoxRelease, setBoxReleaseField } from "./box-release-regen.mjs";

const stack = process.argv[2];
if (stack !== "arch-v2" && stack !== "classic") {
  console.error("usage: set-new-box-stack.mjs arch-v2|classic");
  process.exit(2);
}
if (!setBoxReleaseField("newBoxStack", stack)) {
  console.log(`new boxes are already built on ${stack}`);
  process.exit(0);
}
regenerateBoxRelease();
console.log(`new boxes are now built on ${stack}; commit release/box-release.json and the regenerated files`);
