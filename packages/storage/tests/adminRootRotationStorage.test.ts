/**
 * Storage adapter contract — Slice D §5 admin-root rotation lane +
 * `usernames.swapAdminRootPub` CAS. Runs the SAME assertions against BOTH the
 * InMemory adapter and the real D1-over-SQLite adapter (migration 0066 applied),
 * so an adapter divergence fails here in milliseconds.
 */
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage } from "../src/d1.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import type { Storage } from "../src/types.js";

const openHandles: SqliteD1[] = [];
afterAll(() => {
  for (const h of openHandles) h.close();
});

async function bothAdapters<T>(body: (s: Storage) => Promise<T>): Promise<{ mem: T; d1: T }> {
  const sqlite = createSqliteD1();
  openHandles.push(sqlite);
  const mem = await body(new InMemoryStorage());
  const d1 = await body(new D1Storage(sqlite));
  return { mem, d1 };
}

const A0 = "a0".repeat(32);
const A1 = "a1".repeat(32);
const A2 = "a2".repeat(32);

describe("AdminRootRotationStorage", () => {
  it("append assigns 1-based seq and list returns the ordered chain", async () => {
    const r = await bothAdapters(async (s) => {
      const seq1 = await s.adminRootRotations.append({
        username: "Alice",
        oldAdminRootPubHex: A0,
        newAdminRootPubHex: A1,
        issuedAt: 1000,
        signatureHex: "cc".repeat(64),
      });
      const seq2 = await s.adminRootRotations.append({
        username: "alice",
        oldAdminRootPubHex: A1,
        newAdminRootPubHex: A2,
        issuedAt: 2000,
        signatureHex: "dd".repeat(64),
      });
      const chain = await s.adminRootRotations.list("alice");
      return { seq1, seq2, chain };
    });
    expect(r.d1).toEqual(r.mem);
    expect(r.mem.seq1).toBe(1);
    expect(r.mem.seq2).toBe(2);
    expect(r.mem.chain.map((c) => c.seq)).toEqual([1, 2]);
    expect(r.mem.chain[0]).toMatchObject({ oldAdminRootPubHex: A0, newAdminRootPubHex: A1 });
    expect(r.mem.chain[1]).toMatchObject({ oldAdminRootPubHex: A1, newAdminRootPubHex: A2 });
  });

  it("list of an account with no rotations is empty in both", async () => {
    const r = await bothAdapters((s) => s.adminRootRotations.list("nobody"));
    expect(r.d1).toEqual(r.mem);
    expect(r.mem).toEqual([]);
  });
});

describe("usernames.swapAdminRootPub CAS", () => {
  it("swaps only when the expected old root matches the stored value", async () => {
    const r = await bothAdapters(async (s) => {
      await s.usernames.put({ username: "alice", irkPubHex: "aa", claimedAt: 1, adminRootPubHex: A0 });
      const wrongOld = await s.usernames.swapAdminRootPub("alice", A2, A1); // stale → false
      const afterWrong = (await s.usernames.get("alice"))?.adminRootPubHex;
      const ok = await s.usernames.swapAdminRootPub("alice", A0, A1); // correct → true
      const afterOk = (await s.usernames.get("alice"))?.adminRootPubHex;
      return { wrongOld, afterWrong, ok, afterOk };
    });
    expect(r.d1).toEqual(r.mem);
    expect(r.mem.wrongOld).toBe(false);
    expect(r.mem.afterWrong).toBe(A0);
    expect(r.mem.ok).toBe(true);
    expect(r.mem.afterOk).toBe(A1);
  });

  it("returns false when the account has no admin root pinned", async () => {
    const r = await bothAdapters(async (s) => {
      await s.usernames.put({ username: "bob", irkPubHex: "bb", claimedAt: 1 });
      const res = await s.usernames.swapAdminRootPub("bob", A0, A1);
      const after = (await s.usernames.get("bob"))?.adminRootPubHex;
      return { res, after: after ?? null };
    });
    expect(r.d1).toEqual(r.mem);
    expect(r.mem.res).toBe(false);
    expect(r.mem.after).toBeNull();
  });

  it("returns false for an unknown username", async () => {
    const r = await bothAdapters((s) => s.usernames.swapAdminRootPub("ghost", A0, A1));
    expect(r.d1).toEqual(r.mem);
    expect(r.mem).toBe(false);
  });
});
