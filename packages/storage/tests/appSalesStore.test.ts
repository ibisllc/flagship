import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1AppSalesStorage, InMemoryAppSalesStorage } from "../src/index.js";
import type { AppSaleRecord, AppSalesStorage } from "../src/index.js";

// Parity suite: the SAME assertions run against the real D1 adapter (over
// sqlite with migration 0091 applied) AND the InMemory store, so both stay
// byte-for-byte behaviorally identical (#15 developer payouts ledger).

function sale(over: Partial<AppSaleRecord> = {}): AppSaleRecord {
  return {
    saleKey: "evt_1",
    listingId: "acme--notes",
    creatorAccount: "acme",
    buyerAccount: "bob",
    grossCents: 1000,
    cutCents: 150,
    netCents: 850,
    currency: "usd",
    stripeEventId: "evt_1",
    at: 1000,
    ...over,
  };
}

function suite(name: string, make: () => AppSalesStorage, teardown?: () => void) {
  describe(name, () => {
    afterEach(() => teardown?.());

    it("record() is idempotent on saleKey; a redelivery is a no-op", async () => {
      const store = make();
      expect(await store.record(sale())).toBe(true);
      // same key (stripe redelivery), even with different amounts ⇒ ignored
      expect(await store.record(sale({ grossCents: 9999 }))).toBe(false);
      const rows = await store.listForCreator("acme");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.grossCents).toBe(1000); // first write wins
    });

    it("listForCreator() scopes to the creator, newest first", async () => {
      const store = make();
      await store.record(sale({ saleKey: "e1", at: 1000, buyerAccount: "bob" }));
      await store.record(sale({ saleKey: "e2", at: 3000, buyerAccount: "carol" }));
      await store.record(sale({ saleKey: "e3", at: 2000, creatorAccount: "other", listingId: "other--x" }));
      const acme = await store.listForCreator("acme");
      expect(acme.map((r) => r.saleKey)).toEqual(["e2", "e1"]); // at DESC
      expect(acme.every((r) => r.creatorAccount === "acme")).toBe(true);
    });

    it("totalsForCreator() rolls up gross/cut/net + count", async () => {
      const store = make();
      await store.record(sale({ saleKey: "e1", grossCents: 1000, cutCents: 150, netCents: 850 }));
      await store.record(sale({ saleKey: "e2", grossCents: 500, cutCents: 75, netCents: 425 }));
      await store.record(sale({ saleKey: "e3", creatorAccount: "other", grossCents: 1, cutCents: 0, netCents: 1 }));
      const t = await store.totalsForCreator("acme");
      expect(t).toEqual({ grossCents: 1500, cutCents: 225, netCents: 1275, saleCount: 2 });
      const empty = await store.totalsForCreator("nobody");
      expect(empty).toEqual({ grossCents: 0, cutCents: 0, netCents: 0, saleCount: 0 });
    });

    it("keeps an absent stripeEventId (admin/voucher comp) round-tripping", async () => {
      const store = make();
      const { stripeEventId, ...noStripe } = sale({ saleKey: "admin:acme:notes:bob" });
      void stripeEventId;
      await store.record(noStripe as AppSaleRecord);
      const rows = await store.listForCreator("acme");
      expect(rows[0]!.stripeEventId).toBeUndefined();
    });
  });
}

suite("InMemoryAppSalesStorage", () => new InMemoryAppSalesStorage());

let db: SqliteD1 | undefined;
suite(
  "D1AppSalesStorage (real sqlite, migration 0091)",
  () => {
    db = createSqliteD1();
    return new D1AppSalesStorage(db);
  },
  () => {
    db?.close();
    db = undefined;
  },
);
