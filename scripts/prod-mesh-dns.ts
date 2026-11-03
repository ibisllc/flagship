#!/usr/bin/env -S npx tsx
/**
 * DNS for the PRODUCTION relay mesh at launch (docs/runbooks/final-deploy.md 8c; the gym's twin is
 * tools/live-e2e/gym-mesh-dns.ts): one relay, `iad1` on the Fly app `flagship-services`.
 *
 *   npx tsx scripts/prod-mesh-dns.ts            dry run: prints the plan, writes nothing
 *   npx tsx scripts/prod-mesh-dns.ts --apply    writes it
 *
 * Records (all DNS only, TTL 60; only names under `tunnel.flagship.services` are ever touched, lib/meshDns.ts):
 *   iad1.tunnel.flagship.services   A/AAAA  the relay's dedicated addresses (its direct name: peers, hints, canary)
 *   tunnel.flagship.services        A/AAAA  the same (the balanced name boxes dial: TUNNEL_HUB_URL). One relay, so no
 *                                           load balancer: more relays later are more A/AAAA here (round-robin).
 *   _acme-challenge.<each name>     CNAME   the DNS-01 target Fly's certificate asks for (`flyctl certs add` first)
 * These explicit records are needed even though `*.flagship.services` already answers the relay: a challenge CNAME
 * under `tunnel.` makes `tunnel.` and `iad1.tunnel.` empty non-terminals, which the root wildcard no longer covers.
 *
 * The addresses come from `flyctl ips list -a flagship-services --json` (dedicated v4/v6 only) and must equal
 * SERVICES_PASSTHROUGH_IPV4/6 in apps/com/wrangler.toml (what zone-health and the phones' echo check expect); the
 * script refuses when they differ.
 *
 * Env: PROD_DNS_TOKEN or ~/.config/flagship/prod-dns-token (a Cloudflare API token with Zone.DNS:Edit on the
 * flagship.services zone only). The token is read, never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareZone, flyAcmeTarget, flyAddresses, formatPlan, planMeshDns, relayName, tunnelName } from "../tools/live-e2e/lib/meshDns.js";

export const PROD_APP = "flagship-services";
export const PROD_APEX = "flagship.services";
export const PROD_ZONE = "flagship.services";
export const PROD_RELAY_ID = "iad1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 16 << 20 }, (err, stdout) => {
      done({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

/** SERVICES_PASSTHROUGH_IPV4/6 from a wrangler.toml text. */
export function wranglerRelayAddresses(toml: string): { ipv4: string[]; ipv6: string[] } {
  const v = (k: string) => new RegExp(`^${k} *= *"([^"]+)"`, "m").exec(toml)?.[1];
  const v4 = v("SERVICES_PASSTHROUGH_IPV4");
  const v6 = v("SERVICES_PASSTHROUGH_IPV6");
  return { ipv4: v4 ? [v4] : [], ipv6: v6 ? [v6.toLowerCase()] : [] };
}

/** null when Fly's dedicated addresses equal wrangler.toml's, else the reason. */
export function addressMismatch(fly: { ipv4: string[]; ipv6: string[] }, repo: { ipv4: string[]; ipv6: string[] }): string | null {
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  if (repo.ipv4.length === 0) return "apps/com/wrangler.toml has no SERVICES_PASSTHROUGH_IPV4";
  if (!same(fly.ipv4, repo.ipv4) || !same(fly.ipv6, repo.ipv6)) {
    return `flyctl lists ${[...fly.ipv4, ...fly.ipv6].join(" ") || "nothing"}, apps/com/wrangler.toml says ${[...repo.ipv4, ...repo.ipv6].join(" ")}`;
  }
  return null;
}

function token(): string {
  const file = join(homedir(), ".config/flagship/prod-dns-token");
  const t = process.env.PROD_DNS_TOKEN || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (!t) throw new Error(`no Cloudflare DNS token: set PROD_DNS_TOKEN or write ${file} (Zone.DNS:Edit on ${PROD_ZONE})`);
  return t;
}

async function acmeTarget(host: string): Promise<string | null> {
  const x = await run("flyctl", ["certs", "show", host, "-a", PROD_APP, "--json"]);
  let target = x.code === 0 ? flyAcmeTarget(JSON.parse(x.stdout || "{}")) : null;
  // `certs show` can exit non-zero on a relay app (443 is raw TCP); `certs setup` still names the target.
  if (!target) {
    const s = await run("flyctl", ["certs", "setup", host, "-a", PROD_APP]);
    target = /_acme-challenge\.\S+\s+→\s+(\S+?)\.?\s*$/m.exec(s.stdout)?.[1] ?? null;
  }
  return target;
}

async function main(apply: boolean): Promise<void> {
  const ips = await run("flyctl", ["ips", "list", "-a", PROD_APP, "--json"]);
  if (ips.code !== 0) throw new Error(`flyctl ips list -a ${PROD_APP} failed (flyctl auth login?)`);
  const fly = flyAddresses(JSON.parse(ips.stdout || "[]"));
  const repo = wranglerRelayAddresses(readFileSync(join(ROOT, "apps/com/wrangler.toml"), "utf8"));
  const bad = addressMismatch(fly, repo);
  if (bad) throw new Error(`relay addresses disagree: ${bad}. Fix the repo or Fly first.`);
  const acme: Record<string, string> = {};
  for (const host of [relayName(PROD_RELAY_ID, PROD_APEX), tunnelName(PROD_APEX)]) {
    const t = await acmeTarget(host);
    if (t) acme[host] = t;
    else console.error(`  ${host}: no DNS-01 target yet: run \`flyctl certs add ${host} -a ${PROD_APP}\` first`);
  }
  const cf = new CloudflareZone(token());
  const existing = await cf.under(PROD_ZONE, tunnelName(PROD_APEX));
  const plan = planMeshDns(existing, { apex: PROD_APEX, relays: [{ relayId: PROD_RELAY_ID, ...fly }], balanced: true, acme });
  console.log(`${apply ? "Applying" : "Dry run (add --apply to write)"}: ${tunnelName(PROD_APEX)} in zone ${PROD_ZONE}`);
  for (const l of formatPlan(plan)) console.log(l);
  if (plan.create.length === 0 && plan.delete.length === 0) console.log("  nothing to change");
  if (apply) await cf.apply(PROD_ZONE, plan, (s) => console.log(`  ${s}`));
  if (Object.keys(acme).length < 2) process.exitCode = 3;
}

if (process.argv[1]?.endsWith("prod-mesh-dns.ts")) {
  main(process.argv.includes("--apply")).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
