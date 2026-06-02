/**
 * Storage adapter contract — NamespaceStorage (§3.4 merged per-user
 * leftmost-label uniqueness; per-user-cert worklist task #25).
 *
 * Same suite runs against BOTH adapters via a shared factory: the
 * in-memory implementation directly, and a minimal D1 fake that models
 * the exact SQL the D1 adapter issues (incl. the UNIQUE (username, label)
 * constraint that `idx_name_claims_username_label` enforces). The fake is
 * deliberately query-pattern-matched rather than a full SQL engine — that
 * keeps the file dependency-free AND makes it fail loudly the moment the
 * D1 adapter starts emitting a SQL shape the fake doesn't recognise, which
 * is the silent-drift regression we care about.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { D1NamespaceStorage, InMemoryNamespaceStorage } from "../src/index.js";
import type {
  D1Database,
  D1PreparedStatement,
  NameClaimRecord,
  NamespaceStorage,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, "../migrations/0044_name_claims.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

function rec(overrides: Partial<NameClaimRecord> = {}): NameClaimRecord {
  return {
    username: "alice",
    label: "blog",
    kind: "app",
    refId: "stable-blog-1",
    claimedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Minimal D1 fake — models the SQL shapes the D1 adapter actually issues.
// Rows keyed by `<username>\x00<label>` (both lower-cased), mirroring the
// UNIQUE index on (username, label).
// ──────────────────────────────────────────────────────────────────────

interface FakeRow {
  username: string;
  label: string;
  kind: string;
  ref_id: string;
  claimed_at: number;
}

function makeD1(): D1Database {
  const rows = new Map<string, FakeRow>();
  const keyOf = (u: string, l: string) => `${u} ${l}`;
  function prepare(query: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T = unknown>(): Promise<T | null> {
        // SELECT * FROM name_claims WHERE username = ?1 AND label = ?2
        if (/WHERE username = \?1 AND label = \?2/.test(query)) {
          const u = String(bound[0]);
          const l = String(bound[1]);
          return (rows.get(keyOf(u, l)) ?? null) as unknown as T | null;
        }
        throw new Error(`unexpected first(): ${query}`);
      },
      async all<T = unknown>() {
        // SELECT * FROM name_claims WHERE username = ?1 ORDER BY claimed_at ASC
        if (/WHERE username = \?1\s+ORDER BY claimed_at ASC/.test(query)) {
          const u = String(bound[0]);
          const out = [...rows.values()]
            .filter((r) => r.username === u)
            .sort((a, b) => a.claimed_at - b.claimed_at);
          return { results: out as unknown as T[], success: true, meta: {} };
        }
        throw new Error(`unexpected all(): ${query}`);
      },
      async run() {
        // INSERT INTO name_claims (...) VALUES (?1..?5)
        if (/INSERT INTO name_claims/.test(query)) {
          const [username, label, kind, refId, claimedAt] = bound as [
            string,
            string,
            string,
            string,
            number,
          ];
          // Enforce the UNIQUE (username, label) index at insert time.
          if (rows.has(keyOf(username, label))) {
            throw new Error(
              "UNIQUE constraint failed: idx_name_claims_username_label",
            );
          }
          rows.set(keyOf(username, label), {
            username,
            label,
            kind,
            ref_id: refId,
            claimed_at: claimedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }
        // DELETE FROM name_claims WHERE username = ?1 AND label = ?2
        if (/DELETE FROM name_claims WHERE username = \?1 AND label = \?2/.test(query)) {
          const u = String(bound[0]);
          const l = String(bound[1]);
          const had = rows.delete(keyOf(u, l));
          return { success: true, meta: { changes: had ? 1 : 0 } };
        }
        throw new Error(`unexpected run(): ${query}`);
      },
    };
    return stmt;
  }
  return {
    prepare,
    async batch() {
      throw new Error("batch not used");
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Migration shape.
// ──────────────────────────────────────────────────────────────────────

describe("migration 0044 (name_claims)", () => {
  it("creates the name_claims table", () => {
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE IF NOT EXISTS name_claims/);
  });
  it("creates the UNIQUE index on (username, label)", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_name_claims_username_label/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ON name_claims\(username, label\)/,
    );
  });
  it("creates the username lookup index", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_name_claims_username\s+ON name_claims\(username\)/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shared contract — runs against both adapters.
// ──────────────────────────────────────────────────────────────────────

interface Adapter {
  label: string;
  make: () => NamespaceStorage;
}
const adapters: Adapter[] = [
  {
    label: "InMemoryNamespaceStorage",
    make: () => new InMemoryNamespaceStorage(),
  },
  {
    label: "D1NamespaceStorage",
    make: () => new D1NamespaceStorage(makeD1()),
  },
];

for (const a of adapters) {
  describe(a.label, () => {
    it("claim → resolve round-trip preserves every field", async () => {
      const s = a.make();
      const r = rec({ label: "blog", kind: "app", refId: "stable-blog-1" });
      expect(await s.claim(r)).toEqual({ ok: true });
      const got = await s.resolve("alice", "blog");
      expect(got).toBeDefined();
      expect(got?.username).toBe("alice");
      expect(got?.label).toBe("blog");
      expect(got?.kind).toBe("app");
      expect(got?.refId).toBe("stable-blog-1");
      expect(got?.claimedAt).toBe(r.claimedAt);
    });

    it("resolve on an unclaimed label returns undefined", async () => {
      const s = a.make();
      expect(await s.resolve("alice", "nope")).toBeUndefined();
    });

    it("listForUser returns every claim for the user (claimedAt ASC), filtered by username", async () => {
      const s = a.make();
      await s.claim(rec({ label: "blog", kind: "app", refId: "app-1", claimedAt: 300 }));
      await s.claim(rec({ label: "nas", kind: "box", refId: "server-1", claimedAt: 100 }));
      await s.claim(rec({ label: "laptop", kind: "device", refId: "laptop", claimedAt: 200 }));
      // A different user's claim must not leak in.
      await s.claim(rec({ username: "bob", label: "blog", kind: "app", refId: "bob-app" }));
      const list = await s.listForUser("alice");
      expect(list.map((c) => c.label)).toEqual(["nas", "laptop", "blog"]);
      expect(list.map((c) => c.kind)).toEqual(["box", "device", "app"]);
    });

    it("rejects a colliding claim from a DIFFERENT kind with ok:false + 'name taken'", async () => {
      const s = a.make();
      // An app grabs the label first…
      expect(await s.claim(rec({ label: "files", kind: "app", refId: "app-files" }))).toEqual({
        ok: true,
      });
      // …a box can't then take the same leftmost label.
      const dup = await s.claim(rec({ label: "files", kind: "box", refId: "server-files" }));
      expect(dup).toEqual({ ok: false, reason: "name taken" });
      // The original owner is untouched.
      const got = await s.resolve("alice", "files");
      expect(got?.kind).toBe("app");
      expect(got?.refId).toBe("app-files");
    });

    it("rejects a same-kind DIFFERENT-refId claim too (two apps, one label)", async () => {
      const s = a.make();
      await s.claim(rec({ label: "chat", kind: "app", refId: "app-A" }));
      const dup = await s.claim(rec({ label: "chat", kind: "app", refId: "app-B" }));
      expect(dup).toEqual({ ok: false, reason: "name taken" });
    });

    it("allows an IDENTICAL (kind, refId) re-claim (idempotent); claimedAt is preserved", async () => {
      const s = a.make();
      await s.claim(rec({ label: "blog", kind: "app", refId: "app-1", claimedAt: 100 }));
      // Same claim again, even with a later claimedAt, is a no-op success.
      expect(
        await s.claim(rec({ label: "blog", kind: "app", refId: "app-1", claimedAt: 999 })),
      ).toEqual({ ok: true });
      const got = await s.resolve("alice", "blog");
      expect(got?.claimedAt).toBe(100); // original timestamp, not bumped
      // And only one row exists.
      expect(await s.listForUser("alice")).toHaveLength(1);
    });

    it("release frees the label so a DIFFERENT kind can then claim it", async () => {
      const s = a.make();
      await s.claim(rec({ label: "media", kind: "box", refId: "server-1" }));
      // Blocked while held.
      expect(await s.claim(rec({ label: "media", kind: "device", refId: "tv" }))).toEqual({
        ok: false,
        reason: "name taken",
      });
      await s.release("alice", "media");
      expect(await s.resolve("alice", "media")).toBeUndefined();
      // Now a previously-colliding kind can take it.
      expect(await s.claim(rec({ label: "media", kind: "device", refId: "tv" }))).toEqual({
        ok: true,
      });
      const got = await s.resolve("alice", "media");
      expect(got?.kind).toBe("device");
      expect(got?.refId).toBe("tv");
    });

    it("release of an absent (username, label) is a no-op success", async () => {
      const s = a.make();
      await expect(s.release("alice", "ghost")).resolves.toBeUndefined();
    });

    it("claim + resolve + release + listForUser are case-INSENSITIVE on username and label", async () => {
      const s = a.make();
      // Claim with mixed case…
      expect(await s.claim(rec({ username: "Alice", label: "Blog", kind: "app", refId: "app-1" }))).toEqual({
        ok: true,
      });
      // …a differently-cased SAME label collides (it's the same name).
      expect(await s.claim(rec({ username: "ALICE", label: "BLOG", kind: "box", refId: "server-1" }))).toEqual({
        ok: false,
        reason: "name taken",
      });
      // resolve folds case both ways and returns the stored (lower-cased) form.
      const got = await s.resolve("aLICE", "bLOG");
      expect(got?.username).toBe("alice");
      expect(got?.label).toBe("blog");
      // listForUser folds the username.
      expect((await s.listForUser("ALICE")).map((c) => c.label)).toEqual(["blog"]);
      // release folds case.
      await s.release("ALICE", "BLOG");
      expect(await s.resolve("alice", "blog")).toBeUndefined();
    });

    it("an identical re-claim with differently-cased username/label is still idempotent", async () => {
      const s = a.make();
      await s.claim(rec({ username: "alice", label: "blog", kind: "app", refId: "app-1", claimedAt: 100 }));
      expect(
        await s.claim(rec({ username: "ALICE", label: "BLOG", kind: "app", refId: "app-1", claimedAt: 555 })),
      ).toEqual({ ok: true });
      expect(await s.listForUser("alice")).toHaveLength(1);
      expect((await s.resolve("alice", "blog"))?.claimedAt).toBe(100);
    });
  });
}
