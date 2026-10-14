#!/usr/bin/env node
/**
 * teardown — delete the inference GPU server, its disk and any backups, so
 * nothing about it keeps billing. The weights cache goes with the disk; a
 * later `provision.mjs create` downloads them again.
 *
 *   UPCLOUD_TOKEN=… node infra/inference/upcloud/teardown.mjs --yes [--config <path>]
 *
 * Before tearing down a server the shim still points at, set the shim's
 * PAUSED = "1" (or point UPSTREAM_CHAT_URL elsewhere) so builds get "isn't
 * available right now" instead of an upstream error.
 */

import { fileURLToPath } from "node:url";
import { createClient, loadConfig } from "./lib.mjs";

export function parseArgs(argv) {
  const out = { yes: false, config: undefined };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--yes") out.yes = true;
    else if (a === "--config") {
      out.config = rest.shift();
      if (!out.config) throw new Error("--config needs a path");
    } else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

export async function teardown(args, { env, out, fetch: f, sleep, config: given }) {
  if (!args.yes) throw new Error("teardown deletes the server and its disk; re-run with --yes");
  const config = given ?? loadConfig(args.config);
  const client = createClient({ token: env.UPCLOUD_TOKEN, ...(f ? { fetch: f } : {}), ...(sleep ? { sleep } : {}) });
  const found = await client.findByName(config.name);
  if (!found) {
    out(`${config.name}: nothing to delete`);
    return 0;
  }
  await client.destroy(found.uuid);
  out(`${config.name} (${found.uuid}) deleted with its storage and backups`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await teardown(parseArgs(process.argv.slice(2)), {
      env: process.env,
      out: (s) => console.log(s),
    });
  } catch (e) {
    console.error(`teardown: ${e.message}`);
    process.exitCode = 1;
  }
}
