#!/usr/bin/env -S npx tsx
/**
 * Calls one owner-session endpoint on a gym box of a demo account (pairs a
 * fresh session with the account's demo keys) and prints the answer:
 *   npx tsx tools/live-e2e/probe-cli.ts <user> <serverName> <METHOD> <path> [jsonBody]
 */
import { Account, pair } from "./lib/fleet.js";
import { SERVICES, http } from "./lib/harness.js";

const [user, serverName, method, path, body] = process.argv.slice(2);
if (!user || !serverName || !method || !path) {
  process.stdout.write("usage: probe-cli.ts <user> <serverName> <METHOD> <path> [jsonBody]\n");
  process.exit(2);
}
const acct = new Account(user);
const box = { account: user, serverName, fqdn: `${serverName}.${user}.${SERVICES}`, serverId: null, via: "demo" as const, online: true };
const session = await pair(acct, box);
const r = await http(`https://${box.fqdn}${path}`, {
  method,
  headers: { "x-flagship-session": session, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body } : {}),
});
process.stdout.write(`${r.status}\n${r.text}\n`);
