/**
 * Security review M5: deleting an account's row (account deletion and the dormant-name reclaim both end in
 * `usernames.delete`) removes its demo_users row in the same transaction, so no demo row outlives its account. Run
 * against the in-memory adapter and the D1 adapter over real SQLite.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, InMemoryStorage, type DemoUserRecord, type Storage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: Storage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryStorage(), done: () => {} };
  const db = createSqliteD1();
  return { s: new D1Storage(db), done: () => db.close() };
}

const demoRow = (username: string): DemoUserRecord => ({
  username, idempotencyKey: `key-${username}`, snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "r", size: "s",
  activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state: "ready",
  createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
});

for (const adapter of ["InMemory", "D1"] as const) {
  describe(`${adapter}: an account's demo row goes with it`, () => {
    it("usernames.delete removes the demo row, and leaves other accounts' rows", async () => {
      const { s, done } = fresh(adapter);
      try {
        for (const u of ["demo-ann", "demo-bob"]) {
          expect((await s.usernames.put({ username: u, irkPubHex: "ab".repeat(32), claimedAt: 1, isDemo: true })).ok).toBe(true);
          expect((await s.demoUsers.insert(demoRow(u))).ok).toBe(true);
        }
        await s.usernames.delete("demo-ann", 10);
        expect(await s.demoUsers.get("demo-ann")).toBeUndefined();
        expect(await s.demoUsers.get("demo-bob")).toBeDefined();
      } finally {
        done();
      }
    });
  });
}
