#!/usr/bin/env -S npx tsx
/**
 * Lists (default) or removes (--destroy) every gym-labelled server and every
 * gym DNS record under the gym services apex, through the gym Worker:
 *   npx tsx tools/live-e2e/sweep-cli.ts [--destroy]
 * Only for when no live gym run is in progress (it reaps every run's leftovers).
 */
import { sweep } from "./lib/fleet.js";

const destroy = process.argv.includes("--destroy");
const r = await sweep(destroy);
process.stdout.write(`${destroy ? "swept" : "dry run"}: ${r.status} ${JSON.stringify(r.body).slice(0, 800)}\n`);
if (destroy) {
  const after = await sweep(false);
  process.stdout.write(`left: ${after.body?.servers?.length ?? "?"} server(s), ${after.body?.dnsWouldDelete ?? "?"} DNS record(s)\n`);
}
