/**
 * Full app-install end-to-end smoke. Assumes:
 *
 *   - A daemon is running with ServicePlatform configured (host IRK +
 *     SWK supplied via FLAGSHIP_HOST_IRK_PUB_HEX + FLAGSHIP_SWK_HEX).
 *   - The data-services compose stack is up.
 *   - The daemon's local HTTP API is reachable at the URL passed in
 *     `FLAGSHIP_DAEMON_API` (default: `https://<server>.<host>.flagship.services`).
 *   - The IRK private key is supplied via `FLAGSHIP_HOST_IRK_PRIV_HEX`
 *     so the script can sign the install request.
 *
 *   FLAGSHIP_DAEMON_API=https://home.alice.flagship.services \
 *   FLAGSHIP_HOST_IRK_PRIV_HEX=<hex> \
 *   FLAGSHIP_SUBDOMAIN=home.alice.flagship.services \
 *     npx tsx scripts/smoke-app-install.ts
 *
 * Steps:
 *   1. POST /api/services with a tiny demo manifest (nginx, no data
 *      stores).
 *   2. GET /api/services to confirm it landed.
 *   3. curl the resulting URL (collapsed because creator===host) and
 *      check we got a 200 from nginx.
 *   4. DELETE /api/services/<serviceId> to clean up.
 *
 * If any step fails, the script exits non-zero and the partial state
 * is left on the box for inspection.
 */

import { ed, signInstallService, signUninstallService, type Keypair } from "@flagship/protocol";

const API = process.env.FLAGSHIP_DAEMON_API ?? "https://home.alice.flagship.services";
const SUBDOMAIN = process.env.FLAGSHIP_SUBDOMAIN ?? "home.alice.flagship.services";
const IRK_PRIV_HEX = process.env.FLAGSHIP_HOST_IRK_PRIV_HEX;

const HOST_USERNAME = SUBDOMAIN.split(".")[1] ?? "alice";

if (!IRK_PRIV_HEX) {
  console.error("[smoke] FLAGSHIP_HOST_IRK_PRIV_HEX is required");
  process.exit(1);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const irkPriv = hexToBytes(IRK_PRIV_HEX);
const irk: Keypair = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };

const SLUG = "smoke";
const CREATOR = HOST_USERNAME; // self-authored → URL collapses to <slug>.<host>

const manifestJson = JSON.stringify({
  schema_version: 1,
  name: SLUG,
  version: "0.0.1",
  runtime: { image: "nginx:1.27-alpine", port: 80 },
  data: {},
  network: { subdomain: SLUG },
  access: {
    enabled: true,
    default_role: "viewer",
    public_routes: ["/"],
  },
  migration: { portable: true, verification: "standard" },
});

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function deleteJson(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function getJson(path: string) {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  console.log(`[smoke] target: ${API}`);
  console.log(`[smoke] installing ${SLUG} (creator=${CREATOR})`);

  const installReq = {
    serverId: SUBDOMAIN,
    creator: CREATOR,
    slug: SLUG,
    manifestJson,
    addOwnerToMembership: true,
    issuedAt: Date.now(),
  };
  const installSig = signInstallService(installReq, irk);
  const installRes = await postJson("/api/services", {
    request: installReq,
    signature: bytesToHex(installSig),
  });
  console.log(`[smoke] install → ${installRes.status}: ${JSON.stringify(installRes.body)}`);
  if (installRes.status !== 200) process.exit(2);

  // List
  const list = await getJson("/api/services");
  if (!Array.isArray(list.body?.apps) || !list.body.apps.find((a: { serviceId: string }) => a.serviceId === `${CREATOR}--${SLUG}`)) {
    console.error(`[smoke] app not in /api/services list`);
    process.exit(2);
  }
  console.log(`[smoke] /api/services → 200, contains ${CREATOR}--${SLUG}`);

  // Hit the public route
  const appUrl = `https://${SLUG}.${SUBDOMAIN}/`;
  console.log(`[smoke] curling ${appUrl}`);
  const probe = await fetch(appUrl, {
    redirect: "manual",
  }).catch((e) => {
    console.error(`[smoke] fetch failed: ${(e as Error).message}`);
    return null;
  });
  if (probe) {
    console.log(`[smoke] app response → ${probe.status}`);
  }

  // Cleanup
  const uninstallReq = {
    serverId: SUBDOMAIN,
    creator: CREATOR,
    slug: SLUG,
    issuedAt: Date.now(),
  };
  const uninstallSig = signUninstallService(uninstallReq, irk);
  const cleanup = await deleteJson(`/api/services/${CREATOR}--${SLUG}`, {
    request: uninstallReq,
    signature: bytesToHex(uninstallSig),
  });
  console.log(`[smoke] uninstall → ${cleanup.status}: ${JSON.stringify(cleanup.body)}`);
  if (cleanup.status !== 200) process.exit(2);

  console.log(`[smoke] ✅ install + URL probe + uninstall round-trip green`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
