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
  return { mem: await body(new InMemoryStorage()), d1: await body(new D1Storage(sqlite)) };
}

describe("ServerHealthStorage", () => {
  it("deletes a server's report, whatever its case, and only that one", async () => {
    const r = await bothAdapters(async (s) => {
      for (const d of ["home.bob.flagship.services", "blog.bob.flagship.services"]) {
        await s.serverHealth.put({ serverDomain: d, reportJson: "{}", reportedAt: 1, receivedAt: 2 });
      }
      await s.serverHealth.delete("HOME.bob.flagship.services");
      await s.serverHealth.delete("never.bob.flagship.services");
      return [
        await s.serverHealth.get("home.bob.flagship.services"),
        (await s.serverHealth.get("blog.bob.flagship.services"))?.receivedAt,
      ];
    });
    expect(r.mem).toEqual([undefined, 2]);
    expect(r.d1).toEqual(r.mem);
  });
});
