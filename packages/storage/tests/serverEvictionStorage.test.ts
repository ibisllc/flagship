/**
 * Storage adapter contract — ServerEvictionStorage (the graceful-decommission
 * lane, docs/server-replacement-graceful-decommission.md §8b).
 *
 * One row per RETIRED box instance under a pod FQDN, keyed by
 * (podCanonical, retiredStkPubHex). Focused on the InMemory adapter's
 * observable behaviour: record→get→list (chain order), the three ack/barrier
 * marks, and the GC. The D1↔InMemory PARITY of these same operations is
 * asserted in parity.test.ts against the real D1-over-SQLite adapter.
 */
import { describe, expect, it } from "vitest";
import { InMemoryServerEvictionStorage } from "../src/index.js";
import type { ServerEvictionRecord } from "../src/index.js";

const POD = "home.alice.flagship.services";

function rec(over: Partial<ServerEvictionRecord> = {}): ServerEvictionRecord {
  return {
    podCanonical: POD,
    retiredStkPubHex: "aa".repeat(32),
    orderJson: JSON.stringify({ retire: true }),
    orderSignatureHex: "ff".repeat(64),
    issuedAt: 100,
    oldAckedAt: null,
    newAckedAt: null,
    epochCompleteAt: null,
    ...over,
  };
}

describe("InMemoryServerEvictionStorage", () => {
  it("record → get returns the stored order (hex lowercased)", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ retiredStkPubHex: "AA".repeat(32), orderSignatureHex: "FF".repeat(64) }));
    const got = await s.getEviction(POD, "aa".repeat(32));
    expect(got).toBeDefined();
    expect(got?.retiredStkPubHex).toBe("aa".repeat(32));
    expect(got?.orderSignatureHex).toBe("ff".repeat(64));
    expect(got?.orderJson).toBe(JSON.stringify({ retire: true }));
  });

  it("getEviction of an absent row is undefined", async () => {
    const s = new InMemoryServerEvictionStorage();
    expect(await s.getEviction(POD, "bb".repeat(32))).toBeUndefined();
  });

  it("listEvictions returns the full chain ordered by issuedAt asc", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ retiredStkPubHex: "bb".repeat(32), issuedAt: 300 }));
    await s.recordEviction(rec({ retiredStkPubHex: "aa".repeat(32), issuedAt: 100 }));
    await s.recordEviction(rec({ retiredStkPubHex: "cc".repeat(32), issuedAt: 200 }));
    // a different pod must not bleed into this pod's chain.
    await s.recordEviction(rec({ podCanonical: "other.bob.flagship.services", retiredStkPubHex: "dd".repeat(32), issuedAt: 50 }));

    const chain = await s.listEvictions(POD);
    expect(chain.map((e) => e.issuedAt)).toEqual([100, 200, 300]);
    expect(chain.map((e) => e.retiredStkPubHex)).toEqual([
      "aa".repeat(32),
      "cc".repeat(32),
      "bb".repeat(32),
    ]);
  });

  it("recordEviction upserts on (podCanonical, retiredStkPubHex)", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ orderJson: "v1" }));
    await s.recordEviction(rec({ orderJson: "v2" }));
    const chain = await s.listEvictions(POD);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.orderJson).toBe("v2");
  });

  it("markOldAcked sets the retiring-box ack on one row; false when absent", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec());
    expect(await s.markOldAcked(POD, "aa".repeat(32), 500)).toBe(true);
    expect(await s.markOldAcked(POD, "ee".repeat(32), 500)).toBe(false);
    expect((await s.getEviction(POD, "aa".repeat(32)))?.oldAckedAt).toBe(500);
  });

  it("markEpochComplete records the §9 barrier on one row; false when absent", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec());
    expect(await s.markEpochComplete(POD, "aa".repeat(32), 600)).toBe(true);
    expect(await s.markEpochComplete(POD, "ee".repeat(32), 600)).toBe(false);
    expect((await s.getEviction(POD, "aa".repeat(32)))?.epochCompleteAt).toBe(600);
  });

  it("markNewAcked marks ALL rows for the pod and returns the count", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ retiredStkPubHex: "aa".repeat(32) }));
    await s.recordEviction(rec({ retiredStkPubHex: "bb".repeat(32) }));
    await s.recordEviction(rec({ podCanonical: "other.bob.flagship.services", retiredStkPubHex: "cc".repeat(32) }));

    const count = await s.markNewAcked(POD, 700);
    expect(count).toBe(2);
    const chain = await s.listEvictions(POD);
    expect(chain.every((e) => e.newAckedAt === 700)).toBe(true);
    // the other pod is untouched.
    const other = await s.listEvictions("other.bob.flagship.services");
    expect(other[0]?.newAckedAt).toBeNull();
  });

  it("gcEvictions deletes successor-acked rows past the TTL", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ retiredStkPubHex: "aa".repeat(32) }));
    await s.markNewAcked(POD, 1000); // acked at t=1000
    // now=10000, ttl=5000 → cutoff 5000; 1000 ≤ 5000 → deleted.
    const removed = await s.gcEvictions(10000, 5000);
    expect(removed).toBe(1);
    expect(await s.listEvictions(POD)).toHaveLength(0);
  });

  it("deleteEviction removes one row and reports whether anything was deleted", async () => {
    const s = new InMemoryServerEvictionStorage();
    await s.recordEviction(rec({ retiredStkPubHex: "aa".repeat(32) }));
    await s.recordEviction(rec({ retiredStkPubHex: "bb".repeat(32) }));
    expect(await s.deleteEviction(POD, "AA".repeat(32))).toBe(true);
    expect(await s.deleteEviction(POD, "aa".repeat(32))).toBe(false);
    const chain = await s.listEvictions(POD);
    expect(chain.map((e) => e.retiredStkPubHex)).toEqual(["bb".repeat(32)]);
  });

  it("gcEvictions keeps un-acked rows and rows still within the TTL", async () => {
    const s = new InMemoryServerEvictionStorage();
    // never acked → kept regardless of age.
    await s.recordEviction(rec({ retiredStkPubHex: "aa".repeat(32) }));
    // successor-acked recently (within the TTL) → kept.
    await s.recordEviction(rec({ retiredStkPubHex: "bb".repeat(32), newAckedAt: 9000 }));

    const removed = await s.gcEvictions(10000, 5000); // cutoff 5000; 9000 > 5000 → kept
    expect(removed).toBe(0);
    expect(await s.listEvictions(POD)).toHaveLength(2);
  });
});
