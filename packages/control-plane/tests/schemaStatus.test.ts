import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InMemorySchemaVersionStorage } from "@flagship/storage";
import {
  KNOWN_MIGRATIONS,
  handleSchemaStatus,
  handleStampSchemaVersion,
} from "../src/schemaStatus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  HERE,
  "..",
  "..",
  "storage",
  "migrations",
);

describe("KNOWN_MIGRATIONS drift guard", () => {
  it("matches the on-disk migration filenames exactly", () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort((a, b) => a.localeCompare(b));
    expect([...KNOWN_MIGRATIONS].sort((a, b) => a.localeCompare(b))).toEqual(
      onDisk,
    );
  });
});

describe("handleSchemaStatus", () => {
  it("reports everything missing when the ledger is empty", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    const r = await handleSchemaStatus({
      schemaVersion,
      known: ["0001", "0002", "0003"],
    });
    expect(r.status).toBe(200);
    expect(r.body.missing).toEqual(["0001", "0002", "0003"]);
    expect(r.body.applied).toEqual([]);
    expect(r.body.unknown).toEqual([]);
    expect(r.body.inSync).toBe(false);
  });

  it("reports inSync when every known migration is recorded", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    await schemaVersion.record("0001", 10);
    await schemaVersion.record("0002", 20);
    const r = await handleSchemaStatus({
      schemaVersion,
      known: ["0001", "0002"],
    });
    expect(r.body.missing).toEqual([]);
    expect(r.body.unknown).toEqual([]);
    expect(r.body.inSync).toBe(true);
    expect(r.body.applied).toEqual([
      { version: "0001", appliedAt: 10 },
      { version: "0002", appliedAt: 20 },
    ]);
  });

  it("surfaces partial drift (some applied, some missing)", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    await schemaVersion.record("0001", 10);
    const r = await handleSchemaStatus({
      schemaVersion,
      known: ["0001", "0002", "0003"],
    });
    expect(r.body.missing).toEqual(["0002", "0003"]);
    expect(r.body.inSync).toBe(false);
  });

  it("flags ledger rows ahead of the repo's known set as unknown", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    await schemaVersion.record("0001", 10);
    await schemaVersion.record("9999", 99);
    const r = await handleSchemaStatus({
      schemaVersion,
      known: ["0001"],
    });
    expect(r.body.unknown).toEqual(["9999"]);
    expect(r.body.inSync).toBe(false);
  });
});

describe("handleStampSchemaVersion", () => {
  it("records a new version and reports recorded=true", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    const r = await handleStampSchemaVersion(
      { schemaVersion, now: () => 1234 },
      "0049",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      version: "0049",
      recorded: true,
      alreadyPresent: false,
    });
    expect(await schemaVersion.has("0049")).toBe(true);
  });

  it("is idempotent — a second stamp reports alreadyPresent", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    await handleStampSchemaVersion({ schemaVersion, now: () => 1 }, "0049");
    const r = await handleStampSchemaVersion(
      { schemaVersion, now: () => 999 },
      "0049",
    );
    expect(r.body.recorded).toBe(false);
    expect(r.body.alreadyPresent).toBe(true);
    // First stamp's timestamp wins.
    expect(await schemaVersion.list()).toEqual([
      { version: "0049", appliedAt: 1 },
    ]);
  });

  it("rejects a malformed version id with 400", async () => {
    const schemaVersion = new InMemorySchemaVersionStorage();
    const r = await handleStampSchemaVersion(
      { schemaVersion, now: () => 1 },
      "not-a-version",
    );
    expect(r.status).toBe(400);
    expect(await schemaVersion.list()).toEqual([]);
  });
});
