/**
 * The call storage pieces behind the privacy policy's §2.12, on both adapters: the live call's account (the device
 * room URL names only the call) and what an unpublished page's calls leave behind.
 */
import { describe, expect, it } from "vitest";
import { D1VoiciCallStorage, InMemoryVoiciCallStorage, type D1Database, type VoiciCallStorage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { c: VoiciCallStorage; done: () => void } {
  if (adapter === "InMemory") return { c: new InMemoryVoiciCallStorage(), done: () => {} };
  const db = createSqliteD1();
  return { c: new D1VoiciCallStorage(db as unknown as D1Database), done: () => db.close() };
}

const PAGE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OTHER = "1f1e2d3c4b5a69788796a5b4c3d2e1f0";
const CONV = "ab".repeat(32);
const CALL = "0123456789abcdef0123456789abcdef";
const NOW = 1_900_000_000_000;

describe.each(["InMemory", "D1"] as const)("VoiciCallStorage (%s)", (adapter) => {
  it("finds a live call's account by its id until it ends or expires", async () => {
    const { c, done } = fresh(adapter);
    try {
      expect(await c.liveCallAccount(CALL, NOW)).toBeNull();
      await c.claimLiveCall("alice", CALL, NOW, NOW + 60_000);
      expect(await c.liveCallAccount(CALL, NOW)).toBe("alice");
      expect(await c.liveCallAccount("ff".repeat(16), NOW)).toBeNull();
      expect(await c.liveCallAccount(CALL, NOW + 60_000)).toBeNull();
      await c.releaseLiveCall("alice", CALL);
      expect(await c.liveCallAccount(CALL, NOW)).toBeNull();
    } finally {
      done();
    }
  });

  it("deletePageCallData drops that page's missed calls, call-back channels and rings, and nothing else", async () => {
    const { c, done } = fresh(adapter);
    try {
      for (const pageId of [PAGE, OTHER]) {
        await c.putMissedCall({ pageId, conv: CONV, callId: pageId + pageId, sealed: "c2VhbGVk", storedAt: NOW });
        await c.putRingBack({ pageId, conv: CONV, username: "bob", issuedAt: NOW, expiresAt: NOW + 1e6 });
        await c.putRing({ pageId, conv: CONV, ringId: "cd".repeat(16), hint: "aGludA", media: "audio", issuedAt: NOW, expiresAt: NOW + 45_000 });
        await c.setCallAllow({ pageId, conv: CONV, op: "allow", issuedAt: NOW, signature: "00" }, NOW);
      }
      await c.blockAnon(PAGE, "cd".repeat(16), Number.MAX_SAFE_INTEGER);
      await c.deletePageCallData(PAGE);
      expect(await c.listMissedCalls(PAGE, 0, 10)).toEqual([]);
      expect(await c.getRingBack(PAGE, CONV, NOW)).toBeNull();
      expect(await c.getRing(PAGE, CONV, NOW)).toBeNull();
      expect(await c.getCallAllow(PAGE, CONV)).not.toBeNull();
      expect(await c.isAnonBlocked(PAGE, "cd".repeat(16), NOW)).toBe(true);
      expect(await c.listMissedCalls(OTHER, 0, 10)).toHaveLength(1);
      expect(await c.getRingBack(OTHER, CONV, NOW)).not.toBeNull();
      expect(await c.getRing(OTHER, CONV, NOW)).not.toBeNull();
    } finally {
      done();
    }
  });
});
