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

/**
 * Default `iodef` reporting endpoint a CA emails on a CAA-violating
 * issuance attempt (RFC 8659 §4.4). A `mailto:` URI.
 *
 * TODO(confirm-address): point this at a monitored inbox. `security@`
 * is the convention; swap in the real address (or an https:// incident
 * webhook) when the security inbox is finalised.
 */
const DEFAULT_IODEF = "mailto:security@flagshipserver.com";

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
// set up (server registration). It restricts issuance for the user's zone to
// Let's Encrypt and nobody else — a defense-in-depth layer against EXTERNAL
// mis-issuance / a CA tricked into issuing for `*.<user>.flagship.services`.
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
   * `iodef` reporting URI a violating CA contacts. Default
   * `mailto:security@flagshipserver.com`. Pass an empty string to omit the
   * `iodef` record entirely.
   */
  iodef?: string;
}

/**
 * Build the PHASE-1 CA-restriction CAA record set for one user's zone — no
 * account pinning. Three records per name:
 *
 *   - `0 issue "letsencrypt.org"`      — only LE may issue non-wildcard certs.
 *   - `0 issuewild "letsencrypt.org"`  — only LE may issue wildcard certs.
 *   - `0 iodef "mailto:security@…"`    — where a violating CA reports.
 *
 * Emitted at BOTH the user-zone apex `<user>.flagship.services` and the
 * wildcard `*.<user>.flagship.services`: a wildcard cert's authorisation is
 * checked against the CAA record at the wildcard node itself, so the wildcard
 * record is not redundant with the apex one (RFC 8659 §3 tree-climbing applies
 * to each requested name independently).
 *
 * `flags` is `0` (non-critical) throughout.
 */
export function buildUserZoneCaRestrictionCaaRecords(
  userZone: string,
  opts: CaRestrictionCaaOptions = {},
): CaaRecord[] {
  const caDomain = opts.caDomain ?? DEFAULT_CA_DOMAIN;
  const iodef = opts.iodef ?? DEFAULT_IODEF;
  const names = [userZone, `*.${userZone}`];
  const recs: CaaRecord[] = [];
  for (const name of names) {
    recs.push({ name, type: "CAA", flags: 0, tag: "issue", value: caDomain });
    recs.push({ name, type: "CAA", flags: 0, tag: "issuewild", value: caDomain });
    if (iodef) {
      recs.push({ name, type: "CAA", flags: 0, tag: "iodef", value: iodef });
    }
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
