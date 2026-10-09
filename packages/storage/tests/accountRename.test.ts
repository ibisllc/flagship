import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import {
  D1NameChangeStorage,
  D1UsernameStorage,
  NOT_RENAMED_ACCOUNT_COLUMNS,
  RENAMED_ACCOUNT_COLUMNS,
} from "../src/index.js";

// The account rename over real sqlite with every migration applied (D1's batch
// is one transaction; the harness mirrors that). Covers the schema guard (no
// username-like column may be left unclassified), the FK-linked move, the
// all-or-nothing rollback, and the clean-up of a previous holder's leftovers.

const AID = "aa".repeat(32);
const DEVICE = "0123456789abcdef0123456789abcdef";
let db: SqliteD1 | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function seed(d: SqliteD1, username: string) {
  d.raw.exec(`
    INSERT INTO usernames (username, irk_pub_hex, claimed_at, account_type, aid_pub_hex, admin_root_pub_hex, totp_enrolled_at)
      VALUES ('${username}', '${"11".repeat(32)}', 1, 'multi', '${AID}', '${"22".repeat(32)}', 77);
    INSERT INTO device_identities (account_id, device_id, device_pub_hex, platform_class, created_at, last_seen_at)
      VALUES ('${username}', '${DEVICE}', '${"33".repeat(32)}', 'ios', 1, 1);
    INSERT INTO account_profiles (account_id, revision, key_version, nonce_hex, ciphertext_hex, signer_pub_hex, signature_hex, issued_at, updated_at)
      VALUES ('${username}', 1, 1, '${"00".repeat(12)}', 'ab', '${"22".repeat(32)}', '${"44".repeat(64)}', 1, 1);
    INSERT INTO push_tokens (token_id, username, device_id, platform, provider_token, push_x25519_pub_hex, registration_signature_hex, registered_at, last_seen_at)
      VALUES ('tok-1', '${username}', '${DEVICE}', 'apns', 'pt', '${"55".repeat(32)}', '${"66".repeat(64)}', 1, 1);
    INSERT INTO usage_counters (username, period, bytes_egress, updated_at) VALUES ('${username}', '2026-10', 123, 1);
  `);
}

describe("account rename — schema coverage", () => {
  it("every username-like column is either renamed or excluded with a reason", () => {
    db = createSqliteD1();
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const classified = new Set([
      ...RENAMED_ACCOUNT_COLUMNS.map(([t, c]) => `${t}.${c}`),
      ...NOT_RENAMED_ACCOUNT_COLUMNS.map(([t, c]) => `${t}.${c}`),
    ]);
    const looksLikeAnAccount = /(^|_)(username|account_id|user_id|creator|account|redeemed_by|username_hash|giver_username|acquirer_username)$/;
    const unclassified: string[] = [];
    const existing = new Set<string>();
    for (const { name } of tables) {
      const cols = db.raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      for (const c of cols) {
        existing.add(`${name}.${c.name}`);
        if ((looksLikeAnAccount.test(c.name) || (name === "username_offer" && c.name === "name")) && !classified.has(`${name}.${c.name}`)) {
          unclassified.push(`${name}.${c.name}`);
        }
      }
    }
    expect(unclassified).toEqual([]);
    // …and no list entry names a column that doesn't exist.
    expect([...classified].filter((k) => !existing.has(k))).toEqual([]);
  });
});

describe("D1NameChangeStorage.renameAccount", () => {
  it("moves the account and every FK-linked row, keeping every usernames column", async () => {
    db = createSqliteD1();
    seed(db, "fresh-poppy");
    const s = new D1NameChangeStorage(db);
    expect(await s.renameAccount({ aidPubHex: AID, oldUsername: "fresh-poppy", newUsername: "acme", at: 9 })).toEqual({ ok: true });

    const u = await new D1UsernameStorage(db).get("acme");
    expect(u).toMatchObject({
      username: "acme",
      irkPubHex: "11".repeat(32),
      accountType: "multi",
      aidPubHex: AID,
      adminRootPubHex: "22".repeat(32),
      totpEnrolledAt: 77,
    });
    expect(await new D1UsernameStorage(db).get("fresh-poppy")).toBeUndefined();
    const one = (sql: string) => db!.raw.prepare(sql).get() as Record<string, unknown> | undefined;
    expect(one("SELECT account_id FROM device_identities")).toEqual({ account_id: "acme" });
    expect(one("SELECT account_id FROM account_profiles")).toEqual({ account_id: "acme" });
    expect(one("SELECT username FROM push_tokens")).toEqual({ username: "acme" });
    expect(one("SELECT username, bytes_egress FROM usage_counters")).toEqual({ username: "acme", bytes_egress: 123 });
    expect(one("PRAGMA foreign_key_check")).toBeUndefined();
    expect(await s.history(AID)).toEqual([{ aidPubHex: AID, oldUsername: "fresh-poppy", newUsername: "acme", at: 9 }]);
    expect(await s.countSince(AID, 0)).toBe(1);
    expect(await s.countSince(AID, 10)).toBe(0);
  });

  it("is all-or-nothing: a taken name changes nothing", async () => {
    db = createSqliteD1();
    seed(db, "fresh-poppy");
    db.raw.exec(`INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES ('acme', '${"99".repeat(32)}', 1)`);
    const s = new D1NameChangeStorage(db);
    expect((await s.renameAccount({ aidPubHex: AID, oldUsername: "fresh-poppy", newUsername: "acme", at: 9 })).ok).toBe(false);
    const one = (sql: string) => db!.raw.prepare(sql).get() as Record<string, unknown> | undefined;
    expect(one("SELECT account_id FROM device_identities")).toEqual({ account_id: "fresh-poppy" });
    expect(one("SELECT irk_pub_hex FROM usernames WHERE username = 'acme'")).toEqual({ irk_pub_hex: "99".repeat(32) });
    expect(await s.history(AID)).toEqual([]);
  });

  it("clears a previous holder's leftover rows under the new name", async () => {
    db = createSqliteD1();
    seed(db, "fresh-poppy");
    db.raw.exec(`INSERT INTO usage_counters (username, period, bytes_egress, updated_at) VALUES ('acme', '2026-10', 999, 1)`);
    const s = new D1NameChangeStorage(db);
    expect((await s.renameAccount({ aidPubHex: AID, oldUsername: "fresh-poppy", newUsername: "acme", at: 9 })).ok).toBe(true);
    const rows = db.raw.prepare("SELECT bytes_egress FROM usage_counters WHERE username = 'acme'").all();
    expect(rows).toEqual([{ bytes_egress: 123 }]);
  });

  it("refuses an unknown account", async () => {
    db = createSqliteD1();
    const s = new D1NameChangeStorage(db);
    expect(await s.renameAccount({ aidPubHex: AID, oldUsername: "nobody", newUsername: "acme", at: 1 })).toEqual({
      ok: false,
      reason: "account not found",
    });
  });
});
