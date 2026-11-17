#!/usr/bin/env node
/**
 * voucher-key — a voucher signing key for `.com` (docs/payments-privacy-and-rails.md "As built").
 *
 *   node scripts/voucher-key.mjs new <file> [--bits 3072] [--issue-years 1] [--accept-years 6]
 *       write a fresh RSA key as the VOUCHER_SIGNING_KEYS entry {jwk, issueUntil, acceptUntil} to <file> (mode 0600,
 *       refuses to overwrite) and print its public key id
 *   node scripts/voucher-key.mjs pub <file>
 *       print the key id and the public numbers clients see at GET /api/payments/config
 *
 * The secret is a JSON array of entries, current key first:
 *   jq -s . new-key.json old-key.json | npx wrangler secret put VOUCHER_SIGNING_KEYS
 * One key a year (a key that rotates often dates the purchase); its vouchers are accepted at least five years after
 * it stops issuing (US gift-card rules). The private key never leaves the file and the Worker secret.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const YEAR = 365 * 86_400_000;

/** The public key id clients compute (protocol voucher.ts voucherKeyId). */
export function voucherKeyIdFromJwk(jwk) {
  const n = Buffer.from(jwk.n, "base64url").toString("hex");
  let e = Buffer.from(jwk.e, "base64url").toString("hex").replace(/^(00)+/, "");
  if (e.length % 2) e = "0" + e;
  const nHex = n.replace(/^(00)+(?=..)/, "");
  return { keyId: createHash("sha256").update(`flagship/voucher-key/v1|${nHex}|${e}`).digest("hex").slice(0, 16), nHex, eHex: e };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
}

function main(argv) {
  const [cmd, file] = argv;
  if (!file || (cmd !== "new" && cmd !== "pub")) {
    console.error("usage: node scripts/voucher-key.mjs new|pub <file> [--bits 3072] [--issue-years 1] [--accept-years 6]");
    process.exit(2);
  }
  if (cmd === "new") {
    if (existsSync(file)) {
      console.error(`${file} exists: a voucher key is never replaced in place`);
      process.exit(1);
    }
    const bits = arg(argv, "--bits", 3072);
    if (!(bits >= 2048)) throw new Error("--bits must be 2048 or more");
    const now = Date.now();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 });
    const entry = {
      jwk: privateKey.export({ format: "jwk" }),
      issueUntil: now + Math.round(arg(argv, "--issue-years", 1) * YEAR),
      acceptUntil: now + Math.round(arg(argv, "--accept-years", 6) * YEAR),
    };
    writeFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600, flag: "wx" });
  }
  const entry = JSON.parse(readFileSync(file, "utf8"));
  const pub = voucherKeyIdFromJwk(entry.jwk);
  console.log(JSON.stringify({ keyId: pub.keyId, eHex: pub.eHex, bits: pub.nHex.length * 4, issueUntil: entry.issueUntil, acceptUntil: entry.acceptUntil }));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
