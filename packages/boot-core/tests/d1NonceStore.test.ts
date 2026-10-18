/**
 * The D1 replay-nonce store claims a key in ONE round trip (a batch of the two
 * deletes and the insert). It must still answer exactly as the three-call
 * version did: first claim wins, a replay loses, an expired key can be taken
 * again, and expired rows of other keys are pruned.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import { D1NonceStore } from "../src/nonceStore.js";

function setup() {
  const sqlite = createSqliteD1();
  let batches = 0;
  let runs = 0;
  const db = {
    prepare: (q: string) => {
      const s = sqlite.prepare(q);
      const orig = s.run.bind(s);
      s.run = (() => {
        runs++;
        return orig();
      }) as typeof s.run;
      return s;
    },
    batch: (stmts: Parameters<D1Database["batch"]>[0]) => {
      batches++;
      return sqlite.batch(stmts);
    },
  } as unknown as D1Database;
  return { sqlite, store: new D1NonceStore(db), counts: () => ({ batches, runs }) };
}

describe("D1NonceStore", () => {
  it("first claim wins, a replay inside the window loses", async () => {
    const { store } = setup();
    expect(await store.claim("k1", 2_000, 1_000)).toBe(true);
    expect(await store.claim("k1", 2_000, 1_500)).toBe(false);
    expect(await store.claim("k2", 2_000, 1_500)).toBe(true);
  });

  it("an expired key can be claimed again", async () => {
    const { store } = setup();
    expect(await store.claim("k", 2_000, 1_000)).toBe(true);
    expect(await store.claim("k", 4_000, 2_000)).toBe(true); // expires_at <= now
    expect(await store.claim("k", 4_000, 3_000)).toBe(false);
  });

  it("prunes other keys' expired rows on a successful claim", async () => {
    const { store, sqlite } = setup();
    await store.claim("old", 1_500, 1_000);
    await store.claim("fresh", 9_000, 1_000);
    await store.claim("new", 9_000, 2_000);
    const keys = (sqlite.raw.prepare("SELECT nonce_key FROM boot_nonces ORDER BY nonce_key").all() as { nonce_key: string }[]).map((r) => r.nonce_key);
    expect(keys).toEqual(["fresh", "new"]);
  });

  it("takes one D1 round trip per claim", async () => {
    const { store, counts } = setup();
    await store.claim("a", 2_000, 1_000);
    await store.claim("a", 2_000, 1_100); // refused
    expect(counts()).toEqual({ batches: 2, runs: 0 });
  });
});
