/**
 * What a live gym run adds to the shared `flagship.services` zone (capped at
 * 200 records, gym and prod together). One wildcard per account
 * (docs/wildcard-dns.md): an account holds four records however many boxes it
 * has (`*.<user>` A + AAAA, CAA issue + issuewild at `<user>`); a box adds none
 * of its own. While a box is getting its certificate it briefly holds its
 * DNS-01 TXTs (2; the 4-record shield is off since 2026-10-18, docs/wildcard-dns.md
 * section 11), so the boxes up at once are budgeted for those too.
 */
export const RECORDS_PER_ACCOUNT = 4;
export const RECORDS_PER_BOX_ISSUING = 2;

export function dnsRecordsNeeded(peakBoxes: number, accounts: number): number {
  return accounts * RECORDS_PER_ACCOUNT + peakBoxes * RECORDS_PER_BOX_ISSUING;
}

/** The record set an account must hold once its boxes are up and certified. */
export function expectedAccountRecords(user: string, apex: string): string[] {
  const zone = `${user}.${apex}`;
  return [`A *.${zone}`, `AAAA *.${zone}`, `CAA ${zone}`, `CAA ${zone}`].sort();
}

export interface ZoneRecordName {
  type: string;
  name: string;
}

/**
 * Compare an account's records with {@link expectedAccountRecords}, ignoring a
 * box that is mid-issuance right now (its challenge TXT and shield come and go
 * while its certificate is being made). Returns the surprises: empty = fine.
 */
export function accountRecordSurprises(records: readonly ZoneRecordName[], user: string, apex: string): string[] {
  const zone = `${user}.${apex}`;
  const mine = records.filter((r) => r.name === zone || r.name.endsWith(`.${zone}`));
  const issuing = new Set(
    mine.filter((r) => r.type === "TXT" && r.name.startsWith("_acme-challenge.")).map((r) => r.name.slice("_acme-challenge.".length)),
  );
  const inFlight = (name: string): boolean => {
    const bare = name.replace(/^\*\./, "");
    return issuing.has(bare) || name.startsWith("_acme-challenge.");
  };
  const steady = mine.filter((r) => !inFlight(r.name) || r.name === `*.${zone}`).map((r) => `${r.type} ${r.name}`).sort();
  const want = expectedAccountRecords(user, apex);
  const out: string[] = [];
  for (const w of new Set(want)) {
    const need = want.filter((x) => x === w).length;
    const have = steady.filter((x) => x === w).length;
    if (have !== need) out.push(`${w}: ${have} of ${need}`);
  }
  for (const h of new Set(steady)) if (!want.includes(h)) out.push(`unexpected ${h}`);
  return out;
}
