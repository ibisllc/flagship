import { describe, expect, it } from "vitest";
import {
  APP_PG_EXTENSIONS,
  DEV_PG_PREFIX,
  assertSafeIdent,
  filesVolume,
  isFilesVolume,
  isProdFilesVolume,
  pgDatabase,
  pgRole,
  type AppDataIdentity,
} from "../src/dataLayer/index.js";
import { STAGING_CREATOR } from "../src/buildmodes/staging.js";

const KEY = "k".repeat(40);
const OTHER_KEY = "o".repeat(40);

const LONG_SLUG = "a-very-long-app-name-that-is-32c"; // 32 chars, the slug max
const LONG_CREATOR = "c".repeat(32);
const LONG_STORE = "s".repeat(14) + "-" + "t".repeat(17); // 32 chars, dashed

const identities: AppDataIdentity[] = [];
for (const creator of ["harry", "dev", "a", "plucky-avocet", LONG_CREATOR]) {
  for (const slug of ["notes", "x", "stg-443ac182b4bc9fe5", `stg-${"f".repeat(28)}`, LONG_SLUG]) {
    for (const storeName of [undefined, "default", "sprites", "main-data", LONG_STORE]) {
      for (const space of ["prod", "dev"] as const) {
        identities.push({ creator, slug, ...(storeName ? { storeName } : {}), space });
      }
    }
  }
}

describe("opaque Postgres names", () => {
  it("are `app_<24 hex>` (prod) or `__dev_<24 hex>` (dev), safe identifiers within 63 chars", () => {
    for (const id of identities) {
      const n = pgDatabase(id, KEY);
      expect(n, n).toMatch(id.space === "dev" ? /^__dev_[0-9a-f]{24}$/ : /^app_[0-9a-f]{24}$/);
      expect(n.length).toBeLessThanOrEqual(63);
      expect(() => assertSafeIdent(n)).not.toThrow();
      expect(pgRole(id, KEY)).toBe(n);
    }
  });

  it("say nothing about the app: no creator, slug or store name in them", () => {
    const n = pgDatabase({ creator: "harry", slug: "habit-tracker", storeName: "photos" }, KEY);
    for (const part of ["harry", "habit", "tracker", "photos"]) expect(n).not.toContain(part);
  });

  it("are stable for one key and differ under another box's key", () => {
    const id = { creator: "harry", slug: "notes" };
    expect(pgDatabase(id, KEY)).toBe(pgDatabase(id, KEY));
    expect(pgDatabase(id, OTHER_KEY)).not.toBe(pgDatabase(id, KEY));
  });

  it("treat the `default` store name as no store name (single-store apps)", () => {
    expect(pgDatabase({ creator: "harry", slug: "x", storeName: "default" }, KEY)).toBe(
      pgDatabase({ creator: "harry", slug: "x" }, KEY),
    );
  });

  it("never collide across distinct identities", () => {
    const seen = new Map<string, string>();
    for (const id of identities) {
      if (id.storeName === "default") continue;
      const key = JSON.stringify([id.creator, id.slug, id.storeName ?? null, id.space]);
      const n = pgDatabase(id, KEY);
      const prev = seen.get(n);
      expect(prev === undefined || prev === key, `${n}: ${prev} vs ${key}`).toBe(true);
      seen.set(n, key);
    }
  });

  it("keep dev disjoint from prod", () => {
    for (const id of identities) {
      const n = pgDatabase(id, KEY);
      expect(n.startsWith(DEV_PG_PREFIX)).toBe(id.space === "dev");
    }
  });

  it("refuse a missing or short name key, and invalid identities", () => {
    expect(() => pgDatabase({ creator: "harry", slug: "x" }, "")).toThrow(/name key/);
    expect(() => pgDatabase({ creator: "harry", slug: "x" }, "short")).toThrow(/name key/);
    expect(() => pgDatabase({ creator: "har--ry", slug: "x" }, KEY)).toThrow();
    expect(() => pgDatabase({ creator: "-harry", slug: "x" }, KEY)).toThrow();
    expect(() => pgDatabase({ creator: "harry", slug: "-foo" }, KEY)).toThrow();
    expect(() => pgDatabase({ creator: "harry", slug: "foo--bar" }, KEY)).toThrow();
    expect(() => pgDatabase({ creator: "harry", slug: "x", storeName: "Main" }, KEY)).toThrow();
  });

  it("the staging copy's dev dataspace gets a dev name", () => {
    const id = { creator: STAGING_CREATOR, slug: "stg-443ac182b4bc9fe5", space: "dev" } as const;
    expect(pgDatabase(id, KEY).startsWith(DEV_PG_PREFIX)).toBe(true);
  });
});

describe("files volumes", () => {
  it("are `flagship-files-<creator>--<slug>`, and `flagship-devfiles-…` for the dev dataspace", () => {
    expect(filesVolume({ creator: "harry", slug: "habit-tracker" })).toBe("flagship-files-harry--habit-tracker");
    expect(filesVolume({ creator: "harry", slug: "habit-tracker", space: "dev" })).toBe(
      "flagship-devfiles-harry--habit-tracker",
    );
  });

  it("take a username with a dash, and never give two apps one volume", () => {
    expect(filesVolume({ creator: "plucky-avocet", slug: "notes" })).toBe("flagship-files-plucky-avocet--notes");
    expect(filesVolume({ creator: "a-b", slug: "c" })).not.toBe(filesVolume({ creator: "a", slug: "b-c" }));
    const seen = new Map<string, string>();
    for (const id of identities) {
      const v = filesVolume(id);
      const key = JSON.stringify([id.creator, id.slug, id.space]);
      expect(seen.get(v) ?? key, v).toBe(key);
      seen.set(v, key);
    }
  });

  it("still recognize a prod volume made before usernames could hold a dash", () => {
    expect(isProdFilesVolume("flagship-files-harry-habit-tracker")).toBe(true);
    expect(isFilesVolume("flagship-files-harry-habit-tracker")).toBe(true);
  });

  it("are recognized by isFilesVolume, and only prod ones by isProdFilesVolume", () => {
    for (const id of identities) {
      const v = filesVolume(id);
      expect(isFilesVolume(v), v).toBe(true);
      expect(isProdFilesVolume(v), v).toBe(id.space !== "dev");
    }
    for (const bad of ["flagship-files-", "flagship-files-Harry-x", "flagship-files-harry", "flagship-files-harry-x-", "flagship-files-harry---x", "flagship-devfiles-harry", "flagship-devfiles-harry-x", "other", "flagship-postgres", "/var/flagship/data"]) {
      expect(isFilesVolume(bad), bad).toBe(false);
    }
  });

  it("a prod volume can never look like a dev one, even for a creator named `dev`", () => {
    const v = filesVolume({ creator: "dev", slug: "notes" });
    expect(v).toBe("flagship-files-dev--notes");
    expect(isProdFilesVolume(v)).toBe(true);
  });
});

describe("app database extensions", () => {
  it("are exactly the owner's list", () => {
    expect([...APP_PG_EXTENSIONS]).toEqual([
      "pgcrypto",
      "citext",
      "pg_trgm",
      "unaccent",
      "fuzzystrmatch",
      "hstore",
      "ltree",
      "btree_gin",
      "btree_gist",
      "vector",
    ]);
  });
});
