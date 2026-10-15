#!/usr/bin/env -S npx tsx
/**
 * Reads a gym box's daemon journal with the account's demo owner IRK:
 *   npx tsx tools/live-e2e/journal-cli.ts <user> <serverName> [lines] [regex]
 */
import { bytesToHex } from "@noble/hashes/utils";
import { signJournalRequest, type JournalRequest } from "@flagship/protocol";
import { Account } from "./lib/fleet.js";
import { SERVICES, postJson } from "./lib/harness.js";

const [user, serverName, linesArg, pattern] = process.argv.slice(2);
if (!user || !serverName) {
  process.stdout.write("usage: journal-cli.ts <user> <serverName> [lines] [regex]\n");
  process.exit(2);
}
const fqdn = `${serverName}.${user}.${SERVICES}`;
const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: Number(linesArg ?? 300), issuedAt: Date.now() };
const r = await postJson(`https://${fqdn}/api/journal`, { request: req, signature: bytesToHex(signJournalRequest(req, new Account(user).keys.irk)) });
const lines: string[] = r.json?.lines ?? r.json?.log ?? [];
const re = pattern ? new RegExp(pattern, "i") : null;
for (const l of lines) if (!re || re.test(l)) process.stdout.write(l + "\n");
if (r.status !== 200) process.stdout.write(`journal ${r.status}: ${r.text.slice(0, 200)}\n`);
