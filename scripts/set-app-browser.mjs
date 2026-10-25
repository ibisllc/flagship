#!/usr/bin/env node
// Turn the policed app browser on or off for this release (release/box-release.json `appBrowser`,
// compiled into BOX_RELEASE, which APP_BROWSER.enabled in the daemon reads) and regenerate everything
// that carries it (scripts/box-release-regen.mjs). scripts/release.sh calls `off` when the release
// gym's browser-grants group failed while every other group was green (gym-release-run.sh exit 6):
// the browser ships only if the gym proves it (owner decision).
//
//   node scripts/set-app-browser.mjs on|off
import { regenerateBoxRelease, setBoxReleaseField } from "./box-release-regen.mjs";

const want = process.argv[2];
if (want !== "on" && want !== "off") {
  console.error("usage: set-app-browser.mjs on|off");
  process.exit(2);
}
if (!setBoxReleaseField("appBrowser", want === "on")) {
  console.log(`the app browser is already ${want} for this release`);
  process.exit(0);
}
regenerateBoxRelease();
console.log(`the app browser is now ${want} for this release; commit release/box-release.json and the regenerated files`);
