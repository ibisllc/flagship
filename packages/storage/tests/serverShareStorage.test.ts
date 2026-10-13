/**
 * ServerShareStorage contract (docs/share-a-server.md, migration 0087), run
 * against the in-memory adapter and the D1 adapter over real SQLite with every
 * migration applied.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, InMemoryStorage, type ServerShareStorage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: ServerShareStorage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryStorage().serverShares, done: () => {} };
  const db = createSqliteD1();
  return { s: new D1Storage(db).serverShares, done: () => db.close() };
}

const ID = "0f".repeat(16);
const ID2 = "1e".repeat(16);
const S = "home.harry.flagship.services";
const share = (over: Partial<{ shareId: string; tokenHash: string; expiresAt: number; serverDomain: string }> = {}) => ({
  shareId: over.shareId ?? ID,
  ownerUsername: "harry",
  serverDomain: over.serverDomain ?? S,
  tokenHash: over.tokenHash ?? "aa".repeat(32),
  offerHex: "01".repeat(30),
  ownerHex: "02".repeat(30),
  createdAt: 1000,
  expiresAt: over.expiresAt ?? 10_000,
});
const unlock = (shareId = ID, issuedAt = 5) => ({
  shareId,
  serverDomain: S,
  memberPubHex: "bb".repeat(32),
  sealedKeyHex: "cd".repeat(60),
  depositJson: "{}",
  signatureHex: "ef".repeat(64),
  issuedAt,
});

describe.each(["InMemory", "D1"] as const)("ServerShareStorage (%s)", (adapter) => {
  it("creates once per id and per token", async () => {
    const { s, done } = fresh(adapter);
    expect((await s.create(share())).ok).toBe(true);
    expect((await s.create(share())).ok).toBe(false);
    expect((await s.create(share({ shareId: ID2 }))).ok).toBe(false);
    expect((await s.create(share({ shareId: ID2, tokenHash: "ab".repeat(32) }))).ok).toBe(true);
    const got = await s.get(ID);
    expect(got).toMatchObject({ shareId: ID, ownerUsername: "harry", acceptHex: null, endedAt: null });
    expect((await s.listForOwner("harry")).map((r) => r.shareId).sort()).toEqual([ID, ID2].sort());
    expect(await s.listForOwner("someone")).toEqual([]);
    done();
  });

  it("takes the first acceptance only, and none after expiry or an end", async () => {
    const { s, done } = fresh(adapter);
    await s.create(share());
    expect(await s.accept(ID, "c1", 2000)).toEqual({ ok: true });
    expect(await s.accept(ID, "c2", 2001)).toEqual({ ok: false, reason: "already-accepted" });
    expect((await s.get(ID))?.acceptHex).toBe("c1");
    expect(await s.accept(ID2, "c1", 2000)).toEqual({ ok: false, reason: "unknown" });
    await s.create(share({ shareId: ID2, tokenHash: "ab".repeat(32) }));
    expect(await s.accept(ID2, "c1", 10_000)).toEqual({ ok: false, reason: "expired" });
    await s.end(ID2, "revoke", "{}", 3000);
    expect(await s.accept(ID2, "c1", 3001)).toEqual({ ok: false, reason: "ended" });
    done();
  });

  it("ends a share once, drops its boot copy, and lists ends per server", async () => {
    const { s, done } = fresh(adapter);
    await s.create(share());
    await s.create(share({ shareId: ID2, tokenHash: "ab".repeat(32), serverDomain: "media.harry.flagship.services" }));
    await s.putUnlock(unlock());
    expect(await s.unlockForMember(S, "bb".repeat(32))).toMatchObject({ shareId: ID });
    expect(await s.end(ID, "leave", '{"leave":1}', 4000)).toBe(true);
    expect(await s.end(ID, "revoke", "{}", 4001)).toBe(false);
    expect(await s.getUnlock(ID)).toBeNull();
    expect(await s.unlockForMember(S, "bb".repeat(32))).toBeNull();
    expect(await s.endsForServer(S, 0, 10)).toEqual([{ shareId: ID, kind: "leave", endJson: '{"leave":1}', endedAt: 4000 }]);
    expect(await s.endsForServer(S, 4001, 10)).toEqual([]);
    expect(await s.endsForServer("media.harry.flagship.services", 0, 10)).toEqual([]);
    done();
  });

  it("replaces a boot copy and withdraws it", async () => {
    const { s, done } = fresh(adapter);
    await s.create(share());
    await s.putUnlock(unlock(ID, 5));
    await s.putUnlock({ ...unlock(ID, 6), sealedKeyHex: "aa" });
    expect((await s.getUnlock(ID))?.sealedKeyHex).toBe("aa");
    expect(await s.unlockForMember(S, "cc".repeat(32))).toBeNull();
    expect(await s.deleteUnlock(ID)).toBe(true);
    expect(await s.deleteUnlock(ID)).toBe(false);
    done();
  });

  it("keeps an inbox, capped, per inbox id", async () => {
    const { s, done } = fresh(adapter);
    const e = (entryId: string, createdAt: number) => ({ inboxId: "11".repeat(32), entryId, ctHex: `ct${entryId}`, createdAt });
    expect(await s.inboxPut(e("a1".repeat(16), 1), 2)).toBe(true);
    expect(await s.inboxPut(e("a2".repeat(16), 2), 2)).toBe(true);
    expect(await s.inboxPut(e("a3".repeat(16), 3), 2)).toBe(false);
    expect(await s.inboxPut({ ...e("a1".repeat(16), 9), ctHex: "new" }, 2)).toBe(true);
    const list = await s.inboxList("11".repeat(32));
    expect(list.map((r) => r.ctHex)).toEqual(["new", `ct${"a2".repeat(16)}`]);
    expect(await s.inboxList("22".repeat(32))).toEqual([]);
    expect(await s.inboxDelete("11".repeat(32), "a1".repeat(16))).toBe(true);
    expect(await s.inboxDelete("11".repeat(32), "a1".repeat(16))).toBe(false);
    done();
  });
});
