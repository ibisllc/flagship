/**
 * v2.1 (W6) — per-cloud recovery-wipe-policy schema tests.
 *
 * Anchors the storage-layer contracts the W6 control-plane changes
 * depend on: the new column on `usernames` with a default of
 * `'graceful'`, the round-trip through `UsernameRecord`, and the
 * benign-re-put preservation invariant (a recovery-flow re-put with
 * no policy field MUST NOT downgrade an existing 'strict' choice).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import type { RecoveryWipePolicy, UsernameRecord } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, "../migrations/0032_recovery_wipe_policy.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0032 (v2.1 recovery-wipe-policy)", () => {
  it("adds recovery_wipe_policy column to usernames with default 'graceful'", () => {
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE usernames ADD COLUMN recovery_wipe_policy TEXT NOT NULL DEFAULT 'graceful'/,
    );
  });
});

describe("RecoveryWipePolicy union", () => {
  it("matches the two documented policies", () => {
    const valid: RecoveryWipePolicy[] = ["strict", "graceful"];
    expect(valid).toHaveLength(2);
  });
});

describe("InMemoryUsernameStorage v2.1 recovery-wipe policy", () => {
  it("defaults recoveryWipePolicy to 'graceful' on a put without the field", async () => {
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: "alice",
      irkPubHex: "11".repeat(32),
      claimedAt: 1,
    });
    const row = await s.usernames.get("alice");
    expect(row?.recoveryWipePolicy).toBe("graceful");
  });

  it("round-trips recoveryWipePolicy='strict' on opt-in", async () => {
    const s = new InMemoryStorage();
    const rec: UsernameRecord = {
      username: "bob",
      irkPubHex: "22".repeat(32),
      claimedAt: 1,
      recoveryWipePolicy: "strict",
    };
    await s.usernames.put(rec);
    const row = await s.usernames.get("bob");
    expect(row?.recoveryWipePolicy).toBe("strict");
  });

  it("a benign re-put (same IRK, no policy field) preserves an existing 'strict'", async () => {
    // The corporate path is the one where a regression here matters
    // most: a phone re-claim that omits the policy must NOT silently
    // downgrade an account-owner's opt-in 'strict' choice.
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: "carol",
      irkPubHex: "33".repeat(32),
      claimedAt: 1,
      recoveryWipePolicy: "strict",
    });
    await s.usernames.put({
      username: "carol",
      irkPubHex: "33".repeat(32),
      claimedAt: 2,
    });
    const row = await s.usernames.get("carol");
    expect(row?.recoveryWipePolicy).toBe("strict");
    expect(row?.claimedAt).toBe(2);
  });

  it("clearTotp (disable path) preserves the recoveryWipePolicy", async () => {
    // clearTotp explicitly rebuilds the record; it must not drop the
    // wipe policy along the way (the two settings are independent).
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: "dave",
      irkPubHex: "44".repeat(32),
      claimedAt: 1,
      accountType: "multi",
      totpEnrolledAt: 1_700_000_500_000,
      recoveryWipePolicy: "strict",
    });
    expect(await s.usernames.clearTotp("dave")).toBe(true);
    const row = await s.usernames.get("dave");
    expect(row?.recoveryWipePolicy).toBe("strict");
    expect(row?.accountType).toBe("single");
  });
});
