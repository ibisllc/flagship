import { describe, expect, it } from "vitest";
import { InMemoryAuditEventStorage } from "@flagship/storage";
import {
  handleGetAuditEvents,
  recordAuditEvent,
  type AuditListResponse,
} from "../src/auditEvents.js";

describe("audit events", () => {
  it("starts empty for a fresh user", async () => {
    const s = new InMemoryAuditEventStorage();
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    expect(r.status).toBe(200);
    expect((r.body as AuditListResponse).events).toEqual([]);
  });

  it("records and lists a single event", async () => {
    const s = new InMemoryAuditEventStorage();
    const rec = await recordAuditEvent({ auditEvents: s }, {
      username: "alice",
      eventKind: "device-disconnected",
      detail: "Disconnected iPad (kitchen)",
      devicePrefix: "ab12cd34",
      postedAt: 1_700_000_000_000,
    });
    expect(rec.seq).toBeGreaterThan(0);
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    const events = (r.body as AuditListResponse).events;
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      eventKind: "device-disconnected",
      detail: "Disconnected iPad (kitchen)",
      devicePrefix: "ab12cd34",
    });
  });

  it("returns events in descending seq order (latest first)", async () => {
    const s = new InMemoryAuditEventStorage();
    for (const kind of ["device-added", "device-replaced", "device-disconnected"] as const) {
      await recordAuditEvent({ auditEvents: s }, {
        username: "alice", eventKind: kind, detail: kind, devicePrefix: "", postedAt: 1,
      });
    }
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    const events = (r.body as AuditListResponse).events;
    expect(events.map((e) => e.eventKind)).toEqual([
      "device-disconnected", "device-replaced", "device-added",
    ]);
  });

  it("paginates with sinceSeq cursor (exclusive lower bound)", async () => {
    const s = new InMemoryAuditEventStorage();
    const recs = [];
    for (let i = 0; i < 5; i++) {
      recs.push(await recordAuditEvent({ auditEvents: s }, {
        username: "alice", eventKind: "device-added", detail: `e${i}`, devicePrefix: "", postedAt: i,
      }));
    }
    // Read the first page (descending). Take seq of the second-most-recent
    // as the cursor; the next call should return only events newer than that.
    const allEvents = (await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50)).body as AuditListResponse;
    expect(allEvents.events.length).toBe(5);
    const since = allEvents.events[1]!.seq; // skip the latest
    const page2 = (await handleGetAuditEvents({ auditEvents: s }, "alice", since, 50)).body as AuditListResponse;
    expect(page2.events.length).toBe(1);
    expect(page2.events[0]!.seq).toBe(allEvents.events[0]!.seq);
  });

  it("caps limit at 50 even when caller asks for more", async () => {
    const s = new InMemoryAuditEventStorage();
    for (let i = 0; i < 60; i++) {
      await recordAuditEvent({ auditEvents: s }, {
        username: "alice", eventKind: "device-added", detail: String(i), devicePrefix: "", postedAt: i,
      });
    }
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 1000);
    expect((r.body as AuditListResponse).events.length).toBe(50);
  });

  it("does not leak events across users", async () => {
    const s = new InMemoryAuditEventStorage();
    await recordAuditEvent({ auditEvents: s }, {
      username: "alice", eventKind: "device-added", detail: "A", devicePrefix: "", postedAt: 1,
    });
    await recordAuditEvent({ auditEvents: s }, {
      username: "bob", eventKind: "device-added", detail: "B", devicePrefix: "", postedAt: 1,
    });
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    const events = (r.body as AuditListResponse).events;
    expect(events.length).toBe(1);
    expect(events[0]!.detail).toBe("A");
  });

  it("rejects malformed usernames with 400", async () => {
    const s = new InMemoryAuditEventStorage();
    const r = await handleGetAuditEvents({ auditEvents: s }, "Has Spaces!", 0, 50);
    expect(r.status).toBe(400);
  });

  it("truncates oversized detail strings on ingest rather than failing", async () => {
    const s = new InMemoryAuditEventStorage();
    const long = "x".repeat(500);
    const rec = await recordAuditEvent({ auditEvents: s }, {
      username: "alice", eventKind: "device-added", detail: long, devicePrefix: "", postedAt: 1,
    });
    expect(rec.detail.length).toBe(256);
  });

  it("normalizes username to lowercase on ingest", async () => {
    const s = new InMemoryAuditEventStorage();
    await recordAuditEvent({ auditEvents: s }, {
      username: "ALICE", eventKind: "device-added", detail: "x", devicePrefix: "", postedAt: 1,
    });
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    expect((r.body as AuditListResponse).events.length).toBe(1);
  });

  it("attaches private no-cache headers (per-user data)", async () => {
    const s = new InMemoryAuditEventStorage();
    const r = await handleGetAuditEvents({ auditEvents: s }, "alice", 0, 50);
    expect(r.headers?.["cache-control"]).toContain("private");
  });
});
