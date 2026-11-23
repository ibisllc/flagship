/**
 * Security report F3, migration 0161: a re-pair initiate's digest is claimed once
 * (`re_pair_initiates_used`), and an admin veto blocks the rejected key until a time
 * (`re_pair_vetoed_keys`). Run against the in-memory adapter and D1 over real SQLite.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, InMemoryStorage, type Storage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: Storage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryStorage(), done: () => {} };
  const db = createSqliteD1();
  return { s: new D1Storage(db), done: () => db.close() };
}

for (const adapter of ["InMemory", "D1"] as const) {
  describe(`${adapter}: re-pair single use and veto block`, () => {
    it("claims a digest once, and again only after it expired", async () => {
      const { s, done } = fresh(adapter);
      try {
        const d = "ab".repeat(32);
        expect(await s.pendingRePairs.claimInitiate(d, 1_000, 10)).toBe(true);
        expect(await s.pendingRePairs.claimInitiate(d.toUpperCase(), 1_000, 20)).toBe(false);
        expect(await s.pendingRePairs.claimInitiate("cd".repeat(32), 1_000, 20)).toBe(true);
        expect(await s.pendingRePairs.claimInitiate(d, 3_000, 1_001)).toBe(true);
      } finally {
        done();
      }
    });

    it("blocks a vetoed key until its time, per account and key, case-insensitively", async () => {
      const { s, done } = fresh(adapter);
      try {
        await s.pendingRePairs.blockVetoedKey("Alice", "AA".repeat(32), 500);
        expect(await s.pendingRePairs.vetoedKeyBlockedUntil("alice", "aa".repeat(32), 100)).toBe(500);
        expect(await s.pendingRePairs.vetoedKeyBlockedUntil("alice", "bb".repeat(32), 100)).toBeUndefined();
        expect(await s.pendingRePairs.vetoedKeyBlockedUntil("bob", "aa".repeat(32), 100)).toBeUndefined();
        await s.pendingRePairs.blockVetoedKey("alice", "aa".repeat(32), 900);
        expect(await s.pendingRePairs.vetoedKeyBlockedUntil("alice", "aa".repeat(32), 600)).toBe(900);
        expect(await s.pendingRePairs.vetoedKeyBlockedUntil("alice", "aa".repeat(32), 900)).toBeUndefined();
      } finally {
        done();
      }
    });
  });
}
