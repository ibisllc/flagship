import { describe, expect, it } from "vitest";
import {
  RECORDS_PER_ACCOUNT,
  accountRecordSurprises,
  dnsRecordsNeeded,
  expectedAccountRecords,
} from "../lib/dnsBudget.js";

const APEX = "gym.flagship.services";
const set = (u: string) => expectedAccountRecords(u, APEX).map((l) => {
  const [type, name] = l.split(" ") as [string, string];
  return { type, name };
});

describe("the gym's zone budget", () => {
  it("an account costs four records however many boxes it has; boxes cost only while issuing", () => {
    expect(RECORDS_PER_ACCOUNT).toBe(4);
    expect(dnsRecordsNeeded(0, 2)).toBe(8);
    expect(dnsRecordsNeeded(3, 2)).toBe(8 + 6);
    // Steady state, 3 boxes on 2 accounts: 8 records (the old layout held 8 per account + 4 per box = 28).
    expect(dnsRecordsNeeded(0, 2)).toBe(8);
  });
});

describe("accountRecordSurprises", () => {
  it("is empty for exactly the four-record set", () => {
    expect(accountRecordSurprises(set("alice"), "alice", APEX)).toEqual([]);
  });

  it("flags a per-box record, a CAA copy at the wildcard, and a missing record", () => {
    const recs = [...set("alice"), { type: "A", name: `home.alice.${APEX}` }, { type: "CAA", name: `*.alice.${APEX}` }];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual([`unexpected A home.alice.${APEX}`, `unexpected CAA *.alice.${APEX}`]);
    expect(accountRecordSurprises(set("alice").slice(1), "alice", APEX).length).toBe(1);
  });

  it("ignores a box that is mid-issuance (its TXT and shield) and other accounts", () => {
    const recs = [
      ...set("alice"),
      { type: "TXT", name: `_acme-challenge.home2.alice.${APEX}` },
      { type: "A", name: `home2.alice.${APEX}` },
      { type: "AAAA", name: `*.home2.alice.${APEX}` },
      ...set("bob"),
    ];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual([]);
  });

  it("does not let an in-flight box hide a stray record of another box", () => {
    const recs = [...set("alice"), { type: "TXT", name: `_acme-challenge.home2.alice.${APEX}` }, { type: "A", name: `home3.alice.${APEX}` }];
    expect(accountRecordSurprises(recs, "alice", APEX)).toEqual([`unexpected A home3.alice.${APEX}`]);
  });
});
