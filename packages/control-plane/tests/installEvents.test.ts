import { describe, expect, it } from "vitest";
import {
  handleGetInstallEvents,
  handlePostInstallEvent,
} from "../src/installEvents.js";
import { InMemoryStorage } from "@flagship/storage";

describe("install events", () => {
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
    for (let i = 0; i < 120; i++) {
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
});
