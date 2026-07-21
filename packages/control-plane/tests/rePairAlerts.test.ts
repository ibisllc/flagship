/**
 * v1.2 Plan B Phase 2 — pending-re-pair alert scheduler tests.
 *
 * Exercises the bit-OR ladder: T+0 / the two grace-relative
 * intermediate reminders (~⅓ + ~⅔ of the window) / urgent fire at the
 * documented offsets, the bitmap monotonically grows by the OR-in, and
 * an objected row is skipped. Single-device grace is 3 days
 * (RE_PAIR_SINGLE_GRACE_MS), so ~⅓ ≈ day-1 and ~⅔ ≈ day-2. The
 * push-bridge is stubbed via a recording firePush; Phase 5 wires the
 * real APNs/FCM/Web Push fan-out and these tests stay green because
 * the contract is firePush(args) — no specific transport here.
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorage, type PendingRePairRecord } from "@flagship/storage";
import {
  ALERT_BIT_T0,
  ALERT_BIT_T1D,
  ALERT_BIT_T3D,
  ALERT_BIT_URGENT,
  schedulePendingRePairAlerts,
} from "../src/rePairAlerts.js";

const USERNAME = "alice";

const FIXED_NOW = 1_700_000_000_000;

const DAY_MS = 86_400_000;
/** Single-device grace = 3 days (RE_PAIR_SINGLE_GRACE_MS). */
const SINGLE_GRACE_MS = 3 * DAY_MS;

function pending(overrides: Partial<PendingRePairRecord> = {}): PendingRePairRecord {
  return {
    username: USERNAME,
    newIrkPubHex: "aa".repeat(32),
    oldIrkPubHex: "bb".repeat(32),
    initiatedAt: FIXED_NOW,
    completesAt: FIXED_NOW + SINGLE_GRACE_MS,
    graceSeconds: SINGLE_GRACE_MS / 1000,
    totpRequired: false,
    totpProofConsumed: false,
    alertsFiredBitmap: 0,
    ...overrides,
  };
}

interface RecordedFire {
  username: string;
  bit: number;
  category: string;
}

function recordingFirePush() {
  const fires: RecordedFire[] = [];
  return {
    fires,
    fn: async (req: { username: string; bit: number; category: string }) => {
      fires.push({ username: req.username, bit: req.bit, category: req.category });
    },
  };
}

async function seed(
  storage: InMemoryStorage,
  rec: PendingRePairRecord,
): Promise<void> {
  const r = await storage.pendingRePairs.initiate(rec);
  if (!r.ok) throw new Error(r.reason);
}

describe("schedulePendingRePairAlerts — single-device 3-day grace ladder", () => {
  it("fires T+0 when the row's bitmap is 0 (cron tick caught the row before the initiate stamped bit 0)", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: 0 }));
    const rec = recordingFirePush();
    const res = await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(res.scanned).toBe(1);
    // Only T+0 fires; the ⅓-grace rung (~day-1) and urgent are far off.
    expect(rec.fires.map((f) => f.bit)).toEqual([ALERT_BIT_T0]);
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(ALERT_BIT_T0);
  });

  it("does NOT re-fire T+0 if the bit is already set", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: ALERT_BIT_T0 }));
    const rec = recordingFirePush();
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(rec.fires).toHaveLength(0);
  });

  it("fires the first intermediate reminder at ~⅓ of the grace (~day-1 of 3)", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: ALERT_BIT_T0 }));
    const rec = recordingFirePush();
    // ⅓ of a 3-day window = exactly 1 day in.
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + SINGLE_GRACE_MS / 3,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([ALERT_BIT_T1D]);
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(ALERT_BIT_T0 | ALERT_BIT_T1D);
  });

  it("BUG-1 REGRESSION: a 3-day single-device grace still gets BOTH intermediate objection reminders", async () => {
    // Before the 7→3 migration the ladder was hard-coded to T+1d/T+3d/
    // T+6d gated on `grace >= 7d`, so a 3-day window fired ONLY T+0 +
    // urgent — the intermediate objection nudges (the real defense in
    // the takeover window) never landed. Now the rungs are grace-
    // relative, so both fire well inside the 3-day window.
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: ALERT_BIT_T0 }));

    // Just past ⅓ (day-1) — first reminder.
    const rec1 = recordingFirePush();
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec1.fn,
      now: () => FIXED_NOW + SINGLE_GRACE_MS / 3 + 60_000,
    });
    expect(rec1.fires.map((f) => f.bit)).toEqual([ALERT_BIT_T1D]);

    // Just past ⅔ (day-2) — second reminder (first already stamped).
    const rec2 = recordingFirePush();
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec2.fn,
      now: () => FIXED_NOW + (2 * SINGLE_GRACE_MS) / 3 + 60_000,
    });
    expect(rec2.fires.map((f) => f.bit)).toEqual([ALERT_BIT_T3D]);

    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(
      ALERT_BIT_T0 | ALERT_BIT_T1D | ALERT_BIT_T3D,
    );
  });

  it("fires every overdue intermediate bit at once when the cron skips a window (catch-up)", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: ALERT_BIT_T0 }));
    const rec = recordingFirePush();
    // 2.5 days in (past both ⅓ and ⅔) — both intermediates should fire.
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + Math.floor(2.5 * DAY_MS),
    });
    expect(new Set(rec.fires.map((f) => f.bit))).toEqual(
      new Set([ALERT_BIT_T1D, ALERT_BIT_T3D]),
    );
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(
      ALERT_BIT_T0 | ALERT_BIT_T1D | ALERT_BIT_T3D,
    );
  });

  it("fires the urgent ping ~1h before completesAt regardless of the ladder", async () => {
    const s = new InMemoryStorage();
    await seed(
      s,
      pending({
        alertsFiredBitmap: ALERT_BIT_T0 | ALERT_BIT_T1D | ALERT_BIT_T3D,
      }),
    );
    const rec = recordingFirePush();
    // 30 minutes before completion (3-day window).
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + SINGLE_GRACE_MS - 30 * 60_000,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([ALERT_BIT_URGENT]);
  });

  it("does not fire urgent AFTER completesAt has passed (the row is reapable)", async () => {
    const s = new InMemoryStorage();
    await seed(
      s,
      pending({
        alertsFiredBitmap: ALERT_BIT_T0 | ALERT_BIT_T1D | ALERT_BIT_T3D,
      }),
    );
    const rec = recordingFirePush();
    // 5 minutes AFTER completion.
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + SINGLE_GRACE_MS + 5 * 60_000,
    });
    expect(rec.fires).toHaveLength(0);
  });
});

describe("schedulePendingRePairAlerts — multi-device 24h grace", () => {
  it("only fires T+0 + URGENT (intermediate ladder is skipped)", async () => {
    const s = new InMemoryStorage();
    await seed(
      s,
      pending({
        graceSeconds: 86_400,
        completesAt: FIXED_NOW + 86_400_000,
        alertsFiredBitmap: 0,
      }),
    );
    const rec = recordingFirePush();
    // T+0
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([ALERT_BIT_T0]);
    // 23h30m in — urgent fires (~1h lead window).
    rec.fires.length = 0;
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + 23 * 3_600_000 + 30 * 60_000,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([ALERT_BIT_URGENT]);
  });

  it("does NOT fire any intermediate reminder on a multi-device row (ladder is gated on grace length)", async () => {
    const s = new InMemoryStorage();
    // Multi-device row with grace=24h. The intermediate ⅓/⅔ rungs are
    // single-device-only; the discriminator is the grace LENGTH
    // (> 24h ⇒ single), so a 24h row never gets them no matter how much
    // wall-clock has elapsed.
    await seed(
      s,
      pending({
        graceSeconds: 86_400,
        completesAt: FIXED_NOW + 86_400_000,
        alertsFiredBitmap: ALERT_BIT_T0,
      }),
    );
    const rec = recordingFirePush();
    // 30 minutes past initiation — well before completion. T+0 is set,
    // urgent isn't due yet, and no intermediate rung may fire because
    // the row is multi-device.
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + 30 * 60_000,
    });
    expect(rec.fires).toHaveLength(0);
  });
});

describe("v1.2 Plan B Phase 5 — real-push fan-out", () => {
  async function seedAlice(s: InMemoryStorage): Promise<void> {
    await s.usernames.put({
      username: USERNAME,
      irkPubHex: "aa".repeat(32),
      claimedAt: 1,
    });
  }

  async function seedPushTokens(s: InMemoryStorage, tokenIds: string[]): Promise<void> {
    for (const tokenId of tokenIds) {
      await s.pushTokens.put({
        tokenId,
        username: USERNAME,
        platform: "apns",
        providerToken: `provider-${tokenId}`,
        pushX25519PubHex: "01".repeat(32),
        registrationSignatureHex: "00".repeat(64),
        deviceId: tokenId,
        registeredAt: 1,
        lastSeenAt: 1,
      });
    }
  }

  it("when pushFanout + pushTokens are wired (no legacy firePush), the scheduler resolves the user's tokens and calls pushFanout with a typed payload", async () => {
    const s = new InMemoryStorage();
    await seedAlice(s);
    await seedPushTokens(s, ["devA", "devB"]);
    await seed(s, pending({ alertsFiredBitmap: 0 }));
    const fires: Array<{
      username: string;
      tokenIds: string[];
      category: string;
      body: string;
      deepLink: string;
    }> = [];
    const res = await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async ({ username, targets, payload }) => {
        fires.push({
          username,
          tokenIds: targets.map((t) => t.tokenId),
          category: payload.category,
          body: payload.body,
          deepLink: payload.deepLink,
        });
      },
      now: () => FIXED_NOW,
    });
    expect(res.scanned).toBe(1);
    expect(fires).toHaveLength(1);
    expect(new Set(fires[0]!.tokenIds)).toEqual(new Set(["devA", "devB"]));
    expect(fires[0]!.category).toBe("re-pair-initiated");
    expect(fires[0]!.body).toMatch(/new device.*account/i);
    expect(fires[0]!.deepLink).toMatch(/^flagship:\/\/account\/re-pair\?u=alice/);
    // Bit was stamped after the successful fan-out.
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(ALERT_BIT_T0);
    // Audit row captured the fired alert.
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("device-replaced");
    expect(events[0]?.detail).toMatch(/re-pair-initiated/);
  });

  it("urgent ping carries the 1h-before copy", async () => {
    const s = new InMemoryStorage();
    await seedAlice(s);
    await seedPushTokens(s, ["devA"]);
    await seed(
      s,
      pending({
        alertsFiredBitmap: ALERT_BIT_T0 | ALERT_BIT_T1D | ALERT_BIT_T3D,
      }),
    );
    const fires: Array<{ category: string; body: string }> = [];
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async ({ payload }) => {
        fires.push({ category: payload.category, body: payload.body });
      },
      now: () => FIXED_NOW + SINGLE_GRACE_MS - 30 * 60_000,
    });
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe("re-pair-urgent");
    expect(fires[0]!.body).toMatch(/1 hour/);
  });

  it("zero registered push tokens ⇒ no push fan-out but the bit still stamps + audit row still lands", async () => {
    const s = new InMemoryStorage();
    await seedAlice(s);
    await seed(s, pending({ alertsFiredBitmap: 0 }));
    const fires: number[] = [];
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async () => {
        fires.push(1);
      },
      now: () => FIXED_NOW,
    });
    expect(fires).toHaveLength(0);
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(ALERT_BIT_T0);
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
  });

  it("legacy `firePush` callback OVERRIDES the high-level deps (backward-compat)", async () => {
    const s = new InMemoryStorage();
    await seedAlice(s);
    await seedPushTokens(s, ["devA"]);
    await seed(s, pending({ alertsFiredBitmap: 0 }));
    const legacyFires: Array<{ username: string; bit: number }> = [];
    const realFires: Array<{ username: string }> = [];
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async ({ username }) => {
        realFires.push({ username });
      },
      firePush: async (req) => {
        legacyFires.push({ username: req.username, bit: req.bit });
      },
      now: () => FIXED_NOW,
    });
    // Only legacy fired.
    expect(legacyFires).toHaveLength(1);
    expect(realFires).toHaveLength(0);
  });
});

describe("schedulePendingRePairAlerts — guards", () => {
  it("skips objected rows", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: 0 }));
    await s.pendingRePairs.object(USERNAME, FIXED_NOW + 1_000);
    const rec = recordingFirePush();
    const res = await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      now: () => FIXED_NOW + 86_400_000,
    });
    expect(res.scanned).toBe(0);
    expect(rec.fires).toHaveLength(0);
  });

  it("a firePush failure does NOT stamp the bit (next tick retries)", async () => {
    const s = new InMemoryStorage();
    await seed(s, pending({ alertsFiredBitmap: ALERT_BIT_T0 }));
    let calls = 0;
    const firePush = async () => {
      calls++;
      throw new Error("apns down");
    };
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush,
      now: () => FIXED_NOW + 86_400_000,
    });
    expect(calls).toBe(1);
    // T+1d still not stamped.
    const after = await s.pendingRePairs.get(USERNAME);
    expect(after?.alertsFiredBitmap).toBe(ALERT_BIT_T0);
  });

  it("processes multiple rows in initiatedAt-ascending order, up to the scan limit", async () => {
    const s = new InMemoryStorage();
    // Add three pendings against three different usernames.
    await s.usernames.put({ username: "u1", irkPubHex: "aa".repeat(32), claimedAt: 1 });
    await s.usernames.put({ username: "u2", irkPubHex: "bb".repeat(32), claimedAt: 1 });
    await s.usernames.put({ username: "u3", irkPubHex: "cc".repeat(32), claimedAt: 1 });
    await s.pendingRePairs.initiate(pending({ username: "u2", initiatedAt: FIXED_NOW + 200, alertsFiredBitmap: 0 }));
    await s.pendingRePairs.initiate(pending({ username: "u1", initiatedAt: FIXED_NOW + 100, alertsFiredBitmap: 0 }));
    await s.pendingRePairs.initiate(pending({ username: "u3", initiatedAt: FIXED_NOW + 300, alertsFiredBitmap: 0 }));
    const rec = recordingFirePush();
    await schedulePendingRePairAlerts({
      pendingRePairs: s.pendingRePairs,
      firePush: rec.fn,
      // 1 day + 1 second AFTER FIXED_NOW + 300 (the latest initiation)
      // so all three rows qualify for both T+0 + T+1d.
      now: () => FIXED_NOW + 86_400_000 + 1_000,
      scanLimit: 100,
    });
    // Three rows, each fires T+0 + T+1d on this tick. The handler
    // walks rows initiation-ascending so u1 fires first.
    expect(rec.fires.map((f) => f.username)).toEqual([
      "u1", "u1", "u2", "u2", "u3", "u3",
    ]);
    expect(rec.fires.map((f) => f.bit)).toEqual([
      ALERT_BIT_T0, ALERT_BIT_T1D,
      ALERT_BIT_T0, ALERT_BIT_T1D,
      ALERT_BIT_T0, ALERT_BIT_T1D,
    ]);
  });
});
