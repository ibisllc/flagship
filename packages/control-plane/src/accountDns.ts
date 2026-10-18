import {
  CHALLENGE_PREFIX,
  legacyAccountRecords,
  rootWildcardName,
  rootWildcardStatus,
  boxRecordNames,
  isProtectedDnsUser,
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
 * Never touches a protected account (the store-review demo keeps its explicit
 * records exactly as they are).
 *
 * Caveat, by design: this runs inside the Worker (Free plan: ~10 ms CPU and ~50
 * subrequests), so it does not wait between deletions. Cloudflare shows a
 * deleted record to its two name servers up to ~15 s apart and not always in
 * order (measured, docs/wildcard-dns.md section 9.5), so for up to ~15 s after a
 * legacy account's first registration a name under it can answer NXDOMAIN at a
 * lagging server, and a resolver that asks then caches it for 30 minutes. It
 * happens once per legacy account (a new account owns no record), and the
 * pre-GA scrub removes every legacy account but the store-review demo. The reap
 * CLI, which can wait, deletes one rank group at a time instead.
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
    if (isProtectedDnsUser(user)) return out;
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
 * per record; returns how many were deleted. Not guarded by the root wildcard:
 * nobody is left to resolve these names. Never touches a protected account.
 *
 * Order: the records AT `<user>` first (CAA, AAAA, A), `*.<user>` last, the
 * same safe order as {@link clearLegacyAccountDns}: while `*.<user>` stays,
 * every name under the account still answers. (Cloudflare shows deletions to
 * its name servers a few seconds apart and not always in order; for a gone
 * account that does not matter.)
 */
export async function removeAccountDns(client: DnsDeleteClient, userZone: string): Promise<number> {
  const user = userZone.split(".")[0] ?? "";
  if (isProtectedDnsUser(user)) return 0;
  const wild = `*.${userZone}`;
  let deleted = 0;
  for (const name of [userZone, wild]) {
    for (const type of ["CAA", "AAAA", "A"]) {
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
 * Delete the per-box A/AAAA/CAA older builds published for a box (and an old
 * challenge shield), `<box>` before `*.<box>`. Best-effort; returns how many
 * were deleted. Never touches a protected account's box.
 */
export async function removeBoxDns(client: DnsDeleteClient, serverDomain: string): Promise<number> {
  if (isProtectedDnsUser(serverDomain.split(".")[1] ?? "")) return 0;
  let deleted = 0;
  for (const name of boxRecordNames(serverDomain)) {
    for (const type of ["CAA", "AAAA", "A"]) {
      try {
        deleted += await client.deleteByName(name, type);
      } catch {
        // best-effort
      }
    }
  }
  return deleted;
}
