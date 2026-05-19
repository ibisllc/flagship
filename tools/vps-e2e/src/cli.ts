#!/usr/bin/env node
/**
 * `create-vps` — real-VPS end-to-end harness CLI.
 *
 * Provisions a real cloud VPS from an ALREADY-personalized Flagship
 * ISO (passed as `--iso`, an INPUT — this harness does NOT do the
 * browser/phone ISO personalization) and drives + asserts the WHOLE
 * Flagship chain via the pure core (`runE2E`).
 *
 * This file is the thin real-I/O wiring + arg parsing. It is NOT
 * unit-tested against real infra; the pure core + the arg/plan
 * builders below ARE (see tests/). Honest by construction: `--plan`
 * prints the full ordered chain (incl. the two KNOWN-GATED stages)
 * with ZERO credentials and provisions nothing; a real run fails
 * closed with exact instructions if the provider token env is absent.
 */

import { HetznerProvider } from "./providers/hetzner.js";
import { nodeHttpClient } from "./httpClient.js";
import { makeIdentity } from "./identity.js";
import { plannedChain, runE2E, type PlannedStage } from "./runE2E.js";
import type { E2EPlan, Logger, VpsProvider } from "./ports.js";

export interface CliArgs {
  iso?: string;
  provider: string;
  providerTokenEnv: string;
  comBase: string;
  servicesBase: string;
  username: string;
  serverName: string;
  region: string;
  size: string;
  plan: boolean;
  keep: boolean;
}

const DEFAULTS = {
  provider: "hetzner",
  providerTokenEnv: "HCLOUD_TOKEN",
  comBase: "https://flagshipserver.com",
  servicesBase: "https://flagship.services",
  region: "nbg1",
  size: "cx22",
};

/** Pure arg parser (unit-tested). Throws on unknown flags. */
export function parseArgs(argv: string[]): CliArgs {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined || !tok.startsWith("--")) {
      throw new Error(`unexpected argument: ${tok}`);
    }
    const key = tok.slice(2);
    if (key === "plan" || key === "keep") {
      a[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    a[key] = val;
    i++;
  }
  const rnd = Math.random().toString(36).slice(2, 7);
  return {
    iso: typeof a["iso"] === "string" ? (a["iso"] as string) : undefined,
    provider: (a["provider"] as string) ?? DEFAULTS.provider,
    providerTokenEnv:
      (a["provider-token"] as string) ?? DEFAULTS.providerTokenEnv,
    comBase: (a["com-base"] as string) ?? DEFAULTS.comBase,
    servicesBase: (a["services-base"] as string) ?? DEFAULTS.servicesBase,
    username: (a["username"] as string) ?? `e2e${rnd}`,
    serverName: (a["server-name"] as string) ?? "home",
    region: (a["region"] as string) ?? DEFAULTS.region,
    size: (a["size"] as string) ?? DEFAULTS.size,
    plan: a["plan"] === true,
    keep: a["keep"] === true,
  };
}

/** Pure: render the `--plan` text (unit-tested, zero credentials). */
export function renderPlan(chain: PlannedStage[]): string {
  const lines: string[] = [];
  lines.push("create-vps — full ordered chain (no provisioning happens with --plan):");
  lines.push("");
  chain.forEach((s, i) => {
    const tag =
      s.kind === "known-gated"
        ? " [KNOWN-GATED]"
        : s.kind === "teardown"
          ? " [ALWAYS — try/finally]"
          : "";
    lines.push(`${String(i + 1).padStart(2)}. ${s.name}${tag}`);
    lines.push(`    ${s.description}`);
    if (s.gatedReason) {
      lines.push(`    gatedReason: ${s.gatedReason}`);
    }
  });
  lines.push("");
  lines.push(
    "KNOWN-GATED stages are attempted read-only and reported `known-gated`;",
  );
  lines.push(
    "they NEVER fail the overall run — they document a real, not-yet-wired gap.",
  );
  return lines.join("\n");
}

const consoleLogger: Logger = {
  info: (m, d) => console.log(`[e2e] ${m}`, d ?? ""),
  warn: (m, d) => console.warn(`[e2e] ${m}`, d ?? ""),
  error: (m, d) => console.error(`[e2e] ${m}`, d ?? ""),
};

function buildProvider(args: CliArgs, token: string): VpsProvider {
  switch (args.provider) {
    case "hetzner":
      return new HetznerProvider({ token });
    default:
      throw new Error(
        `unknown provider "${args.provider}" (only "hetzner" has a reference adapter)`,
      );
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(
      `argument error: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.error(
      "usage: create-vps --iso <path|url|hetzner-iso-name> --provider <name> " +
        "[--provider-token <ENV>] [--com-base <url>] [--services-base <url>] " +
        "[--region <r>] [--size <s>] [--username <u>] [--server-name <s>] " +
        "[--plan] [--keep]",
    );
    return 2;
  }

  // --plan: zero credentials, provisions nothing, exits before any I/O.
  if (args.plan) {
    console.log(renderPlan(plannedChain()));
    return 0;
  }

  if (!args.iso) {
    console.error(
      "fail-closed: --iso is required for a real run (it is an INPUT — " +
        "personalize the ISO via the browser/phone build flow first).",
    );
    return 2;
  }

  const token = process.env[args.providerTokenEnv];
  if (!token) {
    // Deterministic fail-closed — never hang, never fake a run.
    console.error(
      `fail-closed: provider token env "${args.providerTokenEnv}" is not set.\n` +
        `A real run provisions a real ${args.provider} VPS and incurs cost.\n` +
        `Set it and re-run, e.g.:\n` +
        `    export ${args.providerTokenEnv}=<your-${args.provider}-api-token>\n` +
        `    create-vps --iso ${args.iso} --provider ${args.provider}\n` +
        `(or run \`create-vps --plan\` to see the chain without provisioning).`,
    );
    return 3;
  }

  let provider: VpsProvider;
  try {
    provider = buildProvider(args, token);
  } catch (e) {
    console.error(
      `fail-closed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 3;
  }

  const plan: E2EPlan = {
    comBase: args.comBase,
    servicesBase: args.servicesBase,
    iso: args.iso,
    username: args.username,
    serverName: args.serverName,
    region: args.region,
    size: args.size,
    pollIntervalMs: 15_000,
    pollMaxAttempts: 80,
    keep: args.keep,
  };

  const report = await runE2E(plan, {
    provider,
    http: nodeHttpClient,
    clock: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger: consoleLogger,
    identity: makeIdentity(),
  });

  for (const s of report.stages) {
    const line = `[${s.status.toUpperCase()}] ${s.name} — ${s.detail}`;
    if (s.status === "fail") console.error(line);
    else console.log(line);
    if (s.gatedReason) console.log(`        gatedReason: ${s.gatedReason}`);
  }
  console.log(
    `\nresult: ${report.ok ? "OK" : "FAILED"} ` +
      `(${report.stages.filter((s) => s.status === "pass").length} pass, ` +
      `${report.stages.filter((s) => s.status === "fail").length} fail, ` +
      `${report.stages.filter((s) => s.status === "known-gated").length} known-gated, ` +
      `${report.stages.filter((s) => s.status === "skipped").length} skipped)`,
  );
  return report.ok ? 0 : 1;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[e2e] fatal:", err);
      process.exit(1);
    });
}
