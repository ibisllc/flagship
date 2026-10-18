#!/usr/bin/env node
/**
 * dns-zone-health: read-only check that the `flagship.services` zone is in the
 * root-wildcard layout (docs/wildcard-dns.md). Reads
 * GET /api/admin/reap/zone-health (apps/com/src/prodReap.ts).
 *
 *   npm run zone-health                run the check; exit 0 when healthy
 *   npm run zone-health -- --json      the raw report
 *
 * It fails (exit 1) when `*.flagship.services` A/AAAA is missing, not exactly the
 * relay's address, or proxied; when the apex CAA pair (`issue` and `issuewild`
 * "letsencrypt.org") is missing or allows another CA; or when ANY record sits at
 * an account or box name (each one is listed with its id; the reap tool trims
 * them). Run it after the manual DNS step in docs/runbooks/final-deploy.md and
 * about weekly. Exit 2 means it could not run (no secret, 401/403, 503).
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default
 * https://flagshipserver.com).
 */

import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const opts = { json: false };
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function formatHealth(h) {
  const lines = [];
  lines.push(`Zone health for ${h.apex} (${h.generatedAt})`);
  lines.push(`  records: ${h.records} of ${h.cap}; at rest ${h.atRest}; challenges in flight ${h.challenges}`);
  lines.push(`  relay: ${h.relay.servicesIpv4}${h.relay.servicesIpv6 ? `, ${h.relay.servicesIpv6}` : " (no IPv6)"}`);
  const w = h.rootWildcard;
  lines.push(`  *.${h.apex}: A ${w.a}, AAAA ${w.aaaa}${w.proxied ? ", PROXIED" : ""}`);
  lines.push("");
  if (h.ok) {
    lines.push("OK: the zone is in the root-wildcard layout.");
  } else {
    lines.push(`NOT OK: ${h.problems.length} problem${h.problems.length === 1 ? "" : "s"}`);
    for (const p of h.problems) lines.push(`  - ${p.message}${p.id ? `  [${p.id}]` : ""}`);
    lines.push("");
    lines.push("Missing wildcard or CAA: add it in Cloudflare (docs/runbooks/final-deploy.md, DNS section).");
    lines.push("Records at account or box names: `npm run reap-orphans` plans their removal.");
  }
  if (h.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const m of h.warnings) lines.push(`  - ${m}`);
  }
  return lines.join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log("usage: node scripts/dns-zone-health.mjs [--json]");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");
  const res = await fetch(`${base}/api/admin/reap/zone-health`, { headers: { "x-admin-secret": secret } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (res.status !== 200) {
    console.error(`${res.status} from ${base}: ${body?.error ?? "unexpected answer"}`);
    process.exit(2);
  }
  console.log(opts.json ? JSON.stringify(body, null, 2) : formatHealth(body));
  process.exit(body.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
