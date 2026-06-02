/**
 * CAA issuance-pinning records for the per-user cert (RFC 8657).
 *
 * Per-user-cert design §4.3: the cert is minted by the user's trust-root
 * (admin-scope) devices, NEVER by `.com` or the serving boxes. A CAA record
 * with the RFC 8657 `accounturi` parameter binds Let's Encrypt issuance for
 * the user's zone to the phone-held ACME account — so even a malicious `.com`
 * (which controls the authoritative DNS for `<user>.flagship.services`) cannot
 * make LE issue a cert under a *different* ACME account it controls. The
 * `validationmethods` parameter further restricts which ACME challenge type LE
 * will honour (we use `dns-01`, matching the wildcard issuance path).
 *
 * This is the Let's Encrypt TLS layer, NOT the Flagship maintainer/identity CA.
 *
 * CT monitoring (the other half of §4.3) lives on the trust-root device: it
 * watches Certificate Transparency logs for any cert covering `*.<user>` whose
 * SAN set is not the one this module's owner minted. `expectedCertSans` is the
 * single source of truth for "what a legitimate cert for this user looks like";
 * anything else observed in CT is an alarm.
 */

/** Default CA domain that CAA records are written for. */
const DEFAULT_CA_DOMAIN = "letsencrypt.org";

/** Default ACME validation method to pin (matches the wildcard DNS-01 path). */
const DEFAULT_VALIDATION_METHODS = ["dns-01"] as const;

export interface CaaIssueValueOptions {
  /**
   * The CA the `issue` property authorises. Defaults to `letsencrypt.org`.
   * This is the domain LE checks for in its own `issue` property name.
   */
  caDomain?: string;
  /**
   * RFC 8657 `accounturi` — the full ACME account URL of the trust-root
   * device's account, e.g.
   * `https://acme-v02.api.letsencrypt.org/acme/acct/123`. Required: pinning
   * to a specific account is the entire point of this record.
   */
  accountUri: string;
  /**
   * RFC 8657 `validationmethods` — the ACME challenge type(s) LE is allowed
   * to use. Defaults to `["dns-01"]`. Comma-joined into the property value.
   */
  validationMethods?: string[];
}

/**
 * Build the value of a single CAA `issue` property string, RFC 8657 style:
 *
 *   `letsencrypt.org; accounturi=https://…/acct/123; validationmethods=dns-01`
 *
 * The CA domain comes first (the `issue` property's primary token), followed by
 * `;`-separated key=value parameters. We emit `accounturi` then
 * `validationmethods` in that fixed order for stable, diffable records.
 */
export function buildCaaIssueValue(opts: CaaIssueValueOptions): string {
  const caDomain = opts.caDomain ?? DEFAULT_CA_DOMAIN;
  if (!opts.accountUri) {
    throw new Error("buildCaaIssueValue: accountUri is required (RFC 8657 account pinning)");
  }
  const methods = opts.validationMethods ?? [...DEFAULT_VALIDATION_METHODS];
  const parts = [
    caDomain,
    `accounturi=${opts.accountUri}`,
    `validationmethods=${methods.join(",")}`,
  ];
  return parts.join("; ");
}

export interface CaaRecord {
  name: string;
  type: "CAA";
  flags: 0;
  tag: "issue";
  value: string;
}

/**
 * Build the CAA record set for one user's zone. Two records share the same
 * pinned `issue` value:
 *
 *   - `<userZone>`          — covers `<user>.flagship.services` itself.
 *   - `*.<userZone>`        — covers the `*.<user>.flagship.services` wildcard.
 *
 * A wildcard cert's authorisation is checked against the CAA record at the
 * wildcard name's own node (`*.<user>`), so the wildcard record is not
 * redundant with the apex one — both are required for the full SAN set.
 *
 * `flags` is `0` (non-critical) and `tag` is `issue`; we deliberately do NOT
 * emit `issuewild` — the `*.<userZone>` `issue` record already authorises the
 * wildcard, and a missing `issuewild` falls back to `issue` per RFC 8659.
 */
export function buildUserZoneCaaRecords(
  userZone: string,
  opts: CaaIssueValueOptions,
): CaaRecord[] {
  const value = buildCaaIssueValue(opts);
  return [
    { name: userZone, type: "CAA", flags: 0, tag: "issue", value },
    { name: `*.${userZone}`, type: "CAA", flags: 0, tag: "issue", value },
  ];
}

/**
 * The ONLY SAN set a CT monitor should ever see for this user:
 *
 *   [`<user>.<apex>`, `*.<user>.<apex>`]
 *
 * This mirrors `userWildcardSans` (the issuance side) so the monitor and the
 * minter agree byte-for-byte on what a legitimate cert looks like. Any cert in
 * a Certificate Transparency log covering `*.<user>.<apex>` whose SAN set is
 * not exactly this is unaccounted-for issuance → alarm. Returned sorted-stable
 * (apex before wildcard) for deterministic comparison.
 */
export function expectedCertSans(username: string, apex: string): string[] {
  return [`${username}.${apex}`, `*.${username}.${apex}`];
}
