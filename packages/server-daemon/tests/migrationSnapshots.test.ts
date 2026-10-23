import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMigrationSnapshots, NO_DATABASE_SNAPSHOT } from "../src/migrationSnapshots.js";

const store = (db: string) => ({ database: db, role: "r", url: `postgres://r:p@127.0.0.1/${db}` });
const data = { creator: "alice", slug: "chess", postgres: { main: store("db_main"), cache: store("db_cache") } } as never;

function rig(dataOf: () => unknown = () => data) {
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  const dumped: string[] = [];
  const restored: Array<{ db: string; body: string; replace: boolean | undefined }> = [];
  let t = 1000;
  const snaps = buildMigrationSnapshots({
    dir,
    ops: {
      dumpDatabase: async (s, out) => { dumped.push(s.database); await writeFile(out, `rows-of-${s.database}-at-${t}`); },
      restoreDatabase: async (s, p, o) => { restored.push({ db: s.database, body: await readFile(p, "utf8"), replace: o?.replace }); },
    },
    dataOf: dataOf as never,
    now: () => ++t,
  });
  return { snaps, dir, dumped, restored };
}

describe("migration snapshots", () => {
  it("dumps every database before a batch and puts them back over themselves", async () => {
    const { snaps, dumped, restored } = rig();
    const id = await snaps.snapshotData("alice--chess");
    expect(dumped.sort()).toEqual(["db_cache", "db_main"]);
    await snaps.restoreData("alice--chess", id);
    expect(restored.map((r) => r.db).sort()).toEqual(["db_cache", "db_main"]);
    expect(restored.every((r) => r.replace === true)).toBe(true);
    expect(restored.find((r) => r.db === "db_main")!.body).toContain("rows-of-db_main");
  });

  it("an app with no database has nothing to snapshot or restore", async () => {
    const { snaps, dumped, restored } = rig(() => null);
    const id = await snaps.snapshotData("alice--static");
    expect(id).toBe(NO_DATABASE_SNAPSHOT);
    await snaps.restoreData("alice--static", id);
    expect(dumped).toEqual([]);
    expect(restored).toEqual([]);
  });

  it("keeps the last two per app, and an uninstall removes them all", async () => {
    const { snaps, dir } = rig();
    for (let i = 0; i < 4; i++) await snaps.snapshotData("alice--chess");
    expect(readdirSync(join(dir, "alice--chess"))).toHaveLength(2);
    await snaps.forget("alice--chess");
    expect(existsSync(join(dir, "alice--chess"))).toBe(false);
  });

  it("a failed dump leaves no half snapshot, and unsafe ids are refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const snaps = buildMigrationSnapshots({
      dir,
      ops: { dumpDatabase: async () => { throw new Error("pg_dump failed"); }, restoreDatabase: async () => {} },
      dataOf: () => data,
    });
    await expect(snaps.snapshotData("alice--chess")).rejects.toThrow("pg_dump failed");
    expect(readdirSync(join(dir, "alice--chess"))).toEqual([]);
    await expect(snaps.snapshotData("../escape")).rejects.toThrow("unsafe");
    await expect(snaps.restoreData("alice--chess", "../../etc")).rejects.toThrow("unsafe");
  });
});
