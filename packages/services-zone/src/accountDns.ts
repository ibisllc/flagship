/**
 * Name arithmetic for the ROOT-WILDCARD DNS layout (docs/wildcard-dns.md; the
 * record rules are in `rootWildcard.ts`). The zone holds one wildcard pair and
 * one CAA pair at the apex and nothing per account or box; these helpers only
 * compute names, nothing here talks to a zone.
 */

export const CHALLENGE_PREFIX = "_acme-challenge.";

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

/** `_acme-challenge.<host>` -> `<host>`; null for anything else. */
export function challengeHostOf(recordName: string): string | null {
  const lower = recordName.toLowerCase().replace(/\.$/, "");
  if (!lower.startsWith(CHALLENGE_PREFIX)) return null;
  const host = lower.slice(CHALLENGE_PREFIX.length);
  return host.length > 0 && !host.includes("*") && !host.startsWith("_") ? host : null;
}

/** The two names an older layout kept records at for a box: `<host>` and `*.<host>`. */
export function boxRecordNames(host: string): string[] {
  return [host, `*.${host}`];
}
