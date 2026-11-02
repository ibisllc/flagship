#!/usr/bin/env -S npx tsx
/**
 * DNS for the gym relay mesh (docs/runbooks/relay-mesh.md "Gym"): `<relayId>.tunnel.gym.flagship.services` at each
 * gym relay's addresses (DNS only) and, for the Fly relays, the `_acme-challenge` CNAME Fly's certificate asks for.
 * Dry run by default; `--apply` writes. Touches only names under `tunnel.<gym apex>` (lib/meshDns.ts).
 *
 *   npx tsx tools/live-e2e/gym-mesh-dns.ts [--apply] [--only gym-c] [--remove gym-c] [--balanced]
 *
 *   --only <id>      manage only this relay's names (repeatable)
 *   --remove <id>    delete this relay's names (a relay leaving: gym-relay-c.sh down does this for gym-c)
 *   --balanced       also write `tunnel.<apex>` as every managed relay's addresses (only when no load balancer owns
 *                    it; the gym's boxes dial TUNNEL_HUB_URL = gym-a's fly.dev name and do not need it)
 *
 * Where the addresses come from: gym-a and gym-b from `flyctl ips list --json` of their Fly apps, gym-c from
 * gym-relay-c.sh's state file. GYM_MESH_ADDRS="gym-x=1.2.3.4|2001:db8::1;..." overrides any of them.
 *
 * Env: GYM_DNS_TOKEN or ~/.config/flagship/gym-dns-token (Cloudflare, Zone.DNS:Edit on flagship.services),
 *      GYM_DNS_ZONE (default flagship.services), GYM_LIVE_SERVICES_APEX (default gym.flagship.services),
 *      GYM_RELAY_C_STATE (default ~/.config/flagship/gym-relay-c/state.json).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./lib/upcloudVm.js";
import { CloudflareZone, flyAcmeTarget, flyAddresses, formatPlan, planMeshDns, relayName, tunnelName, type MeshDnsRelay } from "./lib/meshDns.js";

export const GYM_RELAYS: Array<{ relayId: string; fly?: string }> = [
  { relayId: "gym-a", fly: "flagship-services-gym" },
  { relayId: "gym-b", fly: "flagship-services-gym-b" },
  { relayId: "gym-c" },
];

const APEX = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const ZONE = process.env.GYM_DNS_ZONE || "flagship.services";
export const RELAY_C_STATE = process.env.GYM_RELAY_C_STATE || join(homedir(), ".config/flagship/gym-relay-c/state.json");

export function dnsToken(): string {
  const file = join(homedir(), ".config/flagship/gym-dns-token");
  const t = process.env.GYM_DNS_TOKEN || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (!t) throw new Error(`no Cloudflare DNS token: set GYM_DNS_TOKEN or write ${file} (Zone.DNS:Edit on ${ZONE})`);
  return t;
}

function overrides(): Map<string, MeshDnsRelay> {
  const m = new Map<string, MeshDnsRelay>();
  for (const part of (process.env.GYM_MESH_ADDRS ?? "").split(";").filter(Boolean)) {
    const [id, list] = part.split("=");
    if (!id || !list) continue;
    const addrs = list.split("|").map((a) => a.trim()).filter(Boolean);
    m.set(id.trim(), { relayId: id.trim(), ipv4: addrs.filter((a) => !a.includes(":")), ipv6: addrs.filter((a) => a.includes(":")) });
  }
  return m;
}

async function addressesOf(r: { relayId: string; fly?: string }): Promise<MeshDnsRelay | null> {
  const o = overrides().get(r.relayId);
  if (o) return o;
  if (r.fly) {
    const x = await run("flyctl", ["ips", "list", "-a", r.fly, "--json"], 60_000);
    if (x.code !== 0) {
      console.error(`  ${r.relayId}: flyctl ips list -a ${r.fly} failed (${x.stderr.trim().slice(0, 120)}); skipped`);
      return null;
    }
    return { relayId: r.relayId, ...flyAddresses(JSON.parse(x.stdout || "[]")) };
  }
  if (!existsSync(RELAY_C_STATE)) {
    console.error(`  ${r.relayId}: no state at ${RELAY_C_STATE} (bash scripts/gym-relay-c.sh up first); skipped`);
    return null;
  }
  const s = JSON.parse(readFileSync(RELAY_C_STATE, "utf8")) as { ip?: string; ipv6?: string };
  return { relayId: r.relayId, ipv4: s.ip ? [s.ip] : [], ipv6: s.ipv6 ? [s.ipv6] : [] };
}

async function acmeOf(r: { relayId: string; fly?: string }): Promise<Record<string, string>> {
  if (!r.fly) return {};
  const host = relayName(r.relayId, APEX);
  const x = await run("flyctl", ["certs", "show", host, "-a", r.fly, "--json"], 60_000);
  let target = x.code === 0 ? flyAcmeTarget(JSON.parse(x.stdout || "{}")) : null;
  // `certs show` exits non-zero on a relay app (443 is raw TCP, no TLS handler); `certs setup` still names the target.
  if (!target) {
    const s = await run("flyctl", ["certs", "setup", host, "-a", r.fly], 60_000);
    target = /_acme-challenge\.\S+\s+→\s+(\S+?)\.?\s*$/m.exec(s.stdout)?.[1] ?? null;
  }
  if (!target) {
    console.error(`  ${r.relayId}: no DNS-01 target from \`flyctl certs show ${host} -a ${r.fly}\` (run \`flyctl certs add ${host} -a ${r.fly}\` first, or add the CNAME \`flyctl certs setup\` prints by hand)`);
    return {};
  }
  return { [host]: target };
}

export async function gymMeshDns(o: { apply: boolean; only?: string[]; remove?: string[]; balanced?: boolean; log?: (s: string) => void }): Promise<void> {
  const log = o.log ?? ((s: string) => console.log(s));
  const remove = o.remove ?? [];
  const chosen = GYM_RELAYS.filter((r) => (!o.only?.length || o.only.includes(r.relayId)) && !remove.includes(r.relayId));
  const relays: MeshDnsRelay[] = [];
  let acme: Record<string, string> = {};
  for (const r of chosen) {
    const a = await addressesOf(r);
    if (a) relays.push(a);
    acme = { ...acme, ...(await acmeOf(r)) };
  }
  const cf = new CloudflareZone(dnsToken());
  const existing = await cf.under(ZONE, tunnelName(APEX));
  const plan = planMeshDns(existing, { apex: APEX, relays, remove, balanced: o.balanced === true, acme });
  log(`${o.apply ? "Applying" : "Dry run (add --apply to write)"}: ${tunnelName(APEX)} in zone ${ZONE}`);
  for (const l of formatPlan(plan)) log(l);
  if (plan.create.length === 0 && plan.delete.length === 0) log("  nothing to change");
  if (o.apply) await cf.apply(ZONE, plan, (s) => log(`  ${s}`));
}

if (process.argv[1]?.endsWith("gym-mesh-dns.ts")) {
  const argv = process.argv.slice(2);
  const pick = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  gymMeshDns({ apply: argv.includes("--apply"), only: pick("--only"), remove: pick("--remove"), balanced: argv.includes("--balanced") }).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
