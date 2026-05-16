#!/usr/bin/env node
/**
 * check-push-secrets — operator/CI guard that the .com Worker's push
 * credentials are actually injected (audit N3 hardening, #23).
 *
 * WHY: packages/control-plane/src/push.ts:159 falls back to
 * `{ok:true, simulated:true}` when `forwardToProviders` is absent, and
 * the Worker only builds the forwarder when the provider env vars are
 * set (controlPlaneRoutes.ts ~1155). So a deploy that loses the APNs
 * secrets makes push SILENTLY succeed without delivering. This script
 * makes that regression loud: run it post-deploy (or in CI) and it
 * exits non-zero if a required push secret is missing.
 *
 * Verified state 2026-05-16: the live Worker has all four APNS_* +
 * the WEBPUSH_* VAPID secrets set (iOS + Web Push are REAL, not
 * simulated). FCM_* is intentionally NOT set yet — Android isn't on
 * Play, so no FCM consumers exist; `--require-fcm` flips that to a
 * hard requirement for when Android ships.
 *
 *   node scripts/check-push-secrets.mjs            # apns+webpush required
 *   node scripts/check-push-secrets.mjs --require-fcm
 *   (reads `cd apps/com && npx wrangler secret list` JSON)
 *
 * Pure helper exported for scripts/check-push-secrets.test.ts; the
 * file is import-safe (no side effects unless run as main).
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

/** APNs (iOS) + Web Push are required for the shipping clients. FCM
 *  only once Android ships (gated by `requireFcm`). */
export const REQUIRED_APNS = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY_PEM", "APNS_BUNDLE_ID"];
export const REQUIRED_WEBPUSH = ["WEBPUSH_VAPID_PRIVATE_KEY_PEM", "WEBPUSH_VAPID_PUBLIC_KEY_B64URL", "WEBPUSH_CONTACT"];
export const REQUIRED_FCM = ["FCM_SERVICE_ACCOUNT_JSON", "FCM_PROJECT_ID"];

/**
 * Given the set of secret names present on the Worker, return the
 * required ones that are MISSING (pure; the caller decides exit code).
 */
export function missingPushSecrets(presentNames, opts = {}) {
  const present = new Set(presentNames);
  const required = [
    ...REQUIRED_APNS,
    ...REQUIRED_WEBPUSH,
    ...(opts.requireFcm ? REQUIRED_FCM : []),
  ];
  return required.filter((n) => !present.has(n));
}

/** Parse `wrangler secret list` JSON → an array of secret names. */
export function parseSecretNames(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => (e && typeof e === "object" ? e.name : undefined))
    .filter((n) => typeof n === "string");
}

function main() {
  const requireFcm = process.argv.includes("--require-fcm");
  const comDir = path.resolve("apps/com");
  const r = spawnSync("npx", ["wrangler", "secret", "list"], {
    cwd: comDir,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`[check-push-secrets] \`wrangler secret list\` failed (auth/network?):\n${r.stderr || r.stdout}`);
    return 2;
  }
  const names = parseSecretNames(r.stdout);
  const missing = missingPushSecrets(names, { requireFcm });
  if (missing.length > 0) {
    console.error("");
    console.error("================================================================");
    console.error("PUSH WILL SILENTLY NO-OP: required Worker secret(s) missing");
    console.error("================================================================");
    console.error(`Missing: ${missing.join(", ")}`);
    console.error("Set them with: cd apps/com && printf %s '<value>' | npx wrangler secret put <NAME>");
    console.error("(APNs + Web Push are required for the shipping iOS/web clients;");
    console.error(" pass --require-fcm once Android is on Play.)");
    console.error("================================================================");
    return 1;
  }
  console.log(`[check-push-secrets] OK — all required push secrets present${requireFcm ? " (incl. FCM)" : " (FCM not required yet)"}.`);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) process.exit(main());
