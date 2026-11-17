/**
 * BoxProxyLaneStorage (migration 0155): the newest owner-signed proxy order left
 * for an unreachable box, and the box's proxy-failing report.
 */
import { afterAll, describe, expect, it } from "vitest";
import { D1BoxProxyLaneStorage, InMemoryBoxProxyLaneStorage, type BoxProxyLaneStorage } from "../src/index.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";

const handles: SqliteD1[] = [];
afterAll(() => {
  for (const h of handles) h.close();
});

const adapters: Array<[string, () => BoxProxyLaneStorage]> = [
  ["InMemory", () => new InMemoryBoxProxyLaneStorage()],
  [
    "D1",
    () => {
      const s = createSqliteD1();
      handles.push(s);
      return new D1BoxProxyLaneStorage(s);
    },
  ],
];

const d = "home.alice.flagship.services";

describe.each(adapters)("BoxProxyLaneStorage (%s)", (_name, make) => {
  it("keeps only a newer order", async () => {
    const s = make();
    expect(await s.getOrder(d)).toBeNull();
    expect(await s.putOrderIfNewer(d, "alice", { orderJson: "{\"a\":1}", signatureHex: "aa", issuedAt: 10 })).toBe(true);
    expect(await s.putOrderIfNewer(d, "alice", { orderJson: "{\"a\":0}", signatureHex: "bb", issuedAt: 9 })).toBe(false);
    expect(await s.putOrderIfNewer(d, "alice", { orderJson: "{\"a\":2}", signatureHex: "cc", issuedAt: 11 })).toBe(true);
    expect(await s.getOrder(d)).toEqual({ orderJson: "{\"a\":2}", signatureHex: "cc", issuedAt: 11 });
  });

  it("sets, lists and clears an alert, returning the previous one", async () => {
    const s = make();
    expect(await s.setAlert(d, "alice", { state: "failing", code: "auth", since: 5, at: 6 })).toBeNull();
    expect(await s.alertsForUser("alice")).toEqual([{ serverDomain: d, state: "failing", code: "auth", since: 5, at: 6 }]);
    expect(await s.alertsForUser("bob")).toEqual([]);
    const prev = await s.setAlert(d, "alice", null);
    expect(prev?.state).toBe("failing");
    expect(await s.alertsForUser("alice")).toEqual([]);
    await s.putOrderIfNewer(d, "alice", { orderJson: "{}", signatureHex: "aa", issuedAt: 1 });
    await s.setAlert(d, "alice", { state: "fallback", code: "unreachable", since: 1, at: 2 });
    expect((await s.getOrder(d))?.issuedAt).toBe(1);
  });
});
