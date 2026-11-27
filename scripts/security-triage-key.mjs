#!/usr/bin/env node
/**
 * security-triage-key — make the key pair that lets an AI triage security reports
 * (`npm run security-reports -- --triage`, apps/com/src/securityReports.ts).
 *
 *   node scripts/security-triage-key.mjs            refuses if the Keychain already holds one
 *   node scripts/security-triage-key.mjs --force    replaces it (reports encrypted to the old key stay readable only
 *                                                   with the YubiKey)
 *
 * Generates a curve25519 OpenPGP key in this process, stores the private half (no passphrase; the Keychain guards it)
 * in the macOS Keychain under the service "flagship-security-triage", and prints the public key and fingerprint for
 * apps/com/wrangler.toml (SECURITY_REPORT_TRIAGE_KEY, SECURITY_REPORT_TRIAGE_FINGERPRINT). The private key is passed
 * to `security` on stdin, never on a command line, and never written to a file.
 *
 * Whoever holds this key reads every report sent while it is configured: keep it on this Mac only. To stop triage
 * copies, empty the two vars and deploy `.com`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TRIAGE_KEYCHAIN_SERVICE } from "./security-reports.mjs";

/** One `security -i` command line that stores the key; base64 keeps it one printable token. */
export function keychainAddCommand(armoredPrivate) {
  const b64 = Buffer.from(armoredPrivate, "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("unexpected encoding");
  return `add-generic-password -U -s ${TRIAGE_KEYCHAIN_SERVICE} -a ${TRIAGE_KEYCHAIN_SERVICE} -l "Flagship security triage key" -w ${b64}\n`;
}

/** The two wrangler.toml lines (a TOML multi-line literal holds the armor as is). */
export function wranglerVars(armoredPublic, fingerprint) {
  if (armoredPublic.includes("'''")) throw new Error("unexpected armor");
  return `SECURITY_REPORT_TRIAGE_KEY = '''\n${armoredPublic.trim()}\n'''\nSECURITY_REPORT_TRIAGE_FINGERPRINT = "${fingerprint}"`;
}

async function main() {
  const force = process.argv.includes("--force");
  for (const a of process.argv.slice(2)) if (a !== "--force") throw new Error(`unknown argument: ${a}`);
  if (process.platform !== "darwin") throw new Error("this stores the key in the macOS Keychain; run it on the Mac that will triage");
  const exists = spawnSync("security", ["find-generic-password", "-s", TRIAGE_KEYCHAIN_SERVICE], { stdio: "ignore" }).status === 0;
  if (exists && !force) {
    throw new Error(`the Keychain already holds ${TRIAGE_KEYCHAIN_SERVICE}; pass --force to replace it`);
  }
  const { generateKey, readKey } = await import("openpgp");
  const { privateKey, publicKey } = await generateKey({
    type: "curve25519",
    userIDs: [{ name: "Flagship security triage" }],
    format: "armored",
  });
  const fingerprint = (await readKey({ armoredKey: publicKey })).getFingerprint().toUpperCase();
  const stored = spawnSync("security", ["-i"], { input: keychainAddCommand(privateKey), encoding: "utf8" });
  const check = spawnSync("security", ["find-generic-password", "-s", TRIAGE_KEYCHAIN_SERVICE], { stdio: "ignore" });
  if (stored.status !== 0 || check.status !== 0) throw new Error("the Keychain did not take the key; nothing was configured");
  console.log(`Stored the private key in the Keychain (service ${TRIAGE_KEYCHAIN_SERVICE}).`);
  console.log(`Fingerprint: ${fingerprint}\n`);
  console.log("Put these in apps/com/wrangler.toml [vars], then deploy .com:\n");
  console.log(wranglerVars(publicKey, fingerprint));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
