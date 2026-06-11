import { describe, expect, it } from "vitest";
import { InMemorySchemaVersionStorage } from "../src/inMemory.js";

describe("SchemaVersionStorage (OPS-2 migration ledger)", () => {
  it("records a version and reads it back", async () => {
    const s = new InMemorySchemaVersionStorage();
    expect(await s.has("0049")).toBe(false);
    const inserted = await s.record("0049", 1000);
    expect(inserted).toBe(true);
    expect(await s.has("0049")).toBe(true);
    const all = await s.list();
    expect(all).toEqual([{ version: "0049", appliedAt: 1000 }]);
  });

  it("re-recording an existing version is an idempotent no-op (first stamp wins)", async () => {
    const s = new InMemorySchemaVersionStorage();
    expect(await s.record("0049", 1000)).toBe(true);
    // Second record returns false and must NOT overwrite appliedAt.
    expect(await s.record("0049", 9999)).toBe(false);
    const all = await s.list();
    expect(all).toEqual([{ version: "0049", appliedAt: 1000 }]);
  });

  it("lists versions ascending by version id", async () => {
    const s = new InMemorySchemaVersionStorage();
    await s.record("0049", 30);
    await s.record("0001", 10);
    await s.record("0030", 20);
    const all = await s.list();
    expect(all.map((r) => r.version)).toEqual(["0001", "0030", "0049"]);
  });

  it("returns an empty list before anything is recorded", async () => {
    const s = new InMemorySchemaVersionStorage();
    expect(await s.list()).toEqual([]);
  });
});
