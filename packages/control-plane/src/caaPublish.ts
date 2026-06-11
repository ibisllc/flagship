/**
 * PHASE-1 CAA publishing for a user's `flagship.services` zone.
 *
 * Restricts certificate issuance for `<user>.flagship.services` and every
 * name beneath it (CAA climbs, so it covers each box's A′ per-box
 * `[<server>.<user>, *.<server>.<user>]` names) to Let's Encrypt and nobody else — a
 * defense-in-depth layer against EXTERNAL mis-issuance (another CA, or a CA
 * tricked into issuing for the user's names).
 *
 * HONEST SCOPE: `.com` is authoritative for the zone, so this does NOT defend
 * against a malicious `.com` (it could rewrite the record). Its value is (a)
 * blocking other / externally-tricked CAs outright and (b) defense-in-depth —
 * a rewrite is itself anomalous and CT-monitorable. The malicious-`.com`
 * defense proper is Certificate-Transparency monitoring, a separate concern.
 *
 * Published once per user at server-register time (see `serverRegister.ts`),
 * through the same DNS upsert client used for the A/AAAA records, so it shares
 * the same mechanism and credentials. Idempotent: each record is keyed by its
 * exact zone-file rdata, so re-registration never duplicates.
 *
 * PHASE 2 (NOT BUILT) — RFC 8657 `accounturi` account pinning. See the TODO
 * block at the bottom of `@flagship/services-zone`'s `caaPin.ts`.
 */

import {
  buildUserZoneCaRestrictionCaaRecords,
  caaRecordRdata,
  type CaRestrictionCaaOptions,
} from "@flagship/services-zone";

/**
 * Minimal DNS surface the CAA publisher needs. Satisfied by the same
 * `DnsUpsertClient` the A/AAAA path uses, extended with the `"CAA"` type +
 * structured `data` field Cloudflare requires for CAA records. Injectable for
 * tests.
 */
export interface CaaUpsertClient {
  upsert(opts: {
    name: string;
    type: "CAA";
    content: string;
    data?: { flags: number; tag: string; value: string };
    ttl?: number;
  }): Promise<{ id: string; name: string; content: string }>;
}

/**
 * Publish (idempotently) the CA-restriction CAA record set for one user zone.
 *
 * `userZone` is `<user>.flagship.services`. The record set covers both the zone
 * apex and the `*.<user>` wildcard. Returns the records that were ensured.
 */
export async function publishUserZoneCaa(args: {
  client: CaaUpsertClient;
  userZone: string;
  ttl?: number;
  options?: CaRestrictionCaaOptions;
}): Promise<{ name: string; rdata: string }[]> {
  const records = buildUserZoneCaRestrictionCaaRecords(args.userZone, args.options);
  const published: { name: string; rdata: string }[] = [];
  for (const rec of records) {
    const rdata = caaRecordRdata(rec);
    await args.client.upsert({
      name: rec.name,
      type: "CAA",
      content: rdata,
      data: { flags: rec.flags, tag: rec.tag, value: rec.value },
      ttl: args.ttl ?? 300,
    });
    published.push({ name: rec.name, rdata });
  }
  return published;
}
