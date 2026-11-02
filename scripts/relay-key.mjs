#!/usr/bin/env node
/**
 * relay-key — a relay's key seed and its public key (docs/runbooks/relay-mesh.md "Admit a relay").
 *
 *   node scripts/relay-key.mjs new <seed-file>     write a fresh 32-byte seed (64 hex) to <seed-file>, mode 0600,
 *                                                  and print the relay key (refuses to overwrite)
 *   node scripts/relay-key.mjs pub <seed-file>     print the relay key of an existing seed
 *
 * The seed is the relay's FLAGSHIP_RELAY_KEY_SEED (an Ed25519 seed); the printed key is what
 * `npm run relays -- add <relayId> <relayKey> ...` admits. The seed is never printed.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The Ed25519 public key (64 lowercase hex) of a 64-hex seed. */
export function relayKeyFromSeed(seedHex) {
  const s = String(seedHex).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("a relay key seed is 64 hex characters");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(s, "hex")]), format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
}

function main(argv) {
  const [cmd, file] = argv;
  if (!file || (cmd !== "new" && cmd !== "pub")) {
    console.error("usage: node scripts/relay-key.mjs new|pub <seed-file>");
    process.exit(2);
  }
  if (cmd === "new") {
    if (existsSync(file)) {
      console.error(`${file} exists: a relay key is never reused or replaced in place (use stage-key for a rotation)`);
      process.exit(1);
    }
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  }
  console.log(relayKeyFromSeed(readFileSync(file, "utf8")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
