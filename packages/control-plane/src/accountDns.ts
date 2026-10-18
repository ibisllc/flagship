import {
  CHALLENGE_PREFIX,
  legacyAccountRecords,
  rootWildcardName,
  rootWildcardStatus,
  shieldNames,
  userZoneOf,
  type ZoneRecordView,
} from "@flagship/services-zone";
import type { DnsDeleteClient } from "./cloudflareDns.js";

/**
 * The control plane's half of the ROOT-WILDCARD DNS layout
 * (docs/wildcard-dns.md). The zone holds ONE `*.<apex>` A/AAAA pair at the
 * relay and one apex CAA pair, both created once by hand, and nothing per
 * account or per box: every `<server>.<user>`, `<service>.<server>.<user>` and
 * `<svc>.<user>` name resolves by wildcard synthesis. `.com` therefore writes
 * no address or CAA record for anybody. The only records it ever creates are
 * the short-lived `_acme-challenge` TXT of the box's signed dns-01 flow.
 *
 * What is left here is cleaning up after the older layouts. A record at an
 * account or box name (the per-account `*.<user>` pair and CAA, the per-box
 * pairs, a challenge shield) stops the root wildcard for the names below it,
 * so each is removed: when an auth code is issued, a box registers, a server
 * is un-revoked or transferred (`clearLegacyAccountDns`), when a server or
 * account goes (`removeBoxDns`, `removeAccountDns`), hourly for the whole zone
 * (`CloudflareDnsClient.deleteLegacyAccountRecords`) and by the reap tool.
 *
 * Nothing is deleted before the root wildcard is in the zone and points at the
 * relay: an account's own records may be all that resolve its names until then.
 */

/** Where the relay answers; what the root wildcard must point at. */
export interface RelayAddress {
  servicesIpv4: string;
  servicesIpv6?: string;
}

/** What the legacy cleanup needs from the zone; `CloudflareDnsClient` satisfies it. */
export interface LegacyDnsClient {
  listAll(): Promise<ZoneRecordView[]>;
  deleteById(id: string): Promise<boolean>;
}

export interface AccountDnsDeps extends RelayAddress {
  client: LegacyDnsClient;
}

export interface LegacyClearResult {
  /** Records deleted. */
  removed: number;
  names: string[];
  /** Why nothing was deleted although legacy records exist. */
  skipped?: "root-wildcard-not-ready";
  error?: string;
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

/**
 * Remove the records an earlier layout wrote for one account (A, AAAA and CAA
 * at `<user>`, `*.<user>`, `<box>.<user>`, `*.<box>.<user>`), in an order that
 * never darkens a name. Idempotent, safe to run concurrently (a record another
 * caller deleted first is simply gone), and a no-op until the root wildcard is
 * in the zone. Never throws: the caller's own work has already committed.
 */
export async function clearLegacyAccountDns(
  deps: AccountDnsDeps,
  userZone: string,
): Promise<LegacyClearResult> {
  const out: LegacyClearResult = { removed: 0, names: [] };
  try {
    const dot = userZone.indexOf(".");
    if (dot <= 0) return out;
    const user = userZone.slice(0, dot);
    const apex = userZone.slice(dot + 1);
    const records = await deps.client.listAll();
    const mine = legacyAccountRecords(records, apex, { user });
    if (mine.length === 0) return out;
    if (!rootWildcardStatus(records, apex, deps).ready) {
      out.skipped = "root-wildcard-not-ready";
      return out;
    }
    for (const r of mine) {
      if (!r.id) continue;
      try {
        if (await deps.client.deleteById(r.id)) {
          out.removed += 1;
          out.names.push(r.name);
        }
      } catch (e) {
        out.error ??= String((e as Error).message ?? e);
      }
    }
  } catch (e) {
    out.error = String((e as Error).message ?? e);
  }
  return out;
}

/**
 * Delete the legacy records of an account that is gone (its own names, plus the
 * `*.<user>` CAA and the plain A/AAAA/CAA at `<user>`). By name, best-effort
 * per record; returns how many were deleted. Not guarded: nobody is left to
 * resolve these names.
 */
export async function removeAccountDns(client: DnsDeleteClient, userZone: string): Promise<number> {
  const wild = `*.${userZone}`;
  let deleted = 0;
  for (const name of [wild, userZone]) {
    for (const type of ["A", "AAAA", "CAA"]) {
      try {
        deleted += await client.deleteByName(name, type);
      } catch {
        // best-effort: the caller's own work has already committed
      }
    }
  }
  return deleted;
}

/**
 * Delete the per-box A/AAAA/CAA older builds published for a box (and a shield
 * that was never released). Best-effort; returns how many were deleted.
 */
export async function removeBoxDns(client: DnsDeleteClient, serverDomain: string): Promise<number> {
  let deleted = 0;
  for (const name of shieldNames(serverDomain, true)) {
    for (const type of ["A", "AAAA", "CAA"]) {
      try {
        deleted += await client.deleteByName(name, type);
      } catch {
        // best-effort
      }
    }
  }
  return deleted;
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
 * no challenge TXT may remain; the zone's root wildcard `*.<apex>` must exist
 * with the relay's address (the shield looks exactly like a legacy per-box
 * record, and one is only removed while the wildcard answers for the name);
 * and only records carrying the relay's address are deleted. After deleting it looks again, and puts the shield back if a
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
  const wild = rootWildcardName(apex);
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
