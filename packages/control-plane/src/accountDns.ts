import {
  accountWildcardName,
  shieldNames,
  userZoneOf,
  CHALLENGE_PREFIX,
  type CaRestrictionCaaOptions,
} from "@flagship/services-zone";
import type { AuthCodeStorage, ServerStorage } from "@flagship/storage";
import { publishUserZoneCaa, type CaaUpsertClient } from "./caaPublish.js";
import type { DnsDeleteClient } from "./cloudflareDns.js";
import type { DnsUpsertClient } from "./serverRegister.js";

/**
 * The control plane's half of the ONE-WILDCARD-PER-ACCOUNT DNS layout
 * (docs/wildcard-dns.md). Steady state, an account owns four records in the
 * `flagship.services` zone and nothing per box:
 *
 *   `*.<user>`  A + AAAA   -> the relay (every box, service and tier-2 name)
 *   `<user>`    CAA issue + issuewild "letsencrypt.org"
 *
 * They are created idempotently whenever the account is about to need them
 * (auth-code issue, registration, un-revoke, transfer, republish) and removed
 * when the account's last live server goes. While a DNS-01 challenge TXT
 * exists, a short-lived "shield" keeps the box's names answering (an
 * `_acme-challenge.X` record makes `X` an empty non-terminal, which stops the
 * wildcard answering for `X` and below).
 */

/** Where the relay answers; what every account record points at. */
export interface RelayAddress {
  servicesIpv4: string;
  servicesIpv6?: string;
}

export interface AccountDnsDeps extends RelayAddress {
  client: DnsUpsertClient;
  /**
   * CAA-capable client (the direct `CloudflareDnsClient`; the broker has no
   * CAA RPC). Best-effort: a CAA failure never fails the caller.
   */
  caa?: { client: CaaUpsertClient; options?: CaRestrictionCaaOptions };
}

export interface AccountDnsResult {
  dnsPublished: { type: string; name: string; content: string }[];
  dnsError?: string;
  caaPublished: { name: string; rdata: string }[];
  caaError?: string;
}

/**
 * `<user>.<apex>` of a registered server domain `<server>.<user>.<apex>`,
 * apex-agnostic: drop the first label. Null unless at least three labels.
 */
export function accountZoneOfServerDomain(serverDomain: string): string | null {
  const lower = serverDomain.toLowerCase().replace(/\.$/, "");
  const dot = lower.indexOf(".");
  if (dot <= 0) return null;
  const zone = lower.slice(dot + 1);
  return zone.split(".").length >= 3 ? zone : null;
}

/** Create the account's records (idempotent). Never throws. */
export async function ensureAccountDns(
  deps: AccountDnsDeps,
  userZone: string,
): Promise<AccountDnsResult> {
  const out: AccountDnsResult = { dnsPublished: [], caaPublished: [] };
  const name = accountWildcardName(userZone);
  try {
    const a = await deps.client.upsert({ name, type: "A", content: deps.servicesIpv4 });
    out.dnsPublished.push({ type: "A", name, content: a.content });
    if (deps.servicesIpv6) {
      const aaaa = await deps.client.upsert({ name, type: "AAAA", content: deps.servicesIpv6 });
      out.dnsPublished.push({ type: "AAAA", name, content: aaaa.content });
    }
  } catch (e) {
    out.dnsError = String((e as Error).message ?? e);
  }
  if (deps.caa) {
    try {
      out.caaPublished = await publishUserZoneCaa({
        client: deps.caa.client,
        userZone,
        options: deps.caa.options,
      });
    } catch (e) {
      out.caaError = String((e as Error).message ?? e);
    }
  }
  return out;
}

/**
 * Delete the account's records, plus the `*.<user>` CAA older builds wrote.
 * Best-effort per record; returns how many were deleted.
 */
export async function removeAccountDns(client: DnsDeleteClient, userZone: string): Promise<number> {
  const wild = accountWildcardName(userZone);
  const targets: Array<[string, string]> = [
    [wild, "A"],
    [wild, "AAAA"],
    [wild, "CAA"],
    [userZone, "CAA"],
  ];
  let deleted = 0;
  for (const [name, type] of targets) {
    try {
      deleted += await client.deleteByName(name, type);
    } catch {
      // best-effort: the caller's own work has already committed
    }
  }
  return deleted;
}

/**
 * Delete the per-box A/AAAA pair older builds published for a box (and a
 * shield that was never released). Best-effort; returns how many were deleted.
 */
export async function removeBoxDns(client: DnsDeleteClient, serverDomain: string): Promise<number> {
  let deleted = 0;
  for (const name of shieldNames(serverDomain, true)) {
    for (const type of ["A", "AAAA"]) {
      try {
        deleted += await client.deleteByName(name, type);
      } catch {
        // best-effort
      }
    }
  }
  return deleted;
}

export interface AccountUse {
  servers: Pick<ServerStorage, "listForUser">;
  /** When given, an install order in flight (an unexpired active auth code) also keeps the account's DNS. */
  authCodes?: Pick<AuthCodeStorage, "listOutstandingByUsername">;
  now?: () => number;
}

/** Does the account have a live server, or an install in flight? */
export async function accountInUse(use: AccountUse, username: string): Promise<boolean> {
  const servers = await use.servers.listForUser(username);
  if (servers.some((s) => !s.revokedAt)) return true;
  if (use.authCodes) {
    const now = (use.now ?? Date.now)();
    const codes = await use.authCodes.listOutstandingByUsername(username, now);
    if (codes.length > 0) return true;
  }
  return false;
}

/**
 * Make the account's records match whether the account is in use. In use:
 * ensure them (when `publish` is given). Not in use: remove them, then look
 * again and put them back if a registration slipped in while we deleted.
 * Returns what ended up true and how many records were deleted.
 */
export async function reconcileAccountDns(args: {
  use: AccountUse;
  username: string;
  userZone: string;
  remover: DnsDeleteClient;
  publish?: AccountDnsDeps;
}): Promise<{ state: "kept" | "removed" | "healed"; deleted: number }> {
  const keep = async (): Promise<void> => {
    if (args.publish) await ensureAccountDns(args.publish, args.userZone);
  };
  if (await accountInUse(args.use, args.username)) {
    await keep();
    return { state: "kept", deleted: 0 };
  }
  const deleted = await removeAccountDns(args.remover, args.userZone);
  if (await accountInUse(args.use, args.username)) {
    await keep();
    return { state: "healed", deleted };
  }
  return { state: "removed", deleted };
}

// ── Challenge shield ───────────────────────────────────────────────────────

export interface ShieldRecord {
  id: string;
  content: string;
}

/** What the shield needs from the zone; `CloudflareDnsClient` satisfies it. */
export interface ShieldDns {
  upsert(opts: {
    name: string;
    type: "A" | "AAAA";
    content: string;
    ttl?: number;
  }): Promise<unknown>;
  list(name: string, type?: string): Promise<ShieldRecord[]>;
  deleteById(id: string): Promise<boolean>;
}

/**
 * Put the shield next to a challenge TXT about to be written at
 * `_acme-challenge.<host>`: A (and AAAA) at `<host>`, and at `*.<host>` for a
 * box (`withWildcard`). They answer exactly what the account wildcard would,
 * so a resolver sees no change; they only keep `<host>` from going dark while
 * it is an empty non-terminal. Idempotent.
 */
export async function ensureChallengeShield(
  dns: ShieldDns,
  relay: RelayAddress,
  host: string,
  withWildcard: boolean,
): Promise<void> {
  for (const name of shieldNames(host, withWildcard)) {
    await dns.upsert({ name, type: "A", content: relay.servicesIpv4 });
    if (relay.servicesIpv6) await dns.upsert({ name, type: "AAAA", content: relay.servicesIpv6 });
  }
}

/**
 * Take the shield down once the last challenge TXT at `_acme-challenge.<host>`
 * is gone. Three guards keep it from ever removing something that matters:
 * no challenge TXT may remain; the account's `*.<user>` wildcard must exist
 * with the relay's address (so what the shield looked like can be a legacy
 * per-box record an account still relies on, and is then left alone); and only
 * records carrying the relay's address are deleted (a box on its own IP keeps
 * its records). After deleting it looks again, and puts the shield back if a
 * new challenge arrived meanwhile. Returns how many records it deleted.
 */
export async function releaseChallengeShield(
  dns: ShieldDns,
  relay: RelayAddress,
  host: string,
  apex: string,
): Promise<number> {
  const challenge = `${CHALLENGE_PREFIX}${host}`;
  if ((await dns.list(challenge, "TXT")).length > 0) return 0;
  const zone = userZoneOf(host, apex);
  if (!zone) return 0;
  const wild = accountWildcardName(zone);
  const wildA = await dns.list(wild, "A");
  if (!wildA.some((r) => r.content === relay.servicesIpv4)) return 0;
  if (relay.servicesIpv6) {
    const wildAaaa = await dns.list(wild, "AAAA");
    if (!wildAaaa.some((r) => r.content === relay.servicesIpv6)) return 0;
  }
  let deleted = 0;
  for (const name of shieldNames(host, true)) {
    for (const [type, content] of [
      ["A", relay.servicesIpv4],
      ["AAAA", relay.servicesIpv6],
    ] as const) {
      if (!content) continue;
      for (const r of await dns.list(name, type)) {
        if (r.content === content && (await dns.deleteById(r.id))) deleted += 1;
      }
    }
  }
  if (deleted > 0 && (await dns.list(challenge, "TXT")).length > 0) {
    // A new challenge arrived while we were deleting: shield it again.
    await ensureChallengeShield(dns, relay, host, true);
  }
  return deleted;
}
