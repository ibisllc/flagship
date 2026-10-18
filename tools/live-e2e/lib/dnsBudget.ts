/**
 * What a live gym run adds to the shared `flagship.services` zone (capped at
 * 200 records, gym and prod together). Root-wildcard layout
 * (docs/wildcard-dns.md): the zone holds `*.<apex>` A + AAAA and the apex CAA
 * pair, set up once by hand, and an ACCOUNT holds nothing, whatever its box
 * count; a box adds none of its own. The only records a run creates are the
 * temporary DNS-01 TXTs of a certificate in flight (2 per box; there is no challenge
 * shield any more, docs/wildcard-dns.md section 6), so the
 * boxes up at once are budgeted for those. Thousands of accounts fit.
 */
export const RECORDS_AT_REST = 4;
export const RECORDS_PER_ACCOUNT = 0;
export const RECORDS_PER_BOX_ISSUING = 2;

export function dnsRecordsNeeded(peakBoxes: number, accounts = 0): number {
  return accounts * RECORDS_PER_ACCOUNT + peakBoxes * RECORDS_PER_BOX_ISSUING;
}

/** The record set an account must hold once its boxes are up and certified: none. */
export function expectedAccountRecords(_user: string, _apex: string): string[] {
  return [];
}

export interface ZoneRecordName {
  type: string;
  name: string;
}

/**
 * Compare an account's records with {@link expectedAccountRecords}: there must
 * be none at `<user>` or below it, except the `_acme-challenge` TXT of a box
 * that is mid-issuance right now (it comes and goes while its certificate is
 * made). Any other record at an account or box name stops the zone wildcard for
 * the names below it. Returns the surprises: empty = fine.
 */
export function accountRecordSurprises(records: readonly ZoneRecordName[], user: string, apex: string): string[] {
  const zone = `${user}.${apex}`;
  return records
    .filter((r) => r.name === zone || r.name.endsWith(`.${zone}`))
    .filter((r) => !(r.type === "TXT" && r.name.startsWith("_acme-challenge.")))
    .map((r) => `unexpected ${r.type} ${r.name}`)
    .sort();
}
