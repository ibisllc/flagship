/**
 * Phase 3b — quarantine review-alert scheduler tests.
 *
 * Exercises the per-device bit-OR ladder (T+0/+1d/+3d/+7d/+13d) on a
 * freshly-admitted (vouched-QR) device's push_tokens row: the bits fire
 * once at the documented offsets, the bitmask prevents a double-fire,
 * non-quarantined / expired rows are skipped, and the real fan-out
 * targets the owner's OTHER devices (never the device under review).
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorage, type PushTokenRecord } from "@flagship/storage";
import {
  QUARANTINE_ALERT_BIT_T0,
  QUARANTINE_ALERT_BIT_T1D,
  QUARANTINE_ALERT_BIT_T3D,
  QUARANTINE_ALERT_BIT_T7D,
  QUARANTINE_ALERT_BIT_T13D,
  scheduleQuarantineAlerts,
} from "../src/quarantineAlerts.js";

const USERNAME = "alice";
const FIXED_NOW = 1_700_000_000_000;
const QUARANTINE_MS = 14 * 86_400_000;

function quarantinedToken(overrides: Partial<PushTokenRecord> = {}): PushTokenRecord {
  return {
    tokenId: "collab-device",
    username: USERNAME,
    platform: "apns",
    providerToken: "provider-collab",
    pushX25519PubHex: "01".repeat(32),
    registrationSignatureHex: "00".repeat(64),
    label: "Collaborator's Pixel",
    registeredAt: FIXED_NOW,
    lastSeenAt: FIXED_NOW,
    quarantineUntil: FIXED_NOW + QUARANTINE_MS,
    quarantineAlertsFiredBitmap: 0,
    ...overrides,
  };
}

interface RecordedFire {
  username: string;
  tokenId: string;
  bit: number;
  category: string;
}

function recordingFirePush() {
  const fires: RecordedFire[] = [];
  return {
    fires,
    fn: async (req: {
      username: string;
      quarantinedTokenId: string;
      bit: number;
      category: string;
    }) => {
      fires.push({
        username: req.username,
        tokenId: req.quarantinedTokenId,
        bit: req.bit,
        category: req.category,
      });
    },
  };
}

describe("scheduleQuarantineAlerts — the 14-day ladder", () => {
  it("fires T+0 on the first tick after admit (bitmap was 0)", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken());
    const rec = recordingFirePush();
    const res = await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(res.scanned).toBe(1);
    expect(rec.fires.map((f) => f.bit)).toEqual([QUARANTINE_ALERT_BIT_T0]);
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(QUARANTINE_ALERT_BIT_T0);
  });

  it("does NOT re-fire T+0 if the bit is already set (bitmask idempotency)", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(
      quarantinedToken({ quarantineAlertsFiredBitmap: QUARANTINE_ALERT_BIT_T0 }),
    );
    const rec = recordingFirePush();
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(rec.fires).toHaveLength(0);
  });

  it("fires T+1d at exactly admit + 1 day", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(
      quarantinedToken({ quarantineAlertsFiredBitmap: QUARANTINE_ALERT_BIT_T0 }),
    );
    const rec = recordingFirePush();
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW + 86_400_000,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([QUARANTINE_ALERT_BIT_T1D]);
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(
      QUARANTINE_ALERT_BIT_T0 | QUARANTINE_ALERT_BIT_T1D,
    );
  });

  it("fires every overdue rung at once when the cron skips windows (catch-up)", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(
      quarantinedToken({ quarantineAlertsFiredBitmap: QUARANTINE_ALERT_BIT_T0 }),
    );
    const rec = recordingFirePush();
    // 8 days in — T+1d, T+3d, T+7d should all fire (T+13d not yet).
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW + 8 * 86_400_000,
    });
    expect(new Set(rec.fires.map((f) => f.bit))).toEqual(
      new Set([
        QUARANTINE_ALERT_BIT_T1D,
        QUARANTINE_ALERT_BIT_T3D,
        QUARANTINE_ALERT_BIT_T7D,
      ]),
    );
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(
      QUARANTINE_ALERT_BIT_T0 |
        QUARANTINE_ALERT_BIT_T1D |
        QUARANTINE_ALERT_BIT_T3D |
        QUARANTINE_ALERT_BIT_T7D,
    );
  });

  it("fires the final T+13d nudge before the quarantine lifts", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(
      quarantinedToken({
        quarantineAlertsFiredBitmap:
          QUARANTINE_ALERT_BIT_T0 |
          QUARANTINE_ALERT_BIT_T1D |
          QUARANTINE_ALERT_BIT_T3D |
          QUARANTINE_ALERT_BIT_T7D,
      }),
    );
    const rec = recordingFirePush();
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW + 13 * 86_400_000,
    });
    expect(rec.fires.map((f) => f.bit)).toEqual([QUARANTINE_ALERT_BIT_T13D]);
  });

  it("each rung fires exactly once across repeated ticks", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken());
    const rec = recordingFirePush();
    const deps = {
      pushTokens: s.pushTokens,
      firePush: rec.fn,
    };
    // Tick repeatedly across the window; every rung must fire once.
    for (const t of [0, 0, 1, 1, 3, 3, 7, 7, 13, 13]) {
      await scheduleQuarantineAlerts({ ...deps, now: () => FIXED_NOW + t * 86_400_000 });
    }
    expect(rec.fires.map((f) => f.bit)).toEqual([
      QUARANTINE_ALERT_BIT_T0,
      QUARANTINE_ALERT_BIT_T1D,
      QUARANTINE_ALERT_BIT_T3D,
      QUARANTINE_ALERT_BIT_T7D,
      QUARANTINE_ALERT_BIT_T13D,
    ]);
  });
});

describe("scheduleQuarantineAlerts — guards", () => {
  it("skips a non-quarantined (quarantineUntil=0) row entirely", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken({ quarantineUntil: 0 }));
    const rec = recordingFirePush();
    const res = await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW,
    });
    expect(res.scanned).toBe(0);
    expect(rec.fires).toHaveLength(0);
  });

  it("skips a row whose quarantine has already expired", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken());
    const rec = recordingFirePush();
    const res = await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      // 15 days in — the 14-day quarantine has lifted.
      now: () => FIXED_NOW + 15 * 86_400_000,
    });
    expect(res.scanned).toBe(0);
    expect(rec.fires).toHaveLength(0);
  });

  it("a firePush failure does NOT stamp the bit (next tick retries)", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken());
    let calls = 0;
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: async () => {
        calls++;
        throw new Error("apns down");
      },
      now: () => FIXED_NOW,
    });
    expect(calls).toBe(1);
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(0);
  });

  it("walks multiple quarantined devices in admit-ascending order", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(
      quarantinedToken({ tokenId: "dev-late", registeredAt: FIXED_NOW + 200 }),
    );
    await s.pushTokens.put(
      quarantinedToken({ tokenId: "dev-early", registeredAt: FIXED_NOW + 100 }),
    );
    const rec = recordingFirePush();
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      firePush: rec.fn,
      now: () => FIXED_NOW + 1_000,
    });
    expect(rec.fires.map((f) => f.tokenId)).toEqual(["dev-early", "dev-late"]);
  });
});

describe("scheduleQuarantineAlerts — real fan-out targets the owner's OTHER devices", () => {
  async function seedOwnerDevices(s: InMemoryStorage): Promise<void> {
    // Two pre-existing trusted devices...
    for (const id of ["trusted-A", "trusted-B"]) {
      await s.pushTokens.put({
        tokenId: id,
        username: USERNAME,
        platform: "apns",
        providerToken: `provider-${id}`,
        pushX25519PubHex: "01".repeat(32),
        registrationSignatureHex: "00".repeat(64),
        label: `Owner device ${id}`,
        registeredAt: FIXED_NOW - 86_400_000,
        lastSeenAt: FIXED_NOW,
      });
    }
    // ...plus the freshly-admitted quarantined collaborator device.
    await s.pushTokens.put(quarantinedToken());
  }

  it("fans out to the trusted devices and EXCLUDES the quarantined device", async () => {
    const s = new InMemoryStorage();
    await seedOwnerDevices(s);
    const fires: Array<{ username: string; tokenIds: string[]; body: string; deepLink: string }> = [];
    const res = await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async ({ username, targets, payload }) => {
        fires.push({
          username,
          tokenIds: targets.map((t) => t.tokenId),
          body: payload.body,
          deepLink: payload.deepLink,
        });
      },
      now: () => FIXED_NOW,
    });
    // Only the one quarantined device is scanned (the trusted ones
    // aren't quarantined), and it fires its T+0 rung once.
    expect(res.scanned).toBe(1);
    expect(fires).toHaveLength(1);
    expect(new Set(fires[0]!.tokenIds)).toEqual(new Set(["trusted-A", "trusted-B"]));
    expect(fires[0]!.tokenIds).not.toContain("collab-device");
    expect(fires[0]!.body).toMatch(/new device/i);
    expect(fires[0]!.deepLink).toMatch(/^flagship:\/\/account\/devices\?u=alice/);
    // Audit row landed + the bit stamped.
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(QUARANTINE_ALERT_BIT_T0);
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("device-added");
  });

  it("when the quarantined device is the owner's ONLY device, no push but bit + audit still land", async () => {
    const s = new InMemoryStorage();
    await s.pushTokens.put(quarantinedToken());
    const fires: number[] = [];
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async () => {
        fires.push(1);
      },
      now: () => FIXED_NOW,
    });
    expect(fires).toHaveLength(0);
    const after = await s.pushTokens.get("collab-device");
    expect(after?.quarantineAlertsFiredBitmap).toBe(QUARANTINE_ALERT_BIT_T0);
    expect(await s.auditEvents.list(USERNAME, 0, 10)).toHaveLength(1);
  });

  it("legacy firePush OVERRIDES the high-level deps (backward-compat)", async () => {
    const s = new InMemoryStorage();
    await seedOwnerDevices(s);
    const legacy: number[] = [];
    const real: number[] = [];
    await scheduleQuarantineAlerts({
      pushTokens: s.pushTokens,
      auditEvents: s.auditEvents,
      pushFanout: async () => {
        real.push(1);
      },
      firePush: async () => {
        legacy.push(1);
      },
      now: () => FIXED_NOW,
    });
    expect(legacy).toHaveLength(1);
    expect(real).toHaveLength(0);
  });
});
