#!/usr/bin/env -S npx tsx
/**
 * Whether Let's Encrypt would issue another certificate under the gym's
 * services apex right now (the budget is shared with prod: see lib/acmeProbe.ts).
 *   npx tsx tools/live-e2e/acme-budget-cli.ts
 */
import { SERVICES } from "./lib/harness.js";
import { acmeBudget } from "./lib/acmeProbe.js";

const b = await acmeBudget(SERVICES);
process.stdout.write(`${b.ok ? "room" : "EXHAUSTED"}: ${b.detail}\n`);
process.exit(b.ok ? 0 : 1);
