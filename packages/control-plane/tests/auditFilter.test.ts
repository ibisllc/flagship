/**
 * v1.2 Plan B Phase 5 — `/api/users/:u/audit` echoes the new
 * account-type-aware columns (`accountTypeAtEvent`, `quarantineUntil`,
 * `recoveryMethod`).
 *
 * The legacy rows that pre-date the 0030 migration MUST still serialise
 * without the new fields so older clients see exactly the v1.1 shape.
 * New rows that carry the fields surface them verbatim.
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetAuditEvents,
  recordAuditEvent,
  type AuditEventSummary,
} from "../src/auditEvents.js";

const USERNAME = "alice";

describe("v1.2 Plan B Phase 5 — /api/users/:u/audit shape", () => {
  it("legacy row (pre-v1.2) serialises without the new fields", async () => {
    const s = new InMemoryStorage();
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "device-replaced",
        detail: "Replaced device",
        devicePrefix: "aabbccdd",
        postedAt: 1000,
      },
    );
    const res = await handleGetAuditEvents(
      { auditEvents: s.auditEvents },
      USERNAME,
      0,
      50,
    );
    expect(res.status).toBe(200);
    const events = (res.body as { events: AuditEventSummary[] }).events;
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventKind).toBe("device-replaced");
    // None of the v1.2 fields present on a legacy row.
    expect(e.accountTypeAtEvent).toBeUndefined();
    expect(e.quarantineUntil).toBeUndefined();
    expect(e.recoveryMethod).toBeUndefined();
  });

  it("v1.2 row carrying accountTypeAtEvent surfaces it in the response", async () => {
    const s = new InMemoryStorage();
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "totp-enrolled",
        detail: "TOTP 2FA enrolled",
        devicePrefix: "",
        postedAt: 2000,
        accountTypeAtEvent: "multi",
      },
    );
    const res = await handleGetAuditEvents(
      { auditEvents: s.auditEvents },
      USERNAME,
      0,
      50,
    );
    const events = (res.body as { events: AuditEventSummary[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("totp-enrolled");
    expect(events[0]?.accountTypeAtEvent).toBe("multi");
    expect(events[0]?.quarantineUntil).toBeUndefined();
    expect(events[0]?.recoveryMethod).toBeUndefined();
  });

  it("device-added row with quarantineUntil surfaces both the timestamp and the recoveryMethod", async () => {
    const s = new InMemoryStorage();
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "device-added",
        detail: "New device admitted",
        devicePrefix: "aabbccdd",
        postedAt: 3000,
        accountTypeAtEvent: "multi",
        quarantineUntil: 3000 + 14 * 86_400_000,
        recoveryMethod: "totp",
      },
    );
    const res = await handleGetAuditEvents(
      { auditEvents: s.auditEvents },
      USERNAME,
      0,
      50,
    );
    const events = (res.body as { events: AuditEventSummary[] }).events;
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventKind).toBe("device-added");
    expect(e.accountTypeAtEvent).toBe("multi");
    expect(e.quarantineUntil).toBe(3000 + 14 * 86_400_000);
    expect(e.recoveryMethod).toBe("totp");
  });

  it("recovery-code-consumed carries recoveryMethod='recovery-code'", async () => {
    const s = new InMemoryStorage();
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "recovery-code-consumed",
        detail: "Recovery code used during re-pair",
        devicePrefix: "",
        postedAt: 4000,
        accountTypeAtEvent: "multi",
        recoveryMethod: "recovery-code",
      },
    );
    const res = await handleGetAuditEvents(
      { auditEvents: s.auditEvents },
      USERNAME,
      0,
      50,
    );
    const events = (res.body as { events: AuditEventSummary[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.recoveryMethod).toBe("recovery-code");
  });

  it("mixed legacy + v1.2 rows preserve their respective shapes", async () => {
    const s = new InMemoryStorage();
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "device-disconnected",
        detail: "legacy",
        devicePrefix: "aaaaaaaa",
        postedAt: 100,
      },
    );
    await recordAuditEvent(
      { auditEvents: s.auditEvents },
      {
        username: USERNAME,
        eventKind: "quarantine-blocked-revoke",
        detail: "modern",
        devicePrefix: "bbbbbbbb",
        postedAt: 200,
        accountTypeAtEvent: "single",
        quarantineUntil: 200 + 14 * 86_400_000,
      },
    );
    const res = await handleGetAuditEvents(
      { auditEvents: s.auditEvents },
      USERNAME,
      0,
      50,
    );
    const events = (res.body as { events: AuditEventSummary[] }).events;
    // Descending by seq: modern row first.
    expect(events).toHaveLength(2);
    expect(events[0]?.eventKind).toBe("quarantine-blocked-revoke");
    expect(events[0]?.accountTypeAtEvent).toBe("single");
    expect(events[0]?.quarantineUntil).toBeDefined();
    expect(events[1]?.eventKind).toBe("device-disconnected");
    expect(events[1]?.accountTypeAtEvent).toBeUndefined();
  });
});
