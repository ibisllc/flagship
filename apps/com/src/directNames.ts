/**
 * The Worker side of direct access (docs/direct-access-and-domains.md §6 step 3; the logic is control-plane
 * directAccess.ts): the direct zone's DNS client, the CAA account the names pin, the outside prober, and the cron
 * pass that reconciles the zone.
 *
 * The direct zone (`fshp.app`) has its own token (`CLOUDFLARE_DIRECT_DNS_API_TOKEN`, allowed only that zone) so the
 * services zone's token never writes it and the other way round. With no token or zone id nothing is published:
 * names stay pending until it is set.
 */
import {
  CloudflareDnsClient,
  LETS_ENCRYPT_PRODUCTION,
  reconcileDirectName,
  runDirectNamesPublish,
  type DirectAccessDeps,
  type DirectProber,
  type DirectZoneDns,
  type PublishDeps,
} from "@flagship/control-plane";
import type { D1Database, Storage } from "@flagship/storage";

export interface DirectNamesEnv {
  DB?: D1Database;
  CLOUDFLARE_DIRECT_DNS_API_TOKEN?: string;
  CLOUDFLARE_DIRECT_ZONE_ID?: string;
  /** Default `fshp.app`. */
  DIRECT_APEX?: string;
  /** The ACME account URL the names' CAA pins; default: the issuance service's own account. */
  DIRECT_CAA_ACCOUNT_URI?: string;
  ISSUANCE_ACME_DIRECTORY?: string;
}

type DirectStorage = Pick<Storage, "usernames" | "servers" | "directAccess" | "deviceCapabilityGrants">;

export function directAccessDeps(env: DirectNamesEnv, storage: DirectStorage): DirectAccessDeps {
  return {
    usernames: storage.usernames,
    servers: storage.servers,
    directAccess: storage.directAccess,
    grants: storage.deviceCapabilityGrants,
    ...(env.DIRECT_APEX ? { directApex: env.DIRECT_APEX } : {}),
  };
}

export function directZoneDns(env: DirectNamesEnv): DirectZoneDns | null {
  if (!env.CLOUDFLARE_DIRECT_DNS_API_TOKEN || !env.CLOUDFLARE_DIRECT_ZONE_ID) return null;
  return new CloudflareDnsClient({ apiToken: env.CLOUDFLARE_DIRECT_DNS_API_TOKEN, zoneId: env.CLOUDFLARE_DIRECT_ZONE_ID });
}

/** The issuance service's ACME account URL (it records it on first use), or the configured override. */
export async function directCaaAccountUri(env: DirectNamesEnv): Promise<string | null> {
  if (env.DIRECT_CAA_ACCOUNT_URI) return env.DIRECT_CAA_ACCOUNT_URI;
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT account_url FROM issuance_acme_accounts WHERE directory = ? ORDER BY created_at DESC LIMIT 1")
    .bind(env.ISSUANCE_ACME_DIRECTORY || LETS_ENCRYPT_PRODUCTION)
    .first<{ account_url: string }>();
  return row?.account_url ?? null;
}

async function publishDeps(env: DirectNamesEnv, storage: DirectStorage, dns?: DirectZoneDns | null): Promise<PublishDeps | null> {
  const zone = dns ?? directZoneDns(env);
  if (!zone) return null;
  return { ...directAccessDeps(env, storage), dns: zone, caaAccountUri: await directCaaAccountUri(env) };
}

/**
 * After an order or an address update: reconcile that account's pending names now (in the background), so a name
 * reaches the zone without waiting for the cron. A failure leaves the name pending for the cron.
 */
export async function publishPendingNow(env: DirectNamesEnv, storage: DirectStorage, username: string, dns?: DirectZoneDns | null): Promise<void> {
  const deps = await publishDeps(env, storage, dns);
  if (!deps) return;
  const rows = (await storage.directAccess.listNamesForUser(username)).filter((r) => r.publishState === "pending").slice(0, 4);
  for (const row of rows) await reconcileDirectName(deps, row);
}

/** The cron job "direct-names". */
export async function runDirectNamesCron(env: DirectNamesEnv, storage: DirectStorage, dns?: DirectZoneDns | null): Promise<{ reconciled: number; failed: number } | null> {
  const deps = await publishDeps(env, storage, dns);
  return deps ? runDirectNamesPublish(deps) : null;
}

const PROBE_TIMEOUT_MS = 8_000;

/**
 * The outside probe from the Worker: an HTTPS request to the published name, which resolves through the direct
 * zone to the owner's addresses. The Worker's TLS checks the certificate against the name, so only an answer from
 * a holder of a valid certificate counts. Any HTTP status means the box answered.
 */
export function fetchProber(fetchImpl: typeof fetch = fetch): DirectProber {
  return {
    async https(fqdn, port) {
      const url = `https://${fqdn}${port === 443 ? "" : `:${port}`}/`;
      try {
        const res = await fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { ok: true, status: res.status };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      }
    },
  };
}
