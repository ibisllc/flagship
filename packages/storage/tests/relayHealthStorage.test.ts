/**
 * RelayHealthStorage (migration 0099): per-day arrival counts and the latest
 * relay probe, against the InMemory adapter and the D1 adapter over a fully
 * migrated node:sqlite.
 */
import { afterAll, describe, expect, it } from "vitest";
import { D1RelayHealthStorage, InMemoryRelayHealthStorage, type RelayHealthStorage } from "../src/index.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";

const handles: SqliteD1[] = [];
afterAll(() => {
  for (const h of handles) h.close();
});

const adapters: Array<[string, () => RelayHealthStorage]> = [
  ["InMemory", () => new InMemoryRelayHealthStorage()],
  [
    "D1",
    () => {
      const s = createSqliteD1();
      handles.push(s);
      return new D1RelayHealthStorage(s);
    },
  ],
];

describe.each(adapters)("RelayHealthStorage (%s)", (_name, make) => {
  it("counts arrivals per day and path", async () => {
    const s = make();
    await s.bump("2026-10-15", "ohttp");
    await s.bump("2026-10-15", "ohttp");
    await s.bump("2026-10-15", "direct-fallback");
    await s.bump("2026-10-14", "ohttp");
    await s.bump("2026-10-01", "direct-fallback");
    expect(await s.counts(["2026-10-15"])).toEqual({ ohttp: 2, "direct-fallback": 1 });
    expect(await s.counts(["2026-10-15", "2026-10-14"])).toEqual({ ohttp: 3, "direct-fallback": 1 });
    expect(await s.counts([])).toEqual({ ohttp: 0, "direct-fallback": 0 });
  });

  it("keeps only the latest probe", async () => {
    const s = make();
    expect(await s.lastProbe()).toBeNull();
    await s.recordProbe({ ok: false, at: 1, detail: "relay-402" });
    await s.recordProbe({ ok: true, at: 2, detail: "ok" });
    expect(await s.lastProbe()).toEqual({ ok: true, at: 2, detail: "ok" });
  });
});
