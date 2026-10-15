#!/usr/bin/env -S npx tsx
/**
 * Operator helpers for the gym fleet (env from .gym-secrets.env):
 *
 *   npx tsx tools/live-e2e/fleet-cli.ts sweep              # list gym-labelled servers still on UpCloud
 *   npx tsx tools/live-e2e/fleet-cli.ts sweep --destroy    # destroy all of them (end-of-run safety net)
 *   npx tsx tools/live-e2e/fleet-cli.ts teardown <fleet.json>   # tear down one run's fleet
 *   npx tsx tools/live-e2e/fleet-cli.ts add-box <user> <serverName>   # another box for a demo account
 *   npx tsx tools/live-e2e/fleet-cli.ts destroy <serverId> [fqdn]   # one gym-labelled server (+ its DNS)
 *   npx tsx tools/live-e2e/fleet-cli.ts demo-users         # demo accounts the gym Worker knows
 */
import { readFileSync } from "node:fs";
import { Account, addBox, sweep, teardown, type Box } from "./lib/fleet.js";
import { CONTROL, adminHeaders, http } from "./lib/harness.js";

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "sweep") {
    const r = await sweep(rest.includes("--destroy"));
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return r.status === 200 ? 0 : 1;
  }
  if (cmd === "teardown" && rest[0]) {
    const data = JSON.parse(readFileSync(rest[0], "utf8")) as { accounts: Array<{ username: string; boxes: Box[] }> };
    const accounts = data.accounts.map((a) => {
      const acct = new Account(a.username);
      acct.boxes.push(...a.boxes);
      return acct;
    });
    process.stdout.write(JSON.stringify(await teardown(accounts), null, 2) + "\n");
    return 0;
  }
  if (cmd === "add-box" && rest[0] && rest[1]) {
    const b = await addBox(new Account(rest[0]), rest[1]);
    process.stdout.write(JSON.stringify(b) + "\n");
    return 0;
  }
  if (cmd === "destroy" && rest[0]) {
    const r = await http(`https://${CONTROL}/api/gym/teardown`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ serverIds: [rest[0]], serverDomains: rest[1] ? [rest[1]] : [] }),
    }, 300_000);
    process.stdout.write(JSON.stringify(r.json ?? r.text, null, 2) + "\n");
    return r.status === 200 ? 0 : 1;
  }
  if (cmd === "demo-users") {
    const r = await http(`https://${CONTROL}/api/dev/sample-user`, { headers: adminHeaders() });
    process.stdout.write(JSON.stringify(r.json ?? r.text, null, 2) + "\n");
    return 0;
  }
  process.stdout.write("usage: fleet-cli.ts sweep [--destroy] | teardown <fleet.json> | add-box <user> <serverName> | demo-users\n");
  return 2;
}

main().then((c) => process.exit(c), (e) => {
  process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
