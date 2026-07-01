/**
 * Storage adapter contract — DeviceCapabilityGrantStorage (S3.2).
 *
 * Same suite runs against BOTH adapters via a shared factory: the
 * in-memory implementation under test directly, and a minimal D1 fake
 * that models the exact SQL the D1 adapter issues (incl. the unique-
 * partial-index constraint on `(username, device_label) WHERE
 * revoked_at IS NULL`). The fake is deliberately query-pattern-matched
 * rather than a full SQL engine — that keeps the file dependency-free
 * AND lets the test fail loudly the moment the D1 adapter starts
 * emitting a SQL shape the fake doesn't recognize, which is the
 * regression we care about (silent drift between adapters).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  D1DeviceCapabilityGrantStorage,
  InMemoryDeviceCapabilityGrantStorage,
} from "../src/index.js";
import type {
  D1Database,
  D1PreparedStatement,
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  HERE,
  "../migrations/0031_device_capability_grants.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

function rec(
  overrides: Partial<DeviceCapabilityGrantRecord> = {},
): DeviceCapabilityGrantRecord {
  return {
    grantId: "g-" + (overrides.grantId ?? "primary"),
    username: "alice",
    deviceLabel: "primary",
    devicePubHex: "aa".repeat(32),
    scopesJson: JSON.stringify(["browse", "install-service"]),
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 90 * 86_400_000,
    signatureHex: "bb".repeat(64),
    revokedAt: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Minimal D1 fake — models the SQL shapes the D1 adapter actually issues.
// ──────────────────────────────────────────────────────────────────────

interface FakeRow {
  grant_id: string;
  username: string;
  device_label: string;
  device_pub_hex: string;
  scopes_json: string;
  issued_at: number;
  expires_at: number;
  signature_hex: string;
  revoked_at: number | null;
  signer_root: string;
}

function makeD1(): D1Database {
  const rows = new Map<string, FakeRow>();
  function prepare(query: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T = unknown>(): Promise<T | null> {
        // SELECT * FROM device_capability_grants WHERE grant_id = ?1
        if (/WHERE grant_id = \?1/.test(query)) {
          const id = String(bound[0]);
          return (rows.get(id) ?? null) as unknown as T | null;
        }
        // SELECT * FROM device_capability_grants WHERE device_pub_hex = ?1
        // AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1
        if (
          /device_pub_hex = \?1 AND revoked_at IS NULL/.test(query) &&
          /LIMIT 1/.test(query)
        ) {
          const p = String(bound[0]);
          const matched = [...rows.values()]
            .filter((r) => r.device_pub_hex === p && r.revoked_at === null)
            .sort((a, b) => b.issued_at - a.issued_at);
          return ((matched[0] as unknown) ?? null) as unknown as T | null;
        }
        throw new Error(`unexpected first(): ${query}`);
      },
      async all<T = unknown>() {
        // SELECT * FROM device_capability_grants WHERE username = ?1
        // ORDER BY issued_at DESC
        if (
          /WHERE username = \?1\s+ORDER BY issued_at DESC$/m.test(query) &&
          !/device_label/.test(query)
        ) {
          const u = String(bound[0]);
          const out = [...rows.values()]
            .filter((r) => r.username === u)
            .sort((a, b) => b.issued_at - a.issued_at);
          return { results: out as unknown as T[], success: true, meta: {} };
        }
        // SELECT * FROM device_capability_grants WHERE username = ?1
        // AND device_label = ?2 AND revoked_at IS NULL
        if (
          /WHERE username = \?1 AND device_label = \?2 AND revoked_at IS NULL/.test(
            query,
          )
        ) {
          const u = String(bound[0]);
          const l = String(bound[1]);
          const out = [...rows.values()].filter(
            (r) =>
              r.username === u && r.device_label === l && r.revoked_at === null,
          );
          return { results: out as unknown as T[], success: true, meta: {} };
        }
        throw new Error(`unexpected all(): ${query}`);
      },
      async run() {
        // INSERT INTO device_capability_grants (...) VALUES (?1..?9)
        if (/INSERT INTO device_capability_grants/.test(query)) {
          const [
            grantId,
            username,
            deviceLabel,
            devicePubHex,
            scopesJson,
            issuedAt,
            expiresAt,
            signatureHex,
            revokedAt,
            signerRoot,
          ] = bound as [
            string,
            string,
            string,
            string,
            string,
            number,
            number,
            string,
            number | null,
            string | undefined,
          ];
          // Enforce the unique partial index at insert time.
          if (revokedAt === null) {
            for (const other of rows.values()) {
              if (
                other.grant_id !== grantId &&
                other.username === username &&
                other.device_label === deviceLabel &&
                other.revoked_at === null
              ) {
                throw new Error(
                  "UNIQUE constraint failed: idx_dcg_username_label_active",
                );
              }
            }
          }
          // Primary-key collision.
          if (rows.has(grantId)) {
            throw new Error(
              "UNIQUE constraint failed: device_capability_grants.grant_id",
            );
          }
          rows.set(grantId, {
            grant_id: grantId,
            username,
            device_label: deviceLabel,
            device_pub_hex: devicePubHex,
            scopes_json: scopesJson,
            issued_at: issuedAt,
            expires_at: expiresAt,
            signature_hex: signatureHex,
            revoked_at: revokedAt,
            // Models the `signer_root TEXT NOT NULL DEFAULT 'membership'`
            // column (migration 0064): DEFAULT applies when the bind is absent.
            signer_root: signerRoot ?? "membership",
          });
          return { success: true, meta: { changes: 1 } };
        }
        // UPDATE device_capability_grants SET revoked_at = ?1 WHERE grant_id = ?2
        if (/UPDATE device_capability_grants SET revoked_at = \?1/.test(query)) {
          const [revokedAt, grantId] = bound as [number, string];
          const r = rows.get(grantId);
          if (!r) return { success: true, meta: { changes: 0 } };
          r.revoked_at = revokedAt;
          return { success: true, meta: { changes: 1 } };
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
// Shared contract — runs against both adapters.
// ──────────────────────────────────────────────────────────────────────

interface Adapter {
  label: string;
  make: () => DeviceCapabilityGrantStorage;
}
const adapters: Adapter[] = [
  {
    label: "InMemoryDeviceCapabilityGrantStorage",
    make: () => new InMemoryDeviceCapabilityGrantStorage(),
  },
  {
    label: "D1DeviceCapabilityGrantStorage",
    make: () => new D1DeviceCapabilityGrantStorage(makeD1()),
  },
];

describe("migration 0031 (device_capability_grants)", () => {
  it("creates the table with grant_id PRIMARY KEY", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS device_capability_grants/,
    );
    expect(MIGRATION_SQL).toMatch(/grant_id\s+TEXT PRIMARY KEY/);
  });
  it("creates the unique partial index on (username, device_label) WHERE revoked_at IS NULL", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_dcg_username_label_active/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ON device_capability_grants\(username, device_label\)\s+WHERE revoked_at IS NULL/,
    );
  });
  it("creates the username + device_pub + expires_at lookup indexes", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_dcg_username\s+ON device_capability_grants\(username\)/,
    );
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_dcg_device_pub\s+ON device_capability_grants\(device_pub_hex\)/,
    );
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_dcg_expires_at\s+ON device_capability_grants\(expires_at\)/,
    );
  });
});

for (const a of adapters) {
  describe(a.label, () => {
    it("put → get round-trip preserves every field, incl. scopes_json", async () => {
      const s = a.make();
      const r = rec({
        grantId: "g-1",
        scopesJson: JSON.stringify(["browse", "demo-provision"]),
      });
      const put = await s.put(r);
      expect(put).toEqual({ ok: true });
      const got = await s.get("g-1");
      expect(got).toBeDefined();
      expect(got?.grantId).toBe("g-1");
      expect(got?.username).toBe("alice");
      expect(got?.deviceLabel).toBe("primary");
      expect(got?.devicePubHex).toBe("aa".repeat(32));
      expect(got?.scopesJson).toBe(
        JSON.stringify(["browse", "demo-provision"]),
      );
      expect(got?.issuedAt).toBe(r.issuedAt);
      expect(got?.expiresAt).toBe(r.expiresAt);
      expect(got?.signatureHex).toBe("bb".repeat(64));
      expect(got?.revokedAt).toBeNull();
    });

    it("Slice D — signer_root defaults to 'membership' and round-trips 'admin-root'", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-mem" }));
      expect((await s.get("g-mem"))?.signerRoot).toBe("membership");
      await s.put(
        rec({ grantId: "g-admin", deviceLabel: "ipad", signerRoot: "admin-root" }),
      );
      expect((await s.get("g-admin"))?.signerRoot).toBe("admin-root");
    });

    it("get on an unknown grantId returns undefined", async () => {
      const s = a.make();
      expect(await s.get("nope")).toBeUndefined();
    });

    it("put rejects a duplicate ACTIVE (username, deviceLabel) with ok:false + the documented reason", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-1" }));
      const dup = await s.put(
        rec({ grantId: "g-2", devicePubHex: "cc".repeat(32) }),
      );
      expect(dup).toEqual({
        ok: false,
        reason: "duplicate active grant for (username, device_label)",
      });
    });

    it("put of a new active grant AFTER revoking the old succeeds (re-issuance)", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-old" }));
      await s.revoke("g-old", 1_700_000_500_000);
      const fresh = await s.put(
        rec({
          grantId: "g-new",
          devicePubHex: "cc".repeat(32),
          issuedAt: 1_700_000_600_000,
        }),
      );
      expect(fresh).toEqual({ ok: true });
      // Both rows visible via get; only the new one is active.
      const old = await s.get("g-old");
      expect(old?.revokedAt).toBe(1_700_000_500_000);
      const neu = await s.get("g-new");
      expect(neu?.revokedAt).toBeNull();
    });

    it("listForUser returns rows sorted by issuedAt DESC (newest first)", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-a", deviceLabel: "ipad", issuedAt: 100 }));
      await s.put(
        rec({
          grantId: "g-b",
          deviceLabel: "laptop",
          devicePubHex: "cc".repeat(32),
          issuedAt: 300,
        }),
      );
      await s.put(
        rec({
          grantId: "g-c",
          deviceLabel: "phone",
          devicePubHex: "dd".repeat(32),
          issuedAt: 200,
        }),
      );
      const list = await s.listForUser("alice");
      expect(list.map((r) => r.grantId)).toEqual(["g-b", "g-c", "g-a"]);
    });

    it("listForUser includes revoked rows (audit/replay)", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-1", issuedAt: 100 }));
      await s.revoke("g-1", 200);
      const list = await s.listForUser("alice");
      expect(list).toHaveLength(1);
      expect(list[0]?.revokedAt).toBe(200);
    });

    it("listForUser filters by username (case-insensitive on the input)", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-a", username: "alice" }));
      await s.put(
        rec({
          grantId: "g-b",
          username: "bob",
          devicePubHex: "cc".repeat(32),
        }),
      );
      const list = await s.listForUser("ALICE");
      expect(list.map((r) => r.grantId)).toEqual(["g-a"]);
    });

    it("revoke sets revokedAt; the row is retained (still in get + listForUser); getActiveForUserLabel skips it", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-1" }));
      await s.revoke("g-1", 1_700_000_900_000);
      const got = await s.get("g-1");
      expect(got?.revokedAt).toBe(1_700_000_900_000);
      const active = await s.getActiveForUserLabel("alice", "primary");
      expect(active).toBeUndefined();
      const list = await s.listForUser("alice");
      expect(list).toHaveLength(1);
    });

    it("revoke throws 'unknown grantId' when the row is missing", async () => {
      const s = a.make();
      await expect(s.revoke("g-ghost", 12345)).rejects.toThrow(
        /unknown grantId/,
      );
    });

    it("getActiveForUserLabel returns the single matching active row, or undefined", async () => {
      const s = a.make();
      expect(
        await s.getActiveForUserLabel("alice", "primary"),
      ).toBeUndefined();
      await s.put(rec({ grantId: "g-1" }));
      const got = await s.getActiveForUserLabel("alice", "primary");
      expect(got?.grantId).toBe("g-1");
    });

    it("getByDevicePub finds the row by device_pub_hex; returns most-recent ACTIVE", async () => {
      const s = a.make();
      // Same device pub, two grants — older one revoked, newer active.
      const sharedPub = "ee".repeat(32);
      await s.put(
        rec({
          grantId: "g-old",
          deviceLabel: "ipad",
          devicePubHex: sharedPub,
          issuedAt: 100,
        }),
      );
      await s.revoke("g-old", 150);
      await s.put(
        rec({
          grantId: "g-new",
          deviceLabel: "ipad-2",
          devicePubHex: sharedPub,
          issuedAt: 200,
        }),
      );
      const got = await s.getByDevicePub(sharedPub);
      expect(got?.grantId).toBe("g-new");
    });

    it("getByDevicePub returns undefined when only revoked rows match", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-1" }));
      await s.revoke("g-1", 200);
      expect(await s.getByDevicePub("aa".repeat(32))).toBeUndefined();
    });

    it("getByDevicePub returns undefined when no row matches the pubkey", async () => {
      const s = a.make();
      await s.put(rec({ grantId: "g-1" }));
      expect(await s.getByDevicePub("ff".repeat(32))).toBeUndefined();
    });
  });
}
