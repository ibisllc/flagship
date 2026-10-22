import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1AppPurchaseStorage } from "../src/d1.js";

// Exercises migration 0054 + D1AppPurchaseStorage against real sqlite so the
// idempotent INSERT OR IGNORE entitlement + the user-listing read are validated.

describe("D1AppPurchaseStorage (real sqlite, migration 0054)", () => {
  let db: SqliteD1;
  afterEach(() => db?.close());

  it("grant() is idempotent per (user, app); has() reflects it", async () => {
    db = createSqliteD1();
    const store = new D1AppPurchaseStorage(db);
    expect(await store.grant({ username: "alice", creator: "acme", slug: "notes", purchasedAt: 1000, source: "stripe", ref: "evt_1" })).toBe(true);
    expect(await store.grant({ username: "alice", creator: "acme", slug: "notes", purchasedAt: 2000, source: "stripe" })).toBe(false);
    expect(await store.has("alice", "acme", "notes")).toBe(true);
    expect(await store.has("alice", "acme", "other")).toBe(false);
    expect(await store.has("bob", "acme", "notes")).toBe(false);
  });

  it("listForUser() returns only that user's apps, newest first", async () => {
    db = createSqliteD1();
    const store = new D1AppPurchaseStorage(db);
    await store.grant({ username: "alice", creator: "acme", slug: "notes", purchasedAt: 1000, source: "admin" });
    await store.grant({ username: "alice", creator: "beta", slug: "draw", purchasedAt: 3000, source: "stripe" });
    await store.grant({ username: "bob", creator: "acme", slug: "notes", purchasedAt: 2000, source: "voucher" });
    const alice = await store.listForUser("alice");
    expect(alice.map((r) => r.slug)).toEqual(["draw", "notes"]); // purchased_at DESC
    expect(alice.every((r) => r.username === "alice")).toBe(true);
  });
});
