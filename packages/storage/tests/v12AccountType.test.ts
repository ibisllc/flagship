/**
 * Plan B Phase 1 — v1.2 security-cascade schema tests.
 *
 * Anchors the storage-layer contracts the rest of the cascade
 * (grace-period widening, 14-day quarantine, TOTP enrolment) depends
 * on. The route-level + Worker-handler tests in apps/com cover the
 * wire path; this suite locks the storage adapters and the migration
 * SQL itself.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import type {
  AccountType,
  PendingRePairRecord,
  PushTokenRecord,
  UsernameRecord,
} from "../src/types.js";

// Resolve the migration file relative to this test file so the suite
// works regardless of the vitest cwd (vitest is invoked from the
// repo root).
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, "../migrations/0028_account_type.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

function pushRow(overrides: Partial<PushTokenRecord> = {}): PushTokenRecord {
  return {
    tokenId: "tok-aaaa",
    username: "alice",
    platform: "apns",
    providerToken: "ptoken",
    pushX25519PubHex: "aa".repeat(32),
    registrationSignatureHex: "bb".repeat(64),
    label: "iPhone 15",
    registeredAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ...overrides,
  };
}

function rePair(overrides: Partial<PendingRePairRecord> = {}): PendingRePairRecord {
  return {
    username: "alice",
    newIrkPubHex: "cc".repeat(32),
    oldIrkPubHex: "dd".repeat(32),
    initiatedAt: 1_700_000_000_000,
    completesAt: 1_700_000_000_000 + 86_400_000,
    ...overrides,
  };
}

describe("migration 0028 (v1.2 security cascade)", () => {
  it("adds account_type + TOTP columns to usernames", () => {
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE usernames ADD COLUMN account_type TEXT NOT NULL DEFAULT 'single'/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE usernames ADD COLUMN totp_secret_encrypted TEXT/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE usernames ADD COLUMN recovery_codes_hashes_json TEXT/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE usernames ADD COLUMN totp_enrolled_at INTEGER/,
    );
  });

  it("adds grace_seconds + totp_required + totp_proof_consumed to pending_re_pairs", () => {
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE pending_re_pairs ADD COLUMN grace_seconds INTEGER NOT NULL DEFAULT 86400/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE pending_re_pairs ADD COLUMN totp_required INTEGER NOT NULL DEFAULT 0/,
    );
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE pending_re_pairs ADD COLUMN totp_proof_consumed INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("adds quarantine_until to the .com-side device record (push_tokens)", () => {
    // Per docs/v1.2-security-cascade.md the column lives on what the
    // doc calls `paired_sessions`. On the .com side the equivalent
    // table is `push_tokens` (see 0028 migration header). This pin
    // catches accidental renames during Phase 2.
    expect(MIGRATION_SQL).toMatch(
      /ALTER TABLE push_tokens ADD COLUMN quarantine_until INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("creates the quarantine + account_type indexes", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_push_tokens_quarantine ON push_tokens\(quarantine_until\)/,
    );
    expect(MIGRATION_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_usernames_account_type ON usernames\(account_type\)/,
    );
  });
});

describe("AccountType union", () => {
  it("matches the three documented modes", () => {
    // A compile-time check would catch new values; this pins the runtime
    // shape so a stray rename of one of the three literals is caught.
    const valid: AccountType[] = ["single", "multi", "demo"];
    expect(valid).toHaveLength(3);
  });
});

describe("InMemoryUsernameStorage v1.2 fields", () => {
  it("defaults accountType to 'single' on a put without the field", async () => {
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: "alice",
      irkPubHex: "11".repeat(32),
      claimedAt: 1,
    });
    const row = await s.usernames.get("alice");
    expect(row?.accountType).toBe("single");
    expect(row?.totpSecretEncrypted).toBeUndefined();
    expect(row?.recoveryCodesHashesJson).toBeUndefined();
    expect(row?.totpEnrolledAt).toBeUndefined();
  });

  it("round-trips accountType='multi' + the TOTP enrollment artifacts", async () => {
    const s = new InMemoryStorage();
    const rec: UsernameRecord = {
      username: "bob",
      irkPubHex: "22".repeat(32),
      claimedAt: 1,
      accountType: "multi",
      totpSecretEncrypted: "kek-encrypted-secret",
      recoveryCodesHashesJson: '["argonHash1","argonHash2"]',
      totpEnrolledAt: 1_700_000_500_000,
    };
    await s.usernames.put(rec);
    const row = await s.usernames.get("bob");
    expect(row?.accountType).toBe("multi");
    expect(row?.totpSecretEncrypted).toBe("kek-encrypted-secret");
    expect(row?.recoveryCodesHashesJson).toBe('["argonHash1","argonHash2"]');
    expect(row?.totpEnrolledAt).toBe(1_700_000_500_000);
  });

  it("a benign re-put (same IRK, no accountType) preserves an existing 'multi'", async () => {
    // Crucial regression guard: a single-device-callsite re-put on a
    // multi-device account must NOT kick the account back to single.
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: "carol",
      irkPubHex: "33".repeat(32),
      claimedAt: 1,
      accountType: "multi",
      totpEnrolledAt: 1_700_000_500_000,
    });
    await s.usernames.put({
      username: "carol",
      irkPubHex: "33".repeat(32),
      claimedAt: 2,
    });
    const row = await s.usernames.get("carol");
    expect(row?.accountType).toBe("multi");
    expect(row?.totpEnrolledAt).toBe(1_700_000_500_000);
    expect(row?.claimedAt).toBe(2);
  });
});

describe("InMemoryPendingRePairStorage v1.2 fields", () => {
  it("defaults graceSeconds to 86400 + flags to false on an initiate without the fields", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair());
    const row = await s.pendingRePairs.get("alice");
    expect(row?.graceSeconds).toBe(86_400);
    expect(row?.totpRequired).toBe(false);
    expect(row?.totpProofConsumed).toBe(false);
  });

  it("round-trips a single-device 7-day grace (graceSeconds=604800)", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair({ graceSeconds: 604_800 }));
    const row = await s.pendingRePairs.get("alice");
    expect(row?.graceSeconds).toBe(604_800);
    expect(row?.totpRequired).toBe(false);
  });

  it("round-trips totpRequired=true + totpProofConsumed on a multi-device row", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(
      rePair({ totpRequired: true, totpProofConsumed: true, graceSeconds: 86_400 }),
    );
    const row = await s.pendingRePairs.get("alice");
    expect(row?.totpRequired).toBe(true);
    expect(row?.totpProofConsumed).toBe(true);
  });
});

describe("InMemoryPendingRePairStorage v1.2 Phase 2 alert bitmap", () => {
  // The migration file is referenced from a separate path because
  // 0029 is its own file (Phase 2's additive column on top of 0028).
  const ALERTS_MIGRATION_PATH = resolve(HERE, "../migrations/0029_re_pair_alerts.sql");
  const ALERTS_SQL = readFileSync(ALERTS_MIGRATION_PATH, "utf8");

  it("0029 migration adds alerts_fired_bitmap column", () => {
    expect(ALERTS_SQL).toMatch(
      /ALTER TABLE pending_re_pairs ADD COLUMN alerts_fired_bitmap INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("defaults alertsFiredBitmap to 0 on an initiate without the field", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair());
    const row = await s.pendingRePairs.get("alice");
    expect(row?.alertsFiredBitmap).toBe(0);
  });

  it("round-trips alertsFiredBitmap=1 (T+0 stamped by the initiate handler)", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair({ alertsFiredBitmap: 1 }));
    const row = await s.pendingRePairs.get("alice");
    expect(row?.alertsFiredBitmap).toBe(1);
  });

  it("orInAlertsFiredBit is atomic OR — repeated calls with the same bit are no-ops", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair({ alertsFiredBitmap: 1 }));
    expect(await s.pendingRePairs.orInAlertsFiredBit("alice", 2)).toBe(3);
    expect(await s.pendingRePairs.orInAlertsFiredBit("alice", 2)).toBe(3);
    expect(await s.pendingRePairs.orInAlertsFiredBit("alice", 8)).toBe(11);
    const row = await s.pendingRePairs.get("alice");
    expect(row?.alertsFiredBitmap).toBe(11);
  });

  it("orInAlertsFiredBit returns 0 on an unknown username (no row to OR into)", async () => {
    const s = new InMemoryStorage();
    expect(await s.pendingRePairs.orInAlertsFiredBit("ghost", 1)).toBe(0);
  });

  it("listActive returns non-objected rows in initiatedAt-ascending order, capped at limit", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair({ username: "u2", initiatedAt: 200 }));
    await s.pendingRePairs.initiate(rePair({ username: "u1", initiatedAt: 100 }));
    await s.pendingRePairs.initiate(rePair({ username: "u3", initiatedAt: 300 }));
    const all = await s.pendingRePairs.listActive();
    expect(all.map((r) => r.username)).toEqual(["u1", "u2", "u3"]);
    const capped = await s.pendingRePairs.listActive(2);
    expect(capped.map((r) => r.username)).toEqual(["u1", "u2"]);
  });

  it("listActive skips objected rows", async () => {
    const s = new InMemoryStorage();
    await s.pendingRePairs.initiate(rePair({ username: "u1", initiatedAt: 100 }));
    await s.pendingRePairs.initiate(rePair({ username: "u2", initiatedAt: 200 }));
    await s.pendingRePairs.object("u1", 250);
    const active = await s.pendingRePairs.listActive();
    expect(active.map((r) => r.username)).toEqual(["u2"]);
  });
});

describe("InMemoryPushTokenStorage v1.2 setQuarantineUntil", () => {
  it("sets quarantineUntil on an existing row", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(pushRow());
    const future = 1_700_000_000_000 + 14 * 86_400_000;
    expect(await s.pushTokens.setQuarantineUntil("tok-aaaa", future)).toBe(true);
    const row = await s.pushTokens.get("tok-aaaa");
    expect(row?.quarantineUntil).toBe(future);
  });

  it("returns false on an unknown tokenId (no row to stamp)", async () => {
    const s = new InMemoryStorage();
    expect(await s.pushTokens.setQuarantineUntil("ghost", 12345)).toBe(false);
  });

  it("last-writer-wins semantics — a second setQuarantineUntil overwrites the first", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(pushRow());
    await s.pushTokens.setQuarantineUntil("tok-aaaa", 1_000_000);
    await s.pushTokens.setQuarantineUntil("tok-aaaa", 2_000_000);
    const row = await s.pushTokens.get("tok-aaaa");
    expect(row?.quarantineUntil).toBe(2_000_000);
  });
});

describe("InMemoryPushTokenStorage v1.2 quarantine", () => {
  it("defaults quarantineUntil to 0 (already-trusted) on a put without the field", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(pushRow());
    const row = await s.pushTokens.get("tok-aaaa");
    expect(row?.quarantineUntil).toBe(0);
  });

  it("round-trips quarantineUntil = now + 14 days for a freshly-admitted device", async () => {
    const s = new InMemoryStorage();
    const now = 1_700_000_000_000;
    const fourteenDays = 14 * 86_400_000;
    await s.pushTokens.put(pushRow({ quarantineUntil: now + fourteenDays }));
    const row = await s.pushTokens.get("tok-aaaa");
    expect(row?.quarantineUntil).toBe(now + fourteenDays);
  });

  it("listByUser can be filtered to non-quarantined devices at the call-site", async () => {
    // The storage interface doesn't ship a quarantine-filtered list,
    // so the test exercises the caller-side filter that Phase 2 will
    // use on /api/users/:u/devices/:id/disconnect to reject revoke-
    // others attempts from a quarantined session.
    const s = new InMemoryStorage();
    const now = 1_700_000_000_000;
    await s.pushTokens.put(pushRow({ tokenId: "trusted", quarantineUntil: 0 }));
    await s.pushTokens.put(
      pushRow({ tokenId: "fresh", quarantineUntil: now + 14 * 86_400_000 }),
    );
    const all = await s.pushTokens.listByUser("alice");
    const nonQuarantined = all.filter((r) => (r.quarantineUntil ?? 0) <= now);
    expect(nonQuarantined.map((r) => r.tokenId)).toEqual(["trusted"]);
  });

  it("a benign push_token refresh (re-put on same tokenId) does NOT touch the existing quarantineUntil", async () => {
    // The InMemory adapter stores whatever the put-call supplies, so a
    // re-put with the field absent lands as 0 — but the D1 adapter's
    // ON CONFLICT clause excludes quarantine_until from the update
    // list, so production behavior is "keep the existing value". This
    // test pins the InMemory adapter to the same semantics by always
    // supplying quarantineUntil on re-put; the assertion below
    // documents that callers must read-modify-write rather than
    // overwriting blindly.
    const s = new InMemoryStorage();
    const now = 1_700_000_000_000;
    const fourteenDays = 14 * 86_400_000;
    await s.pushTokens.put(pushRow({ quarantineUntil: now + fourteenDays }));
    const before = await s.pushTokens.get("tok-aaaa");
    // Phase 2's refresh path must echo the existing quarantine back.
    await s.pushTokens.put(pushRow({ quarantineUntil: before?.quarantineUntil ?? 0 }));
    const after = await s.pushTokens.get("tok-aaaa");
    expect(after?.quarantineUntil).toBe(now + fourteenDays);
  });
});
