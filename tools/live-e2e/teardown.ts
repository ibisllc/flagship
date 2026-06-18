#!/usr/bin/env -S npx tsx
/**
 * Teardown for the held webapp-sweep box (gym-results/feature-screenshots/box.json):
 * delete the Hetzner box (match name `flagship-gym-<user>-*`) AND its CF DNS
 * records (this user's subtree only). Confirms 0 boxes billing + records gone.
 *
 * Reads box.json for { user, fqdn, services, namePrefix }. Falls back to argv[2]
 * as the username if box.json is missing.
 *
 * Run: set -a; source .gym-secrets.env; set +a; npx tsx tools/live-e2e/teardown.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HCLOUD = process.env.GYM_HCLOUD_TOKEN || "";
const DNS_TOKEN = process.env.GYM_DNS_TOKEN || "";
const CF_ZONE = process.env.GYM_CF_ZONE_ID || "51f3bfe11a729db57effd70ed3cf9c77";
const SERVICES_DEFAULT = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";

function log(s: string): void {
  process.stdout.write(s + "\n");
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function http(url: string, opts: RequestInit = {}): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, text, json };
}

async function main(): Promise<void> {
  assert(HCLOUD, "GYM_HCLOUD_TOKEN required");
  assert(DNS_TOKEN, "GYM_DNS_TOKEN required");

  let user = process.argv[2] || "";
  let fqdn = "";
  let services = SERVICES_DEFAULT;
  try {
    const box = JSON.parse(
      readFileSync(join("gym-results", "feature-screenshots", "box.json"), "utf8"),
    );
    user = box.user || box.username || user;
    fqdn = box.fqdn || "";
    services = box.services || services;
  } catch {
    /* no box.json — use argv */
  }
  assert(user, "no user (no box.json and no argv username)");
  if (!fqdn) fqdn = `home.${user}.${services}`;
  const namePrefix = `flagship-gym-${user}-`;

  log(`[teardown] user=${user} fqdn=${fqdn}`);

  // ── Hetzner: delete the box ───────────────────────────────────────────────
  {
    const r = await http("https://api.hetzner.cloud/v1/servers?per_page=50", {
      headers: { authorization: `Bearer ${HCLOUD}` },
    });
    assert(r.status === 200, `hetzner list ${r.status}: ${r.text.slice(0, 120)}`);
    const srv = (r.json?.servers ?? []).find((s: any) => String(s.name).startsWith(namePrefix));
    if (!srv) {
      log(`  · no Hetzner box matching ${namePrefix}* (already gone?)`);
    } else {
      const d = await http(`https://api.hetzner.cloud/v1/servers/${srv.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${HCLOUD}` },
      });
      assert([200, 202, 204, 404].includes(d.status), `delete ${d.status}`);
      await new Promise((r) => setTimeout(r, 3000));
      const again = await http("https://api.hetzner.cloud/v1/servers?per_page=50", {
        headers: { authorization: `Bearer ${HCLOUD}` },
      });
      const still = (again.json?.servers ?? []).find((s: any) => String(s.name).startsWith(namePrefix));
      assert(!still, `box ${srv.name} still present after delete`);
      log(`  ✓ deleted Hetzner box ${srv.name} (id ${srv.id})`);
    }
  }

  // ── Cloudflare: delete this user's DNS records only ───────────────────────
  {
    const names = [fqdn, `*.${fqdn}`, `${user}.${services}`, `*.${user}.${services}`];
    let deleted = 0;
    for (const name of names) {
      const r = await http(
        `https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
        { headers: { authorization: `Bearer ${DNS_TOKEN}` } },
      );
      assert(r.status === 200, `cf list ${name} ${r.status}: ${r.text.slice(0, 120)}`);
      for (const rec of r.json?.result ?? []) {
        // Safety: only ever touch this user's subtree.
        assert(
          rec.name === fqdn ||
            rec.name === `*.${fqdn}` ||
            rec.name === `${user}.${services}` ||
            rec.name === `*.${user}.${services}`,
          `refusing to delete out-of-scope record ${rec.name}`,
        );
        const d = await http(
          `https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${rec.id}`,
          { method: "DELETE", headers: { authorization: `Bearer ${DNS_TOKEN}` } },
        );
        if (d.status === 200) deleted++;
        else log(`  · failed to delete ${rec.type} ${rec.name} (${d.status})`);
      }
    }
    // Re-list to confirm clean.
    const remaining: string[] = [];
    for (const name of names) {
      const r = await http(
        `https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
        { headers: { authorization: `Bearer ${DNS_TOKEN}` } },
      );
      for (const rec of r.json?.result ?? []) remaining.push(`${rec.type} ${rec.name}`);
    }
    assert(remaining.length === 0, `${deleted} deleted; still present: ${remaining.join(", ")}`);
    log(`  ✓ deleted ${deleted} CF DNS records; 0 remain for ${user}`);
  }

  log(`\n=== teardown complete: 0 boxes billing, DNS clean for ${user} ===`);
}

main().catch((e) => {
  log("teardown crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
