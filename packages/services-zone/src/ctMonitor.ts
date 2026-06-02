/**
 * Certificate-Transparency monitor for the per-user cert (per-user-cert §4.3).
 *
 * The CAA `accounturi` pin (see `caaPin.ts`) stops Let's Encrypt from issuing a
 * `*.<user>` cert under any ACME account other than the trust-root's. CT
 * monitoring is the *detection* half: it watches the public CT logs for any
 * cert covering the user's `*.<user>.<apex>` namespace whose SAN set is not the
 * one the user's admin devices minted — i.e. issuance that bypassed the pin (a
 * mis-issuing CA, a CAA-ignoring path, a compromised admin device, or a `.com`
 * that forged DNS to mint under a CA we did not pin). `expectedCertSans` is the
 * single source of truth for "what a legitimate cert looks like"; *anything*
 * observed in CT outside that set is unaccounted-for issuance → alarm.
 *
 * This runs on the trust-root device, NOT on `.com` or the serving boxes (they
 * are precisely the parties the monitor is meant to catch).
 *
 * Comparison is case-insensitive: DNS names are case-insensitive (RFC 4343), so
 * a cert listing `*.Alice.Flagship.Services` is the same namespace as the
 * expected `*.alice.flagship.services` and must NOT slip past as "unexpected".
 *
 * The alarm rule is deliberately strict — "alarm unless EVERY SAN is expected",
 * not "alarm only if NO SAN is expected". A cert that pairs a legitimate SAN
 * with a foreign one (e.g. `[*.alice.flagship.services, attacker.example]`) is
 * still unaccounted-for issuance and must alarm; we report exactly the SANs
 * that fall outside the expected set so the alarm names the offending names.
 *
 * This is the Let's Encrypt TLS layer, NOT the Flagship maintainer/identity CA.
 */

import { expectedCertSans } from "./caaPin.js";

/**
 * A single observed CT log entry, reduced to the fields the SAN-set check
 * needs. `sans` is the leaf cert's dNSName SAN list as logged. `notAfter`
 * (epoch ms) and `issuer` are carried through untouched for alarm context /
 * triage; the OK/alarm decision is a pure function of `sans` vs the expected
 * set and never reads them.
 */
export interface CtLogEntry {
  sans: string[];
  notAfter?: number;
  issuer?: string;
}

/** A CT entry's check verdict. `ok` iff every SAN is in the expected set. */
export type CtCheckResult =
  | { ok: true }
  | { ok: false; unexpectedSans: string[] };

/** One alarming CT entry paired with the SANs that triggered the alarm. */
export interface UnexpectedCert {
  entry: CtLogEntry;
  unexpectedSans: string[];
}

/** Case-fold a DNS name for set comparison (RFC 4343 — names are ASCII-CI). */
function foldName(name: string): string {
  return name.toLowerCase();
}

/**
 * Check one CT entry against the expected SAN set.
 *
 * Returns `{ ok: true }` iff *every* SAN in `entry.sans` is present in
 * `expected` (case-insensitive). Otherwise returns `{ ok: false, unexpectedSans }`
 * listing — in the entry's original order, de-duplicated, case preserved as
 * logged — the SANs that are NOT in `expected`. Those are the alarm trigger.
 *
 * An entry with an empty SAN list trivially has no unexpected SAN and is `ok`;
 * it covers nothing in the namespace, so there is nothing to alarm on.
 */
export function checkCtEntry(entry: CtLogEntry, expected: string[]): CtCheckResult {
  const expectedFolded = new Set(expected.map(foldName));
  const unexpectedSans: string[] = [];
  const seen = new Set<string>();
  for (const san of entry.sans) {
    const folded = foldName(san);
    if (expectedFolded.has(folded)) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    unexpectedSans.push(san);
  }
  if (unexpectedSans.length === 0) {
    return { ok: true };
  }
  return { ok: false, unexpectedSans };
}

/**
 * Scan a batch of CT entries and return every one that should alarm, each
 * paired with the SANs that fall outside the expected set. Entries whose SANs
 * are all expected are dropped (no alarm). Input order is preserved.
 */
export function findUnexpectedCerts(
  entries: CtLogEntry[],
  expected: string[],
): UnexpectedCert[] {
  const alarms: UnexpectedCert[] = [];
  for (const entry of entries) {
    const result = checkCtEntry(entry, expected);
    if (!result.ok) {
      alarms.push({ entry, unexpectedSans: result.unexpectedSans });
    }
  }
  return alarms;
}

/**
 * Monitor one user's zone: derive the only legitimate SAN set for
 * `<username>.<apex>` via `expectedCertSans`, then return every CT entry that
 * should alarm. This is the entry point the trust-root device calls with a
 * fresh page of CT-log observations for the user.
 */
export function monitorUserZone(
  username: string,
  apex: string,
  entries: CtLogEntry[],
): UnexpectedCert[] {
  return findUnexpectedCerts(entries, expectedCertSans(username, apex));
}
