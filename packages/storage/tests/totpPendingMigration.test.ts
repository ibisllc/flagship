import { describe, expect, it } from "vitest";
import { applyAllMigrations, createSqliteD1 } from "./support/sqliteD1.js";
import { D1UsernameStorage } from "../src/d1.js";

// Migration 0160 (security report F2): a begun-but-unconfirmed secret is
// cleared, a confirmed one is kept, and the pending columns start empty.
describe("migration 0160: TOTP pending secret", () => {
  it("clears unconfirmed secrets, keeps confirmed ones", async () => {
    const db = createSqliteD1(undefined, (f) => f < "0160");
    const insert = db.raw.prepare(
      "INSERT INTO usernames (username, irk_pub_hex, claimed_at, account_type, totp_secret_encrypted, recovery_codes_hashes_json, totp_enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("staged", "aa", 1, "single", "half-done", null, null);
    insert.run("enrolled", "bb", 1, "multi", "live", '["h"]', 5);
    insert.run("plain", "cc", 1, "single", null, null, null);
    applyAllMigrations(db.raw, (f) => f.startsWith("0160"));
    const s = new D1UsernameStorage(db);
    const staged = await s.get("staged");
    expect(staged?.totpSecretEncrypted).toBeUndefined();
    expect(staged?.totpPendingSecretEncrypted).toBeUndefined();
    expect(staged?.accountType).toBe("single");
    expect(await s.get("enrolled")).toMatchObject({
      accountType: "multi",
      totpSecretEncrypted: "live",
      recoveryCodesHashesJson: '["h"]',
      totpEnrolledAt: 5,
    });
    expect((await s.get("plain"))?.totpSecretEncrypted).toBeUndefined();
    const table = db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'totp_outcome_log'").get();
    expect(table).toBeTruthy();
    db.close();
  });
});
