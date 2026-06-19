// Web-experience gating — secured-sessions store + status-debounce logic
// (docs/service-access-gating.md, "Web-experience gating").
//
// The webapp authorizes a browser's QR-login knock and the box hands it a
// phone-held `secretId`. lib/securedSessions.js persists those handles (plain
// localStorage — a session handle, NOT key material) for the "Open secured
// sessions" Settings list, plus the >=60s status-check debounce that respects
// the box's ~1/min/secretId rate limit. We exercise the EXACT module the
// production webapp serves (dynamic import of the dist file).

import { beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function webappPath(...p: string[]) {
  return pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href;
}
async function loadSecuredSessions() {
  return import(webappPath("lib", "securedSessions.js"));
}

class MemStorage implements Storage {
  private kv = new Map<string, string>();
  get length() { return this.kv.size; }
  clear(): void { this.kv.clear(); }
  getItem(k: string): string | null { return this.kv.get(k) ?? null; }
  setItem(k: string, v: string): void { this.kv.set(k, String(v)); }
  removeItem(k: string): void { this.kv.delete(k); }
  key(i: number): string | null { return [...this.kv.keys()][i] ?? null; }
}

const SID_A = "a".repeat(64);
const SID_B = "b".repeat(64);

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemStorage();
});

describe("securedSessions store", () => {
  it("saves an authorize result, deriving serviceUrl from svc + serverId", async () => {
    const ss = await loadSecuredSessions();
    ss.saveSecuredSession({
      secretId: SID_A,
      serverId: "home.alice.flagship.services",
      serviceRef: "alice-notes",
      svc: "notes",
      browserAgent: "TestBrowser/1.0",
      startedAt: 1700004000000,
    });
    const list = ss.listSecuredSessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      secretId: SID_A,
      serverId: "home.alice.flagship.services",
      serviceRef: "alice-notes",
      serviceUrl: "https://notes.home.alice.flagship.services",
      browserAgent: "TestBrowser/1.0",
      startedAt: 1700004000000,
    });
  });

  it("falls back to the box root url when the svc label is unknown", async () => {
    const ss = await loadSecuredSessions();
    ss.saveSecuredSession({ secretId: SID_A, serverId: "home.alice.flagship.services", serviceRef: "alice-notes" });
    expect(ss.listSecuredSessions()[0].serviceUrl).toBe("https://home.alice.flagship.services");
  });

  it("replaces (not duplicates) a session re-saved under the same secretId", async () => {
    const ss = await loadSecuredSessions();
    ss.saveSecuredSession({ secretId: SID_A, serverId: "home.alice.flagship.services", serviceRef: "alice-notes", svc: "notes", startedAt: 1 });
    ss.saveSecuredSession({ secretId: SID_A, serverId: "home.alice.flagship.services", serviceRef: "alice-notes", svc: "notes", startedAt: 2 });
    const list = ss.listSecuredSessions();
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(2);
  });

  it("lists newest first", async () => {
    const ss = await loadSecuredSessions();
    ss.saveSecuredSession({ secretId: SID_A, serverId: "s1", serviceRef: "r1", startedAt: 100 });
    ss.saveSecuredSession({ secretId: SID_B, serverId: "s2", serviceRef: "r2", startedAt: 200 });
    expect(ss.listSecuredSessions().map((s: { secretId: string }) => s.secretId)).toEqual([SID_B, SID_A]);
  });

  it("removes one + clears all", async () => {
    const ss = await loadSecuredSessions();
    ss.saveSecuredSession({ secretId: SID_A, serverId: "s1", serviceRef: "r1" });
    ss.saveSecuredSession({ secretId: SID_B, serverId: "s2", serviceRef: "r2" });
    ss.removeSecuredSession(SID_A);
    expect(ss.listSecuredSessions().map((s: { secretId: string }) => s.secretId)).toEqual([SID_B]);
    ss.clearSecuredSessions();
    expect(ss.listSecuredSessions()).toEqual([]);
  });

  it("rejects a malformed session (bad secretId)", async () => {
    const ss = await loadSecuredSessions();
    expect(() => ss.saveSecuredSession({ secretId: "nothex", serverId: "s", serviceRef: "r" })).toThrow();
  });

  it("tolerates corrupt / non-array localStorage (returns [])", async () => {
    const ss = await loadSecuredSessions();
    globalThis.localStorage!.setItem("flagship.securedSessions.v1", "{not json");
    expect(ss.listSecuredSessions()).toEqual([]);
    globalThis.localStorage!.setItem("flagship.securedSessions.v1", JSON.stringify({ a: 1 }));
    expect(ss.listSecuredSessions()).toEqual([]);
  });
});

describe("securedSessions status debounce", () => {
  it("allows the first check, blocks within 60s, allows again after", async () => {
    const ss = await loadSecuredSessions();
    expect(ss.STATUS_DEBOUNCE_MS).toBe(60_000);
    expect(ss.canCheckStatus(undefined, 1_000_000)).toBe(true); // never checked
    expect(ss.canCheckStatus(1_000_000, 1_000_000)).toBe(false); // same instant
    expect(ss.canCheckStatus(1_000_000, 1_059_000)).toBe(false); // 59s later
    expect(ss.canCheckStatus(1_000_000, 1_060_000)).toBe(true); // exactly 60s
    expect(ss.canCheckStatus(1_000_000, 1_120_000)).toBe(true); // well after
  });
});
