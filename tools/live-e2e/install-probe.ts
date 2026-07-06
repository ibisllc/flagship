#!/usr/bin/env -S npx tsx
/**
 * Debug probe: install ONE service on a gym box via the real owner-IRK daemon
 * path and LEAVE it installed, so we can SSH in and inspect the daemon's actual
 * container + app-proxy hop (root-causing the serve 502). Does NOT uninstall.
 *
 *   GYM_ADMIN_SECRET=… GYM_DEMO_IRK_KEK=… LIVE_E2E_REUSE_USER=gymdbg \
 *     npx tsx tools/live-e2e/install-probe.ts [--port 80|8080] [--uninstall]
 */
import { deriveDemoUserIrk } from "@flagship/control-plane";
import { signInstallService, signUninstallService, type InstallServiceRequest, type UninstallServiceRequest } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const user = process.env.LIVE_E2E_REUSE_USER || "gymdbg";
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 80);
const doUninstall = process.argv.includes("--uninstall");
const fqdn = `home.${user}.${SERVICES}`;
const slug = "probe";

async function http(url: string, opts: RequestInit, ms = 90000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  if (!KEK) throw new Error("GYM_DEMO_IRK_KEK required");
  const irk = deriveDemoUserIrk(hexToBytes(KEK), user);
  const serviceId = `${user}-${slug}`;

  if (doUninstall) {
    const req: UninstallServiceRequest = { serverId: fqdn, creator: user, slug, issuedAt: Date.now() };
    const sig = bytesToHex(signUninstallService(req, irk));
    const r = await http(`https://${fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }),
    }, 60000);
    console.log(`uninstall ${slug}: ${r.status} ${r.text.slice(0, 120)}`);
    return;
  }

  const manifest = JSON.stringify({
    schema_version: 1, name: slug, version: "0.1.0", description: "serve probe",
    runtime: { image: "traefik/whoami", port }, data: {},
    network: { subdomain: slug }, access: { enabled: true, public_routes: ["/"] },
    migration: { verification: "standard" },
  });
  const req: InstallServiceRequest = { serverId: fqdn, creator: user, slug, manifestJson: manifest, addOwnerToMembership: true, issuedAt: Date.now() };
  const sig = bytesToHex(signInstallService(req, irk));
  const r = await http(`https://${fqdn}/api/services`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }),
  }, 120000);
  console.log(`install ${slug} (port ${port}): ${r.status}`);
  console.log(`  body: ${r.text.slice(0, 300)}`);
  const list = await http(`https://${fqdn}/api/services`, {}, 20000);
  console.log(`  /api/services: ${list.text.slice(0, 400)}`);
  // External serve probe (through the hub → box TLS → app-proxy → container)
  const serve = await http(`https://${slug}.${fqdn}/`, {}, 15000).catch((e) => ({ status: 0, text: String(e) }));
  console.log(`  serve https://${slug}.${fqdn}/ → ${serve.status}  ${String(serve.text).replace(/\s+/g, " ").slice(0, 80)}`);
}

main().catch((e) => { console.error("probe failed:", e instanceof Error ? e.message : e); process.exit(1); });
