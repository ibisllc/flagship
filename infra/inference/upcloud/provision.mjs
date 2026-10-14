#!/usr/bin/env node
/**
 * provision — the Flagship inference GPU server on UpCloud.
 *
 *   node infra/inference/upcloud/provision.mjs plan            # default: dry run, no network, no token
 *   node infra/inference/upcloud/provision.mjs create --yes    # creates the server (BILLS from now on)
 *   node infra/inference/upcloud/provision.mjs status
 *   node infra/inference/upcloud/provision.mjs health          # through the tunnel, as the shim would call it
 *   node infra/inference/upcloud/provision.mjs stop  --yes     # power off (see README for what still bills)
 *   node infra/inference/upcloud/provision.mjs start --yes
 *   node infra/inference/upcloud/teardown.mjs --yes            # delete server + disk
 *
 * Flags: --config <path> (default ./config.json next to this file).
 *
 * Env (never printed):
 *   UPCLOUD_TOKEN          API token (`ucat_…`) — create/status/start/stop
 *   VLLM_API_KEY           the key vLLM requires; the shim's UPSTREAM_API_KEY — create, health
 *   CF_TUNNEL_TOKEN        Cloudflare Tunnel connector token — create
 *   INFERENCE_UPSTREAM     https://<tunnel hostname> — health
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Access service token — health
 */

import { fileURLToPath } from "node:url";
import {
  createClient,
  firewallRules,
  loadConfig,
  publicAddresses,
  readSecrets,
  redact,
  renderCloudInit,
  serverCreateBody,
} from "./lib.mjs";

const COMMANDS = new Set(["plan", "create", "status", "health", "start", "stop", "help"]);
const NEEDS_YES = new Set(["create", "start", "stop"]);

export const USAGE = `usage: provision.mjs <plan|create|status|health|start|stop> [--config <path>] [--yes]
  plan    print what create would send (secrets redacted); no network
  create  create the GPU server from config.json (needs --yes; it bills hourly)
  status  show the server's state and addresses
  health  check vLLM through the tunnel: /health, /v1/models, one tool call
  stop    power the server off (needs --yes)
  start   power it back on (needs --yes)`;

export function parseArgs(argv) {
  const out = { command: "plan", config: undefined, yes: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) out.command = rest.shift();
  if (!COMMANDS.has(out.command)) throw new Error(`unknown command: ${out.command}`);
  while (rest.length) {
    const a = rest.shift();
    if (a === "--yes") out.yes = true;
    else if (a === "--config") {
      out.config = rest.shift();
      if (!out.config) throw new Error("--config needs a path");
    } else if (a === "--help" || a === "-h") out.command = "help";
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/** Placeholder secrets with the right shape, for a dry run without the real ones. */
const PLAN_SECRETS = { apiKey: "plan-only-vllm-api-key-000000000", tunnelToken: "plan-only-tunnel-token-000000000" };

export async function run(args, deps) {
  const { env, out, fetch: f, sleep } = deps;
  if (args.command === "help") {
    out(USAGE);
    return 0;
  }
  if (NEEDS_YES.has(args.command) && !args.yes) {
    throw new Error(`${args.command} changes a billed server; re-run with --yes`);
  }
  const config = deps.config ?? loadConfig(args.config);

  if (args.command === "plan") {
    const secrets = env.VLLM_API_KEY && env.CF_TUNNEL_TOKEN ? readSecrets(env) : PLAN_SECRETS;
    const userData = renderCloudInit(config, secrets);
    const body = serverCreateBody(config, "<cloud-init below>", config.template ?? `<template titled "${config.templateTitle}">`);
    out(`POST /1.3/server\n${JSON.stringify(body, null, 2)}`);
    out(`\nPUT /1.3/server/<uuid>/firewall_rule\n${JSON.stringify({ firewall_rules: { firewall_rule: firewallRules() } }, null, 2)}`);
    out(`\nuser_data (${Buffer.byteLength(userData)} bytes):\n${redact(userData, secrets)}`);
    if (config.price) {
      out(`\nPrice (config.price, check upcloud.com/pricing): ${config.price.hourly} ${config.price.currency}/h, ` +
        `${config.price.monthly} ${config.price.currency}/month`);
    }
    return 0;
  }

  if (args.command === "health") return health(config, deps);

  const client = createClient({ token: env.UPCLOUD_TOKEN, ...(f ? { fetch: f } : {}), ...(sleep ? { sleep } : {}) });

  if (args.command === "create") {
    const secrets = readSecrets(env);
    const existing = await client.findByName(config.name);
    if (existing) {
      out(`${config.name} already exists (${existing.uuid}, ${existing.state}); nothing created.`);
      return 0;
    }
    const template = await client.resolveTemplate(config);
    const userData = renderCloudInit(config, secrets);
    const server = await client.create(serverCreateBody(config, userData, template));
    out(`created ${config.name}: ${server.uuid} in ${config.zone} on ${config.plan}`);
    // Rules go on straight away; nothing listens publicly in the meantime
    // (vLLM binds loopback, SSH is off, no login credentials exist).
    let lastErr;
    for (let i = 0; i < 12; i += 1) {
      try {
        await client.setFirewall(server.uuid, firewallRules());
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (e.status !== 409) break;
        await (sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(5000);
      }
    }
    if (lastErr) {
      out(`WARNING: firewall rules were not applied (${lastErr.message}). Re-run "create" is a no-op; ` +
        `apply them from the control panel or tear the server down.`);
      return 1;
    }
    out(`firewall: inbound allows only replies to the box's own connections; default drop`);
    out(`addresses: ${publicAddresses(server).join(", ") || "(assigned at start)"}`);
    out(`Setup takes ~15–25 min (driver, images, ~${config.weightsGb ?? "?"} GB of weights, one reboot). ` +
      `Then: node provision.mjs health`);
    return 0;
  }

  const found = await client.findByName(config.name);
  if (!found) {
    out(`${config.name}: no such server`);
    return 1;
  }

  if (args.command === "status") {
    const s = (await client.getServer(found.uuid)) ?? found;
    out(`${config.name}: ${s.uuid} state=${s.state} zone=${s.zone ?? config.zone} plan=${s.plan ?? config.plan}`);
    out(`addresses: ${publicAddresses(s).join(", ") || "(none)"}`);
    return 0;
  }
  if (args.command === "stop") {
    await client.stop(found.uuid);
    await client.waitForState(found.uuid, "stopped");
    out(`${config.name} stopped`);
    return 0;
  }
  if (args.command === "start") {
    await client.start(found.uuid);
    await client.waitForState(found.uuid, "started");
    out(`${config.name} started; vLLM answers once the weights load (~2–5 min). Check with: health`);
    return 0;
  }
  throw new Error(`unhandled command ${args.command}`);
}

/** What the shim does, minus metering: reach vLLM through the tunnel and Access. */
export async function health(config, { env, out, fetch: f = globalThis.fetch }) {
  const base = (env.INFERENCE_UPSTREAM ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("INFERENCE_UPSTREAM must be the tunnel's https:// origin");
  const access = {};
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    access["cf-access-client-id"] = env.CF_ACCESS_CLIENT_ID;
    access["cf-access-client-secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  const auth = { ...access, authorization: `Bearer ${env.VLLM_API_KEY ?? ""}` };
  let failed = 0;
  const check = async (label, fn) => {
    try {
      out(`ok   ${label}: ${await fn()}`);
    } catch (e) {
      failed += 1;
      out(`FAIL ${label}: ${e.message}`);
    }
  };
  await check("/health", async () => {
    const r = await f(`${base}/health`, { headers: access });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return "200";
  });
  await check("/v1/models", async () => {
    const r = await f(`${base}/v1/models`, { headers: auth });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const ids = ((await r.json())?.data ?? []).map((m) => m.id);
    if (!ids.includes(config.vllm.servedModelName)) throw new Error(`serves ${ids.join(", ")}, not ${config.vllm.servedModelName}`);
    return ids.join(", ");
  });
  await check("tool call", async () => {
    const r = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.vllm.servedModelName,
        max_tokens: 256,
        messages: [{ role: "user", content: "Read the file package.json using the tool." }],
        tools: [{
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file from the workspace",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
      }),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const b = await r.json();
    const call = b?.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.name !== "read_file") throw new Error("no read_file tool call in the answer");
    return `read_file(${call.function.arguments}) · usage ${b.usage?.prompt_tokens ?? "?"} in / ${b.usage?.completion_tokens ?? "?"} out`;
  });
  await check("no key → 401", async () => {
    const r = await f(`${base}/v1/models`, { headers: access });
    if (r.status !== 401) throw new Error(`HTTP ${r.status}: vLLM answered without the API key`);
    return "401";
  });
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exitCode = await run(args, { env: process.env, out: (s) => console.log(s) });
  } catch (e) {
    console.error(`provision: ${e.message}`);
    process.exitCode = 1;
  }
}
