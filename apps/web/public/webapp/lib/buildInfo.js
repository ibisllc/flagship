// What this build is, for the security notice (docs/security-notices.md): a
// notice names the oldest build and protocol level it still accepts, and the
// app compares them with these.
//
// WEB_BUILD is the shell version number in service-worker.js (SHELL_VERSION
// "v156" is 156); a test fails when they drift, so bump both together.
// PROTOCOL_LEVEL mirrors CLIENT_PROTOCOL_LEVEL in packages/protocol: raise it
// only when a breaking change to a signed message or wire contract ships.

import { tr } from "./i18n.js";

export const PLATFORM = "web";
export const WEB_BUILD = 157;
export const PROTOCOL_LEVEL = 1;

// The one product version every Flagship surface shows (release/version.json;
// scripts/check-versions.mjs --write keeps these two in step). It is not a
// protocol or wire version and nothing compares it.
export const PRODUCT_VERSION = "0.2";
export const PRODUCT_LABEL = "Beta";

export function aboutVersionLine() {
  return tr("Flagship {0} {1} (web build {2})", PRODUCT_VERSION, PRODUCT_LABEL, WEB_BUILD);
}

export function clientIdentity() {
  return { platform: PLATFORM, build: WEB_BUILD, protocol: PROTOCOL_LEVEL };
}
