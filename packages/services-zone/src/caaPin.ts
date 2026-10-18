/**
 * CAA issuance-pinning records for the user's `flagship.services` zone
 * (RFC 8657 / RFC 8659).
 *
 * Under cert model A′ each BOX mints its own wildcard cert
 * `[<server>.<user>, *.<server>.<user>]` (box-local key, never shared), but
 * CAA stays anchored at the USER zone: RFC 8659 §3 tree-climbing means a
 * record at `<user>.flagship.services` covers every per-box and service name
 * below it, so one user-zone record set restricts issuance for all of them.
 * A CAA record with the RFC 8657 `accounturi` parameter binds Let's Encrypt
 * issuance for the user's zone to a pinned ACME account — so even a malicious
 * `.com` (which controls the authoritative DNS for `<user>.flagship.services`)
 * cannot make LE issue a cert under a *different* ACME account it controls.
 * The `validationmethods` parameter further restricts which ACME challenge
 * type LE will honour (we use `dns-01`, matching the wildcard issuance path).
 *
 * This is the Let's Encrypt TLS layer, NOT the Flagship maintainer/identity CA.
 *
 * CT monitoring (the detection half) watches Certificate Transparency logs
 * for any cert covering the user's namespace whose SAN set is not a
 * registered box's per-box pair. `expectedCertSans` is the single source of
 * truth for "what a legitimate cert for one box looks like"; anything else
 * observed in CT is an alarm.
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
  tag: "issue" | "issuewild" | "iodef";
  value: string;
}

/**
 * Build the account-pinned CAA record set for one user's zone (PHASE 2, not
 * published yet): a single `issue` record at `<userZone>`. CAA climbs from
 * every name below it (RFC 8659 §3), and a wildcard certificate is checked at
 * its base name, so no copy at `*.<userZone>` is needed (see
 * {@link buildUserZoneCaRestrictionCaaRecords}).
 *
 * `flags` is `0` (non-critical) and `tag` is `issue`; we deliberately do NOT
 * emit `issuewild` here — a missing `issuewild` falls back to `issue` per
 * RFC 8659, so the one record also pins wildcard issuance.
 */
export function buildUserZoneCaaRecords(
  userZone: string,
  opts: CaaIssueValueOptions,
): CaaRecord[] {
  const value = buildCaaIssueValue(opts);
  return [{ name: userZone, type: "CAA", flags: 0, tag: "issue", value }];
}

/**
 * The ONLY SAN set a CT monitor should ever accept for one of the user's
 * boxes (cert model A′ — per-box wildcard):
 *
 *   [`<server>.<user>.<apex>`, `*.<server>.<user>.<apex>`]
 *
 * `serverFqdn` is the box's full registered FQDN (`<server>.<user>.<apex>`).
 * Legitimacy is judged PER BOX — the box mints exactly this pair on its own
 * metal, so the monitor and the minter agree byte-for-byte on what a
 * legitimate cert looks like. Any cert in a Certificate Transparency log
 * covering the user's namespace whose SAN set is not a registered box's pair
 * — including an old-style model-C per-user wildcard `[<user>, *.<user>]` —
 * is unaccounted-for issuance → alarm. Returned sorted-stable (apex before
 * wildcard) for deterministic comparison.
 */
export function expectedCertSans(serverFqdn: string): string[] {
  return [serverFqdn, `*.${serverFqdn}`];
}

// ---------------------------------------------------------------------------
// PHASE 1 — CA-RESTRICTION CAA (no account pinning).
//
// This is the layer we publish *today*, at the point a user's zone records are
// set up (auth-code issue and server registration). It restricts issuance for
// the user's zone to Let's Encrypt and nobody else — a defense-in-depth layer
// against EXTERNAL mis-issuance / a CA tricked into issuing for
// `*.<user>.flagship.services`.
//
// HONEST SCOPE: `.com` is authoritative for the `flagship.services` zone, so
// CAA alone does NOT stop a *malicious* `.com` — it could rewrite this record
// before tricking a CA. CAA's value here is twofold: (a) it blocks OTHER CAs
// and externally-tricked issuance outright, and (b) it is defense-in-depth —
// any rewrite of this record is itself an anomaly a CT/zone monitor can flag.
// The malicious-`.com` defense proper is Certificate-Transparency monitoring
// (`ctMonitor.ts`), not CAA.
//
// PHASE 2 (NOT BUILT — see the TODO block at the bottom of this file): RFC 8657
// `accounturi` account pinning, via `buildUserZoneCaaRecords` above, which binds
// issuance to a specific ACME account. That depends on a per-user shared ACME
// account decision that has not been made yet.
// ---------------------------------------------------------------------------

export interface CaRestrictionCaaOptions {
  /** CA the `issue`/`issuewild` properties authorise. Default `letsencrypt.org`. */
  caDomain?: string;
  /**
   * Optional `iodef` reporting URI (RFC 8659 §4.4), e.g.
   * `mailto:security@flagshipserver.com`. Off by default: Let's Encrypt does
   * not send these reports, and the record would cost one zone slot per
   * account (docs/wildcard-dns.md).
   */
  iodef?: string;
}

/**
 * Build the PHASE-1 CA-restriction CAA record set for one user's zone — no
 * account pinning. Two records, at the user-zone node only:
 *
 *   - `0 issue "letsencrypt.org"`      — only LE may issue non-wildcard certs.
 *   - `0 issuewild "letsencrypt.org"`  — only LE may issue wildcard certs.
 *
 * (and `0 iodef "<uri>"` when `opts.iodef` is given).
 *
 * One node is enough. A CA looks up CAA for the name it is asked to certify
 * with a leading `*.` removed (`home.alice` for `*.home.alice`), and climbs
 * to the parent whenever a node has no CAA RRset (RFC 8659 §3), so a record at
 * `<user>` covers every box, wildcard and service name below it. A copy at
 * `*.<user>` (older builds published one) only repeats it, and now that
 * `*.<user>` carries the account's A/AAAA wildcard it would also be returned
 * for every name under the account. `issuewild` is kept explicit even though
 * `issue` alone already governs wildcards when `issuewild` is absent.
 *
 * `flags` is `0` (non-critical) throughout.
 */
export function buildUserZoneCaRestrictionCaaRecords(
  userZone: string,
  opts: CaRestrictionCaaOptions = {},
): CaaRecord[] {
  const caDomain = opts.caDomain ?? DEFAULT_CA_DOMAIN;
  const recs: CaaRecord[] = [
    { name: userZone, type: "CAA", flags: 0, tag: "issue", value: caDomain },
    { name: userZone, type: "CAA", flags: 0, tag: "issuewild", value: caDomain },
  ];
  if (opts.iodef) {
    recs.push({ name: userZone, type: "CAA", flags: 0, tag: "iodef", value: opts.iodef });
  }
  return recs;
}

/**
 * Render a {@link CaaRecord} as its zone-file presentation rdata, e.g.
 *
 *   `0 issue "letsencrypt.org"`
 *
 * This is the canonical string DNS providers accept as the record `content`
 * (and what `dig CAA` prints), so it doubles as a stable idempotency key:
 * two records with identical rdata at the same name are the same record.
 */
export function caaRecordRdata(rec: CaaRecord): string {
  return `${rec.flags} ${rec.tag} "${rec.value}"`;
}

// ===========================================================================
// TODO(phase-2, accounturi pinning — RFC 8657): once a per-user ACME account
// exists (the per-user shared-ACME-account decision is NOT yet made), tighten
// the `issue` / `issuewild` values from the bare CA domain to the account-
// pinned form by APPENDING `; accounturi=<the user's ACME account URL>`:
//
//     0 issue     "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<ID>"
//     0 issuewild "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<ID>"
//
// `buildCaaIssueValue` / `buildUserZoneCaaRecords` above ALREADY emit this
// account-pinned value (and `validationmethods=dns-01`). The phase-2 wiring is:
//   1. resolve the user's ACME account URL,
//   2. swap `buildUserZoneCaRestrictionCaaRecords` for `buildUserZoneCaaRecords`
//      (or thread `accountUri` through this builder) at the publish call-site in
//      the control-plane server-register path,
//   3. KEEP IT IN SYNC: if the account ever rotates (re-registration, key
//      change, account migration) the CAA `accounturi` MUST be re-published to
//      the new URL, or LE will refuse to renew the legitimately-pinned cert.
// Until phase 2 lands, the CA-restriction records above are the published set.
// ===========================================================================
