import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInstallEventRateLimit,
  handleGetInstallEvents,
  handlePostInstallEvent,
} from "../src/installEvents.js";
import { InMemoryStorage } from "@flagship/storage";

describe("install events", () => {
  // Per-serial in-memory rate-limit (#18 hardening) is module-level;
  // reset before each case so test fixtures can post freely.
  beforeEach(() => __resetInstallEventRateLimit());
  it("appends events with monotonic seq, returned in order on GET", async () => {
    const storage = new InMemoryStorage();
    for (const ev of ["probe-trailer", "validate-trailer", "partition-disk"]) {
      const r = await handlePostInstallEvent(
        { storage: storage.installEvents },
        "01HXAFINST00001",
        { event: ev },
      );
      expect(r.status).toBe(200);
    }
    const r = await handleGetInstallEvents(
      { storage: storage.installEvents },
      "01HXAFINST00001",
      0,
    );
    expect(r.status).toBe(200);
    const body = r.body as { events: Array<{ seq: number; eventName: string }>; cursor: number };
    expect(body.events.map((e) => e.eventName)).toEqual([
      "probe-trailer",
      "validate-trailer",
      "partition-disk",
    ]);
    expect(body.events[0]!.seq).toBe(1);
    expect(body.events[2]!.seq).toBe(3);
    expect(body.cursor).toBe(3);
  });

  it("`since` cursor returns only newer events (long-poll friendly)", async () => {
    const storage = new InMemoryStorage();
    for (const ev of ["a", "b", "c", "d"]) {
      await handlePostInstallEvent(
        { storage: storage.installEvents },
        "01HXAFINST00002",
        { event: ev },
      );
    }
    const r = await handleGetInstallEvents(
      { storage: storage.installEvents },
      "01HXAFINST00002",
      2,
    );
    const body = r.body as { events: Array<{ eventName: string }> };
    expect(body.events.map((e) => e.eventName)).toEqual(["c", "d"]);
  });

  it("rejects an event name with invalid characters", async () => {
    const storage = new InMemoryStorage();
    const r = await handlePostInstallEvent(
      { storage: storage.installEvents },
      "01HXAFINST00003",
      { event: "BAD CHAR!" },
    );
    expect(r.status).toBe(400);
  });

  it("rejects a malformed serial", async () => {
    const storage = new InMemoryStorage();
    const r = await handlePostInstallEvent(
      { storage: storage.installEvents },
      "x", // too short
      { event: "ok" },
    );
    expect(r.status).toBe(400);
  });

  it("caps history per serial (in-memory cap = 100)", async () => {
    const storage = new InMemoryStorage();
    // Storage caps at 100; the rate-limit ring is reset by beforeEach
    // but kicks in at 60/min. Reset between batches so we can still
    // post enough to exercise the storage-level cap.
    for (let i = 0; i < 120; i++) {
      if (i % 50 === 0) __resetInstallEventRateLimit();
      await handlePostInstallEvent(
        { storage: storage.installEvents },
        "01HXAFINST00004",
        { event: `event-${i}`, detail: String(i) },
      );
    }
    const r = await handleGetInstallEvents(
      { storage: storage.installEvents },
      "01HXAFINST00004",
      0,
    );
    const body = r.body as { events: Array<{ eventName: string }> };
    expect(body.events.length).toBe(100);
    expect(body.events[0]!.eventName).toBe("event-20");
    expect(body.events[99]!.eventName).toBe("event-119");
  });

  it("rate-limits per-serial flood (#18 ring)", async () => {
    const storage = new InMemoryStorage();
    let firstReject: number | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await handlePostInstallEvent(
        { storage: storage.installEvents },
        "01HXAFFLOOD0001",
        { event: `e${i}` },
      );
      if (r.status !== 200 && firstReject === null) firstReject = i;
    }
    // 60/min window; the 61st post in the same window should reject.
    expect(firstReject).toBe(60);
  });

  it("rejects events for unknown serial when authCodes gate is wired (#18)", async () => {
    const storage = new InMemoryStorage();
    const r = await handlePostInstallEvent(
      { storage: storage.installEvents, authCodes: storage.authCodes },
      "01HXAFSTRANGE001",
      { event: "probe-trailer" },
    );
    expect(r.status).toBe(403);
  });
});
