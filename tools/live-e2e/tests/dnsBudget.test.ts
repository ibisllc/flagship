import { describe, expect, it } from "vitest";
import {
  RECORDS_AT_REST,
  RECORDS_PER_ACCOUNT,
  accountRecordSurprises,
  dnsRecordsNeeded,
  expectedAccountRecords,
} from "../lib/dnsBudget.js";

const APEX = "gym.flagship.services";
const wildcardSet = (u: string) => [
  { type: "A", name: `*.${u}.${APEX}` },
  { type: "AAAA", name: `*.${u}.${APEX}` },
  { type: "CAA", name: `${u}.${APEX}` },
  { type: "CAA", name: `${u}.${APEX}` },
];

describe("the gym's zone budget", () => {
  it("an account costs nothing however many boxes it has; boxes cost only while issuing", () => {
    expect(RECORDS_PER_ACCOUNT).toBe(0);
    expect(RECORDS_AT_REST).toBe(4);
    expect(dnsRecordsNeeded(0, 2)).toBe(0);
    expect(dnsRecordsNeeded(3, 2)).toBe(6);
    // Thousands of accounts fit in what is left of the zone after the 4 records at rest.
    expect(dnsRecordsNeeded(10, 5000)).toBe(20);
  });
});

describe("accountRecordSurprises", () => {
  it("expects no record at all for an account", () => {
    expect(expectedAccountRecords("alice", APEX)).toEqual([]);
    expect(accountRecordSurprises([], "alice", APEX)).toEqual([]);
  });

  it("flags the previous design's four records, a per-box record and a CAA copy", () => {
    const recs = [...wildcardSet("alice"), { type: "A", name: `home.alice.${APEX}` }, { type: "CAA", name: `*.alice.${APEX}` }];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual(
      [
        `unexpected A *.alice.${APEX}`,
        `unexpected A home.alice.${APEX}`,
        `unexpected AAAA *.alice.${APEX}`,
        `unexpected CAA *.alice.${APEX}`,
        `unexpected CAA alice.${APEX}`,
        `unexpected CAA alice.${APEX}`,
      ].sort(),
    );
  });

  it("flags a stray TXT at the account or box name, but not a challenge in flight", () => {
    const recs = [
      { type: "TXT", name: `_acme-challenge.home2.alice.${APEX}` },
      { type: "TXT", name: `_acme-challenge.home2.alice.${APEX}` },
      { type: "TXT", name: `home.alice.${APEX}` },
    ];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual([`unexpected TXT home.alice.${APEX}`]);
  });

  it("ignores other accounts and the zone's own records", () => {
    const recs = [...wildcardSet("bob"), { type: "A", name: `*.${APEX}` }, { type: "CAA", name: APEX }, { type: "A", name: `alice2.${APEX}` }];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual([]);
  });
});
