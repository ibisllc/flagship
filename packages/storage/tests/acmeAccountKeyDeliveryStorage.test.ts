/**
 * Storage adapter contract — AcmeAccountKeyDeliveryStorage (#28 Option B,
 * seal-to-box delivery of the shared ACME account key).
 *
 * Same suite runs against BOTH adapters via a shared factory: the in-memory
 * implementation directly, and a minimal D1 fake that models the exact SQL
 * the D1 adapter issues (incl. the ON CONFLICT(server_domain) upsert). The
 * fake is query-pattern-matched rather than a full SQL engine — it fails
 * loudly the moment the D1 adapter emits a SQL shape it doesn't recognise,
 * which is the silent-drift regression we care about.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  D1AcmeAccountKeyDeliveryStorage,
  InMemoryAcmeAccountKeyDeliveryStorage,
} from "../src/index.js";
import type {
  AcmeAccountKeyDeliveryRecord,
  AcmeAccountKeyDeliveryStorage,
  D1Database,
  D1PreparedStatement,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, "../migrations/0046_acme_account_key_delivery.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

function rec(over: Partial<AcmeAccountKeyDeliveryRecord> = {}): AcmeAccountKeyDeliveryRecord {
  return {
    serverDomain: "nas.dani.flagship.services",
    accountKeyId: "key-aaa",
    sealedAccountKeyHex: "cc".repeat(48),
    recipientPubHex: "aa".repeat(32),
    issuedAt: 1000,
    expiresAt: 2000,
    revokedAt: null,
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Minimal D1 fake — models the SQL shapes the D1 adapter actually issues.
// Rows keyed by server_domain (the PK).
// ──────────────────────────────────────────────────────────────────────

interface FakeRow {
  server_domain: string;
  account_key_id: string;
  sealed_account_key_hex: string;
  recipient_pub_hex: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
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
        // SELECT * FROM acme_account_key_delivery WHERE server_domain = ?1
        if (/SELECT \* FROM acme_account_key_delivery WHERE server_domain = \?1/.test(query)) {
          return (rows.get(String(bound[0])) ?? null) as unknown as T | null;
        }
        throw new Error(`unexpected first(): ${query}`);
      },
      async all<T = unknown>() {
        throw new Error(`unexpected all(): ${query}`);
      },
      async run() {
        // INSERT ... ON CONFLICT(server_domain) DO UPDATE (upsert).
        if (/INSERT INTO acme_account_key_delivery/.test(query)) {
          const [
            serverDomain,
            accountKeyId,
            sealedHex,
            recipientHex,
            issuedAt,
            expiresAt,
            revokedAt,
          ] = bound as [string, string, string, string, number, number, number | null];
          rows.set(serverDomain, {
            server_domain: serverDomain,
            account_key_id: accountKeyId,
            sealed_account_key_hex: sealedHex,
            recipient_pub_hex: recipientHex,
            issued_at: issuedAt,
            expires_at: expiresAt,
            revoked_at: revokedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }
        // DELETE ... WHERE server_domain = ?1
        if (/DELETE FROM acme_account_key_delivery WHERE server_domain = \?1/.test(query)) {
          const had = rows.delete(String(bound[0]));
          return { success: true, meta: { changes: had ? 1 : 0 } };
        }
        // DELETE ... WHERE account_key_id = ?1
        if (/DELETE FROM acme_account_key_delivery WHERE account_key_id = \?1/.test(query)) {
          const id = String(bound[0]);
          let n = 0;
          for (const [k, r] of rows) {
            if (r.account_key_id === id) {
              rows.delete(k);
              n++;
            }
          }
          return { success: true, meta: { changes: n } };
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

describe("migration 0046 (acme_account_key_delivery)", () => {
  it("creates the acme_account_key_delivery table with server_domain PK", () => {
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE IF NOT EXISTS acme_account_key_delivery/);
    expect(MIGRATION_SQL).toMatch(/server_domain\s+TEXT PRIMARY KEY/);
  });
  it("creates the account_key_id index (rotation hook)", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_aakd_account_key_id\s+ON acme_account_key_delivery\(account_key_id\)/,
    );
  });
  it("stores the key only as a SEALED hex column (I1)", () => {
    // The only key-bearing column is the sealed ciphertext — there is no
    // plaintext key column in the table definition.
    expect(MIGRATION_SQL).toMatch(/sealed_account_key_hex\s+TEXT NOT NULL/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shared contract — runs against both adapters.
// ──────────────────────────────────────────────────────────────────────

interface Adapter {
  label: string;
  make: () => AcmeAccountKeyDeliveryStorage;
}
const adapters: Adapter[] = [
  {
    label: "InMemoryAcmeAccountKeyDeliveryStorage",
    make: () => new InMemoryAcmeAccountKeyDeliveryStorage(),
  },
  {
    label: "D1AcmeAccountKeyDeliveryStorage",
    make: () => new D1AcmeAccountKeyDeliveryStorage(makeD1()),
  },
];

for (const a of adapters) {
  describe(a.label, () => {
    it("put → getByDomain round-trip preserves every field", async () => {
      const s = a.make();
      await s.put(rec());
      const got = await s.getByDomain("nas.dani.flagship.services");
      expect(got).toBeDefined();
      expect(got?.accountKeyId).toBe("key-aaa");
      expect(got?.sealedAccountKeyHex).toBe("cc".repeat(48));
      expect(got?.recipientPubHex).toBe("aa".repeat(32));
      expect(got?.issuedAt).toBe(1000);
      expect(got?.expiresAt).toBe(2000);
      expect(got?.revokedAt).toBeNull();
    });

    it("getByDomain on an absent box returns undefined", async () => {
      const s = a.make();
      expect(await s.getByDomain("nope.flagship.services")).toBeUndefined();
    });

    it("put overwrites the slot for the same box (one slot per box)", async () => {
      const s = a.make();
      await s.put(rec({ accountKeyId: "key-aaa", sealedAccountKeyHex: "11".repeat(48) }));
      // A fresh deposit (rotation re-seal) supersedes the prior one.
      await s.put(rec({ accountKeyId: "key-bbb", sealedAccountKeyHex: "22".repeat(48) }));
      const got = await s.getByDomain("nas.dani.flagship.services");
      expect(got?.accountKeyId).toBe("key-bbb");
      expect(got?.sealedAccountKeyHex).toBe("22".repeat(48));
    });

    it("getByDomain returns a revoked slot (the handler applies the gate)", async () => {
      const s = a.make();
      await s.put(rec({ revokedAt: 1500 }));
      expect((await s.getByDomain("nas.dani.flagship.services"))?.revokedAt).toBe(1500);
    });

    it("deleteByDomain drops the slot", async () => {
      const s = a.make();
      await s.put(rec());
      await s.deleteByDomain("nas.dani.flagship.services");
      expect(await s.getByDomain("nas.dani.flagship.services")).toBeUndefined();
    });

    it("deleteByDomain on an absent box is a no-op", async () => {
      const s = a.make();
      await expect(s.deleteByDomain("ghost.flagship.services")).resolves.toBeUndefined();
    });

    it("deleteByAccountKeyId drops EVERY box slot of a rotated key + returns the count", async () => {
      const s = a.make();
      await s.put(rec({ serverDomain: "nas.dani.flagship.services", accountKeyId: "key-X" }));
      await s.put(rec({ serverDomain: "blog.dani.flagship.services", accountKeyId: "key-X" }));
      // A slot of a DIFFERENT key survives.
      await s.put(rec({ serverDomain: "media.dani.flagship.services", accountKeyId: "key-Y" }));

      const n = await s.deleteByAccountKeyId("key-X");
      expect(n).toBe(2);
      expect(await s.getByDomain("nas.dani.flagship.services")).toBeUndefined();
      expect(await s.getByDomain("blog.dani.flagship.services")).toBeUndefined();
      expect((await s.getByDomain("media.dani.flagship.services"))?.accountKeyId).toBe("key-Y");
    });

    it("deleteByAccountKeyId returns 0 when no slot matches", async () => {
      const s = a.make();
      await s.put(rec({ accountKeyId: "key-aaa" }));
      expect(await s.deleteByAccountKeyId("key-zzz")).toBe(0);
      expect(await s.getByDomain("nas.dani.flagship.services")).toBeDefined();
    });
  });
}
