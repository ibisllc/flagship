/**
 * RequestD1: the per-request D1 view that sends reads issued together as one
 * batch and remembers a read until something writes. It must give the same
 * answers as the bare binding; it only changes how many round trips they cost.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, type D1Database, type D1PreparedStatement } from "../src/d1.js";
import { RequestD1 } from "../src/requestD1.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

/** Counts what reaches the database, by call kind. */
function counting(db: D1Database) {
  const calls = { prepared: 0, batches: 0, batchSizes: [] as number[], singles: 0, writes: 0 };
  const wrapStmt = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    __inner: stmt,
    bind: (...v: unknown[]) => wrapStmt(stmt.bind(...v), sql),
    first: ((...a: unknown[]) => {
      calls.singles++;
      return (stmt.first as (...x: unknown[]) => Promise<unknown>)(...a);
    }) as D1PreparedStatement["first"],
    all: ((...a: unknown[]) => {
      calls.singles++;
      return (stmt.all as (...x: unknown[]) => Promise<unknown>)(...a);
    }) as D1PreparedStatement["all"],
    run: () => {
      calls.writes++;
      return stmt.run();
    },
  } as D1PreparedStatement);
  const wrapped = {
    prepare: (sql: string) => {
      calls.prepared++;
      return wrapStmt(db.prepare(sql), sql);
    },
    batch: (stmts: D1PreparedStatement[]) => {
      calls.batches++;
      calls.batchSizes.push(stmts.length);
      return db.batch(stmts.map((x) => (x as unknown as { __inner: D1PreparedStatement }).__inner ?? x));
    },
    exec: db.exec?.bind(db),
  } as D1Database;
  return { db: wrapped, calls };
}

async function seeded() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  for (const name of ["alice", "bob", "carol"]) {
    await storage.usernames.put({ username: name, irkPubHex: "ab".repeat(32), claimedAt: 1 });
  }
  return sqlite as unknown as D1Database;
}

describe("RequestD1 batching", () => {
  it("sends reads started in the same turn as one batch and answers each as the bare binding does", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db);
    const s = new D1Storage(req);
    const [a, b, missing] = await Promise.all([
      s.usernames.get("alice"),
      s.usernames.get("bob"),
      s.usernames.get("nobody"),
    ]);
    expect(a?.username).toBe("alice");
    expect(b?.username).toBe("bob");
    expect(missing).toBeUndefined();
    expect(calls.batches).toBe(1);
    expect(calls.batchSizes).toEqual([3]);
    expect(calls.singles).toBe(0);

    const bare = new D1Storage(raw);
    expect(a).toEqual(await bare.usernames.get("alice"));
    expect(missing).toEqual(await bare.usernames.get("nobody"));
  });

  it("a lone read goes to the database as it would have, with no batch", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const s = new D1Storage(new RequestD1(db));
    expect((await s.usernames.get("carol"))?.username).toBe("carol");
    expect(calls.batches).toBe(0);
    expect(calls.singles).toBe(1);
  });

  it("reads that wait a microtask or two before querying still join the batch", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db);
    const read = async (name: string) => {
      await Promise.resolve();
      await Promise.resolve();
      return req.prepare("SELECT * FROM usernames WHERE username = ?").bind(name).first<{ username: string }>();
    };
    const [a, b] = await Promise.all([read("alice"), read("bob")]);
    expect([a?.username, b?.username]).toEqual(["alice", "bob"]);
    expect(calls.batches).toBe(1);
  });

  it("falls back to one read at a time when the batch fails, so a bad read fails alone", async () => {
    const raw = await seeded();
    const req = new RequestD1(raw);
    const good = req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first<{ username: string }>();
    const bad = req.prepare("SELECT * FROM no_such_table WHERE x = ?").bind(1).first();
    const results = await Promise.allSettled([good, bad]);
    expect(results[0]!.status).toBe("fulfilled");
    expect((results[0] as PromiseFulfilledResult<{ username: string } | null>).value?.username).toBe("alice");
    expect(results[1]!.status).toBe("rejected");
  });

  it("splits a very large wave into several batches", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        req.prepare("SELECT * FROM usernames WHERE username = ?").bind(`u${i}`).first(),
      ),
    );
    expect(calls.batchSizes.reduce((a, b) => a + b, 0)).toBe(60);
    expect(Math.max(...calls.batchSizes)).toBeLessThanOrEqual(25);
  });

  it("all() returns every row and first() the first", async () => {
    const raw = await seeded();
    const req = new RequestD1(raw);
    const [all, first] = await Promise.all([
      req.prepare("SELECT username FROM usernames ORDER BY username").all<{ username: string }>(),
      req.prepare("SELECT username FROM usernames ORDER BY username").first<{ username: string }>(),
    ]);
    expect(all.results.map((r) => r.username)).toEqual(["alice", "bob", "carol"]);
    expect(first?.username).toBe("alice");
    expect(all.success).toBe(true);
  });
});

describe("RequestD1 request-scoped memory", () => {
  it("answers a repeated read from memory", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const s = new D1Storage(new RequestD1(db));
    await s.usernames.get("alice");
    await s.usernames.get("alice");
    await s.usernames.get("alice");
    expect(calls.singles + calls.batches).toBe(1);
  });

  it("a caller changing a returned row does not change what the next caller gets", async () => {
    const raw = await seeded();
    const req = new RequestD1(raw);
    const q = () => req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first<{ username: string }>();
    const one = (await q())!;
    one.username = "mallory";
    expect((await q())!.username).toBe("alice");
  });

  it("a write to the same table empties the memory, so the next read sees the write", async () => {
    const raw = await seeded();
    const req = new RequestD1(raw);
    const s = new D1Storage(req);
    expect((await s.usernames.get("dave"))).toBeUndefined();
    await s.usernames.put({ username: "dave", irkPubHex: "cd".repeat(32), claimedAt: 2 });
    expect((await s.usernames.get("dave"))?.username).toBe("dave");
  });

  it("a write to ANY non-leaf table empties it (a foreign key may cascade)", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db);
    await req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first();
    await req.prepare("INSERT INTO username_suggestion_queue (name, enqueued_at) VALUES (?, ?)").bind("zed", 1).run();
    const before = calls.singles + calls.batches;
    await req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first();
    expect(calls.singles + calls.batches).toBe(before + 1);
  });

  it("a replay-nonce write (a leaf table) keeps the memory", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db);
    await req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first();
    await req.batch([
      req.prepare("DELETE FROM boot_nonces WHERE expires_at <= ?1").bind(5),
      req.prepare("INSERT INTO boot_nonces (nonce_key, expires_at) VALUES (?1, ?2)").bind("k", 9),
    ]);
    const before = calls.singles + calls.batches;
    await req.prepare("SELECT * FROM usernames WHERE username = ?").bind("alice").first();
    expect(calls.singles + calls.batches).toBe(before); // answered from memory
  });

  it("a read that was in flight when a write happened is not remembered", async () => {
    const raw = await seeded();
    const req = new RequestD1(raw);
    const inflight = req.prepare("SELECT * FROM usernames WHERE username = ?").bind("erin").first();
    // Starting the write flushes the queued read first, then invalidates.
    await req.prepare("INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES (?, ?, ?)").bind("erin", "ab".repeat(32), 3).run();
    await inflight;
    const after = await req.prepare("SELECT * FROM usernames WHERE username = ?").bind("erin").first<{ username: string }>();
    expect(after?.username).toBe("erin");
  });

  it("cache:false still batches but never remembers (the held stream must see change)", async () => {
    const raw = await seeded();
    const { db, calls } = counting(raw);
    const req = new RequestD1(db, { cache: false });
    const s = new D1Storage(req);
    await Promise.all([s.usernames.get("alice"), s.usernames.get("bob")]);
    expect(calls.batches).toBe(1);
    await s.usernames.get("alice");
    await s.usernames.get("alice");
    expect(calls.singles).toBe(2);
    // and a change made behind its back shows on the next read
    await new D1Storage(raw).usernames.put({ username: "frank", irkPubHex: "ef".repeat(32), claimedAt: 4 });
    expect((await s.usernames.get("frank"))?.username).toBe("frank");
  });

  it("two requests do not share memory", async () => {
    const raw = await seeded();
    const first = new D1Storage(new RequestD1(raw));
    expect((await first.usernames.get("gina"))).toBeUndefined();
    await new D1Storage(raw).usernames.put({ username: "gina", irkPubHex: "12".repeat(32), claimedAt: 5 });
    const second = new D1Storage(new RequestD1(raw));
    expect((await second.usernames.get("gina"))?.username).toBe("gina");
  });
});
