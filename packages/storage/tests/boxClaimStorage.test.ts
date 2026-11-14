/**
 * BoxClaimStorage (migration 0134): the phone's pre-registered box key per AuthCode and the blind
 * remote-claim mailbox, against the InMemory adapter and the D1 adapter over a fully migrated
 * node:sqlite.
 */
import { afterAll, describe, expect, it } from "vitest";
import { D1BoxClaimStorage, InMemoryBoxClaimStorage, type BoxClaimStorage } from "../src/index.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";

const handles: SqliteD1[] = [];
afterAll(() => {
  for (const h of handles) h.close();
});

const adapters: Array<[string, () => BoxClaimStorage]> = [
  ["InMemory", () => new InMemoryBoxClaimStorage()],
  [
    "D1",
    () => {
      const s = createSqliteD1();
      handles.push(s);
      return new D1BoxClaimStorage(s);
    },
  ],
];

const T0 = 1_790_000_000_000;
const LIMITS = { ttlMs: 3_600_000, maxPerDir: 3 };
const MB = "a".repeat(64);

describe.each(adapters)("BoxClaimStorage (%s)", (_name, make) => {
  it("keeps the first key per serial", async () => {
    const s = make();
    expect(await s.getKey("serial-0001")).toBe(null);
    const rec = { serial: "serial-0001", username: "alice", serverDomain: "home.alice.flagship.services", stkPubHex: "AB".repeat(32), signerPubHex: "cd".repeat(32), issuedAt: T0, recordedAt: T0 };
    expect(await s.putKeyOnce(rec)).toEqual({ ...rec, stkPubHex: "ab".repeat(32) });
    const second = await s.putKeyOnce({ ...rec, stkPubHex: "ef".repeat(32), recordedAt: T0 + 1 });
    expect(second.stkPubHex).toBe("ab".repeat(32));
    expect((await s.getKey("serial-0001"))?.stkPubHex).toBe("ab".repeat(32));
  });

  it("numbers messages per direction and reads after a cursor", async () => {
    const s = make();
    expect(await s.postMessage(MB, "to-box", "h1", T0, LIMITS)).toEqual({ ok: true, seq: 1 });
    expect(await s.postMessage(MB, "to-box", "h2", T0 + 1, LIMITS)).toEqual({ ok: true, seq: 2 });
    expect(await s.postMessage(MB, "to-phone", "p1", T0 + 2, LIMITS)).toEqual({ ok: true, seq: 1 });
    expect(await s.readMessages(MB, "to-box", 0, T0 + 3)).toEqual([{ seq: 1, body: "h1" }, { seq: 2, body: "h2" }]);
    expect(await s.readMessages(MB, "to-box", 1, T0 + 3)).toEqual([{ seq: 2, body: "h2" }]);
    expect(await s.readMessages(MB, "to-phone", 0, T0 + 3)).toEqual([{ seq: 1, body: "p1" }]);
    expect(await s.readMessages("b".repeat(64), "to-box", 0, T0 + 3)).toEqual([]);
  });

  it("caps a direction", async () => {
    const s = make();
    for (let i = 0; i < 3; i++) expect((await s.postMessage(MB, "to-box", `m${i}`, T0, LIMITS)).ok).toBe(true);
    expect(await s.postMessage(MB, "to-box", "m3", T0, LIMITS)).toEqual({ ok: false, reason: "full" });
    expect((await s.postMessage(MB, "to-phone", "x", T0, LIMITS)).ok).toBe(true);
  });

  it("expires a mailbox an hour after its first message, whatever came later", async () => {
    const s = make();
    await s.postMessage(MB, "to-box", "old", T0, LIMITS);
    await s.postMessage(MB, "to-phone", "later", T0 + 3_000_000, LIMITS);
    expect(await s.readMessages(MB, "to-phone", 0, T0 + LIMITS.ttlMs)).toEqual([]);
    expect(await s.postMessage(MB, "to-box", "fresh", T0 + LIMITS.ttlMs, LIMITS)).toEqual({ ok: true, seq: 1 });
    expect(await s.readMessages(MB, "to-box", 0, T0 + LIMITS.ttlMs + 1)).toEqual([{ seq: 1, body: "fresh" }]);
    expect(await s.sweep(T0 + 3 * LIMITS.ttlMs)).toBe(1);
  });
});
