/**
 * DirectAccessStorage contract (docs/direct-access-and-domains.md §6 step 3, migration 0133), run against the
 * in-memory adapter and the D1 adapter over real SQLite with every migration applied, so the two cannot drift.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, InMemoryStorage, type Storage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: Storage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryStorage(), done: () => {} };
  const db = createSqliteD1();
  return { s: new D1Storage(db), done: () => db.close() };
}

const BOX = "home.alice.flagship.services";
const SHA = (n: number) => n.toString(16).padStart(64, "0");
const order = (issuedAt: number, over: Partial<{ username: string; enabled: boolean; sha: string }> = {}) => ({
  serverDomain: BOX,
  username: over.username ?? "alice",
  orderJson: `{"issuedAt":${issuedAt}}`,
  signatureHex: "aa".repeat(64),
  orderSha256: over.sha ?? SHA(issuedAt),
  enabled: over.enabled ?? true,
  issuedAt,
  updatedAt: issuedAt,
});
const name = (issuedAt: number, over: Partial<{ username: string; name: string; enabled: boolean }> = {}) => ({
  name: over.name ?? "game--alice",
  username: over.username ?? "alice",
  kind: "derived" as const,
  serverDomain: BOX,
  enabled: over.enabled ?? true,
  orderJson: `{"issuedAt":${issuedAt}}`,
  signatureHex: "bb".repeat(64),
  issuedAt,
  now: issuedAt + 5,
});

for (const adapter of ["InMemory", "D1"] as const) {
  describe(`DirectAccessStorage (${adapter})`, () => {
    it("keeps the newest order per box and clears the update on a new order", async () => {
      const { s, done } = fresh(adapter);
      expect(await s.directAccess.putOrderIfNewer(order(10))).toEqual({ ok: true });
      expect(await s.directAccess.putOrderIfNewer(order(10))).toEqual({ ok: false, reason: "stale" });
      expect(await s.directAccess.putUpdateIfNewer(BOX, SHA(10), { updateJson: "{}", updateSignatureHex: "cc", updateIssuedAt: 20, updatedAt: 20 })).toEqual({ ok: true });
      expect(await s.directAccess.putUpdateIfNewer(BOX, SHA(10), { updateJson: "{}", updateSignatureHex: "cc", updateIssuedAt: 20, updatedAt: 21 })).toEqual({ ok: false, reason: "stale" });
      expect(await s.directAccess.putUpdateIfNewer(BOX, SHA(9), { updateJson: "{}", updateSignatureHex: "cc", updateIssuedAt: 30, updatedAt: 30 })).toEqual({ ok: false, reason: "stale" });
      expect((await s.directAccess.getOrder(BOX))?.updateIssuedAt).toBe(20);
      expect(await s.directAccess.putOrderIfNewer(order(40))).toEqual({ ok: true });
      const held = await s.directAccess.getOrder(BOX);
      expect(held?.updateIssuedAt ?? null).toBeNull();
      expect(held?.issuedAt).toBe(40);
      expect((await s.directAccess.listOrdersForUser("alice")).length).toBe(1);
      expect(await s.directAccess.putOrderIfNewer(order(50, { enabled: false }))).toEqual({ ok: true });
      expect(await s.directAccess.putUpdateIfNewer(BOX, SHA(50), { updateJson: "{}", updateSignatureHex: "cc", updateIssuedAt: 60, updatedAt: 60 })).toEqual({ ok: false, reason: "stale" });
      done();
    });

    it("a box that moved to another account takes that account's order", async () => {
      const { s, done } = fresh(adapter);
      await s.directAccess.putOrderIfNewer(order(100));
      expect(await s.directAccess.putOrderIfNewer(order(5, { username: "bob" }))).toEqual({ ok: true });
      expect((await s.directAccess.getOrder(BOX))?.username).toBe("bob");
      done();
    });

    it("keeps the newest name order, refuses another account's name, and reconciles", async () => {
      const { s, done } = fresh(adapter);
      expect(await s.directAccess.putNameIfNewer(name(10))).toEqual({ ok: true });
      expect(await s.directAccess.putNameIfNewer(name(10))).toEqual({ ok: false, reason: "stale" });
      expect(await s.directAccess.putNameIfNewer(name(99, { username: "bob" }))).toEqual({ ok: false, reason: "taken" });
      const pending = await s.directAccess.listPending(5);
      expect(pending.map((p) => p.name)).toEqual(["game--alice"]);
      const seen = pending[0]!.updatedAt;
      expect(await s.directAccess.setPublished("game--alice", seen, { publishedJson: '[{"type":"AAAA","content":"2a02::1"}]', state: "published", reason: null, error: null, now: 50 })).toBe(true);
      expect(await s.directAccess.listPending(5)).toEqual([]);
      const row = await s.directAccess.getName("game--alice");
      expect(row?.publishState).toBe("published");
      expect(row?.publishedJson).toContain("2a02::1");
      expect(await s.directAccess.setPublished("game--alice", seen, { publishedJson: "[]", state: "empty", reason: null, error: null, now: 60 })).toBe(false);
      expect((await s.directAccess.getName("game--alice"))?.publishedJson).toBe("[]");
      expect((await s.directAccess.listPending(5, 51)).map((p) => p.name)).toEqual(["game--alice"]);
      expect(await s.directAccess.listPending(5, 50)).toEqual([]);
      await s.directAccess.markPending(["game--alice"], 70);
      expect((await s.directAccess.listPending(5)).length).toBe(1);
      expect((await s.directAccess.listNamesForServer(BOX)).length).toBe(1);
      expect((await s.directAccess.listNamesForUser("alice")).length).toBe(1);
      done();
    });

    it("suspends, probes and deletes", async () => {
      const { s, done } = fresh(adapter);
      await s.directAccess.putNameIfNewer(name(10));
      expect(await s.directAccess.suspend("game--alice", "phishing", 20)).toBe(true);
      expect((await s.directAccess.getName("game--alice"))?.suspendedReason).toBe("phishing");
      expect(await s.directAccess.suspend("game--alice", null, 30)).toBe(true);
      expect((await s.directAccess.getName("game--alice"))?.suspendedAt ?? null).toBeNull();
      await s.directAccess.setProbe("game--alice", '{"ok":true}', 40);
      expect((await s.directAccess.getName("game--alice"))?.probeAt).toBe(40);
      expect(await s.directAccess.delete("game--alice")).toBe(true);
      expect(await s.directAccess.getName("game--alice")).toBeNull();
      done();
    });
  });
}
