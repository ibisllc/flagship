/**
 * Name arithmetic for the ONE-WILDCARD-PER-ACCOUNT DNS layout
 * (docs/wildcard-dns.md).
 *
 * Per account the zone holds, steady state, four records: `*.<user>` A and
 * AAAA (every box, service and tier-2 name resolves through them by wildcard
 * synthesis) and two CAA at `<user>`. No per-box records. While a DNS-01
 * challenge TXT exists at `_acme-challenge.X`, `X` is an empty non-terminal
 * and the wildcard stops answering for `X` and everything below it, so the
 * control plane puts a short-lived "shield" (A/AAAA at `X`, and at `*.X` for a
 * box) next to the TXT. These helpers only compute names; nothing here talks
 * to a zone.
 */

export const CHALLENGE_PREFIX = "_acme-challenge.";

/** Records one account holds in steady state (A + AAAA wildcard, CAA issue + issuewild). */
export const ACCOUNT_RECORD_COUNT = 4;

const USER_LABEL_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * `<user>.<apex>` for any name of the form `[<label>.]*<user>.<apex>` with at
 * least one label ahead of the user (a box `<server>.<user>.<apex>` or a
 * tier-2 service `<svc>.<user>.<apex>`). Parsed apex-relative: the user is the
 * LAST label left once the apex is stripped, so a deeper apex such as
 * `gym.flagship.services` still yields the right account. Null on any other
 * shape.
 */
export function userZoneOf(fqdn: string, apex = "flagship.services"): string | null {
  const lower = fqdn.toLowerCase().replace(/\.$/, "");
  const suffix = `.${apex.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return null;
  const parts = lower.slice(0, -suffix.length).split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!USER_LABEL_RE.test(user)) return null;
  return `${user}.${apex.toLowerCase()}`;
}

/** The account wildcard's record name. */
export function accountWildcardName(userZone: string): string {
  return `*.${userZone}`;
}

/** `_acme-challenge.<host>` -> `<host>`; null for anything else. */
export function challengeHostOf(recordName: string): string | null {
  const lower = recordName.toLowerCase().replace(/\.$/, "");
  if (!lower.startsWith(CHALLENGE_PREFIX)) return null;
  const host = lower.slice(CHALLENGE_PREFIX.length);
  return host.length > 0 && !host.includes("*") && !host.startsWith("_") ? host : null;
}

/** The names a shield occupies: `<host>` always, `*.<host>` too for a box. */
export function shieldNames(host: string, withWildcard: boolean): string[] {
  return withWildcard ? [host, `*.${host}`] : [host];
}
