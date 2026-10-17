// Per-app disk limits on the webapp (docs/app-runtimes.md §5.3): the lines on
// the app page, the notes on the server's Backups section, and the
// app-storage-full alert that reaches the presenter.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (rel: string) => import(pathToFileURL(resolve(__dirname, "../public/webapp", rel)).href);
const GB = 1024 ** 3;

describe("appStorage lines", () => {
  it("shows files and database use against their limits", async () => {
    const { appStorageLines } = await load("lib/appStorage.js");
    const lines = appStorageLines({
      files: { usedBytes: 2 * GB, limitBytes: 5 * GB },
      postgres: { usedBytes: 300 * 1024 ** 2, limitBytes: GB },
    });
    expect(lines.map((l: any) => l.label)).toEqual(["Files", "Database"]);
    expect(lines.every((l: any) => !l.full && l.note === "")).toBe(true);
    expect(lines[1].text).toContain("300 MB");
  });

  it("says why new data is refused when an app is full or its database is closed", async () => {
    const { appStorageLines, FULL_SENTENCE, STOPPED_SENTENCE } = await load("lib/appStorage.js");
    const lines = appStorageLines({
      files: { usedBytes: 5 * GB, limitBytes: 5 * GB, full: true },
      postgres: { usedBytes: 2 * GB, limitBytes: GB, writesBlocked: true, stopped: true },
    });
    expect(lines[0].note).toBe(FULL_SENTENCE);
    expect(lines[1].full).toBe(true);
    expect(lines[1].note).toBe(STOPPED_SENTENCE);
  });

  it("shows nothing for a box that sends no storage", async () => {
    const { appStorageLines, serverStorageNotes } = await load("lib/appStorage.js");
    expect(appStorageLines(undefined)).toEqual([]);
    expect(serverStorageNotes(null)).toEqual([]);
  });

  it("lists full apps by name and the disk brake on the server page", async () => {
    const { serverStorageNotes } = await load("lib/appStorage.js");
    const notes = serverStorageNotes(
      { brake: "on", apps: [{ serviceId: "a", files: { full: true } }, { serviceId: "b", postgres: { usedBytes: 1 } }] },
      (id: string) => `App ${id}`,
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("nearly full");
    expect(notes[1]).toContain("App a is full");
  });
});

describe("app-storage-full alert", () => {
  it("reaches the presenter tagged with the server, is acked, and skips the AI-chat path", async () => {
    const { drainAiChatAlertsOnce } = await load("lib/aiChatAlerts.js");
    const got: any[] = [];
    const calls: string[] = [];
    const fetcher = async (path: string) => {
      calls.push(path);
      return path.startsWith("/api/phone/alerts?")
        ? { events: [{ id: 4, alert: { kind: "app-storage-full", serviceId: "svc-1" } }], size: 1 }
        : { ok: true, size: 0 };
    };
    const r = await drainAiChatAlertsOnce({
      since: 0,
      fetcher,
      server: "home.alice.flagship.services",
      notify: () => {
        throw new Error("not an AI-chat alert");
      },
      onStorageFull: (a: any) => got.push(a),
    });
    expect(r.cursor).toBe(4);
    expect(got).toEqual([{ kind: "app-storage-full", serviceId: "svc-1", server: "home.alice.flagship.services" }]);
    expect(calls).toContain("/api/phone/alerts/ack");
  });

  it("a throwing presenter does not wedge the drain", async () => {
    const { drainAiChatAlertsOnce } = await load("lib/aiChatAlerts.js");
    const fetcher = async (path: string) =>
      path.startsWith("/api/phone/alerts?")
        ? { events: [{ id: 2, alert: { kind: "app-storage-full", serviceId: "s" } }], size: 1 }
        : { ok: true, size: 0 };
    const r = await drainAiChatAlertsOnce({ since: 0, fetcher, onStorageFull: () => { throw new Error("x"); } });
    expect(r.cursor).toBe(2);
  });
});
