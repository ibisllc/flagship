import {
  CHALLENGE_PREFIX,
  legacyAccountRecords,
  rootWildcardName,
  rootWildcardStatus,
  boxRecordNames,
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
 * pairs, an old challenge shield) stops the root wildcard for the names below it,
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
 * Delete the per-box A/AAAA/CAA older builds published for a box (and an old challenge shield). Best-effort; returns how many were deleted.
 */
export async function removeBoxDns(client: DnsDeleteClient, serverDomain: string): Promise<number> {
  let deleted = 0;
  for (const name of boxRecordNames(serverDomain)) {
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
