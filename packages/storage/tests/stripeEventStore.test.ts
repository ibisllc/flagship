import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1StripeEventStore } from "../src/d1.js";

// Exercises migration 0053 + D1StripeEventStore against real sqlite so the
// idempotent INSERT OR IGNORE `changes` semantics are validated, not mocked.

describe("D1StripeEventStore (real sqlite, migration 0053)", () => {
  let db: SqliteD1;
  afterEach(() => db?.close());

  it("claim() returns true only for the FIRST delivery of an event id", async () => {
    db = createSqliteD1();
    const store = new D1StripeEventStore(db);
    expect(await store.claim("evt_1", "checkout.session.completed", 1000)).toBe(true);
    expect(await store.claim("evt_1", "checkout.session.completed", 2000)).toBe(false); // redelivery
    expect(await store.claim("evt_2", "invoice.paid", 3000)).toBe(true); // distinct id
  });

  it("persists the audit row (type + processed_at) of the first claim only", async () => {
    db = createSqliteD1();
    const store = new D1StripeEventStore(db);
    await store.claim("evt_a", "invoice.paid", 5000);
    await store.claim("evt_a", "invoice.paid", 9999); // ignored
    const row = db.raw
      .prepare("SELECT event_type, processed_at FROM stripe_events WHERE event_id = ?")
      .get("evt_a") as { event_type: string; processed_at: number };
    expect(row.event_type).toBe("invoice.paid");
    expect(row.processed_at).toBe(5000); // not overwritten by the redelivery
  });
});
