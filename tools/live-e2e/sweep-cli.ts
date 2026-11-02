#!/usr/bin/env -S npx tsx
/**
 * Lists (default) or removes (--destroy) every gym-labelled server and every
 * gym DNS record under the gym services apex, through the gym Worker:
 *   npx tsx tools/live-e2e/sweep-cli.ts [--destroy] [--include-relays]
 * Only for when no live gym run is in progress (it reaps every run's leftovers). The gym relay mesh's relay VMs
 * (`gym-relay-*`) serve every run and are kept unless --include-relays.
 */
import { sweep } from "./lib/fleet.js";

const destroy = process.argv.includes("--destroy");
const includeRelays = process.argv.includes("--include-relays");
const r = await sweep(destroy, includeRelays);
process.stdout.write(`${destroy ? "swept" : "dry run"}: ${r.status} ${JSON.stringify(r.body).slice(0, 800)}\n`);
if (destroy) {
  const after = await sweep(false, includeRelays);
  process.stdout.write(`left: ${after.body?.servers?.length ?? "?"} server(s), ${after.body?.dnsWouldDelete ?? "?"} DNS record(s)\n`);
}
