// Resume build sessions (webapp parity of the iOS change): the box's live
// vibe-code registry feeds the chooser's active count and the build list.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadSessions = () => load("lib/vibeSessions.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("vibe-code sessions helpers", () => {
  it("decodes the registry and keeps only well-formed entries", async () => {
    const { decodeSessions } = await loadSessions();
    const out = decodeSessions({
      sessions: [
        { sessionId: "s1", startedAt: 10, status: "streaming", serviceId: "alice--todo", url: "https://x", extra: 1 },
        { sessionId: "s2", startedAt: 20, status: "deployed" },
        { status: "streaming" },
        null,
      ],
    });
    expect(out).toEqual([
      { sessionId: "s1", startedAt: 10, status: "streaming", serviceId: "alice--todo", url: "https://x" },
      { sessionId: "s2", startedAt: 20, status: "deployed", serviceId: null, url: null },
    ]);
    expect(decodeSessions(undefined)).toEqual([]);
  });

  it("counts only sessions that are working or waiting on the owner", async () => {
    const { isActiveSession, countActiveSessions } = await loadSessions();
    for (const status of ["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"]) {
      expect(isActiveSession({ status })).toBe(true);
    }
    for (const status of ["deployed", "failed", "cancelled", "weird"]) {
      expect(isActiveSession({ status })).toBe(false);
    }
    expect(countActiveSessions([{ status: "streaming" }, { status: "deployed" }, { status: "deploying" }])).toBe(2);
  });

  it("labels each status in plain words", async () => {
    const { sessionStatusLabel } = await loadSessions();
    expect(sessionStatusLabel("streaming")).toBe("AI is working");
    expect(sessionStatusLabel("awaiting-tool-response")).toBe("Waiting for you");
    expect(sessionStatusLabel("ready-to-deploy")).toBe("Ready to deploy");
    expect(sessionStatusLabel("deploying")).toBe("Deploying");
    expect(sessionStatusLabel("deployed")).toBe("Deployed");
    expect(sessionStatusLabel("cancelled")).toBe("Cancelled");
    expect(sessionStatusLabel("failed")).toBe("Stopped");
  });

  it("names a session from itself, then its journal, then a fallback", async () => {
    const { sessionTitle } = await loadSessions();
    const builds = [{ buildId: "s2", serviceId: "alice--notes" }];
    expect(sessionTitle({ sessionId: "s1", serviceId: "alice--todo" }, builds)).toBe("alice--todo");
    expect(sessionTitle({ sessionId: "s2", serviceId: null }, builds)).toBe("alice--notes");
    expect(sessionTitle({ sessionId: "s3", serviceId: null }, builds)).toBe("AI build");
  });

  it("lists past builds only when the box no longer holds their session", async () => {
    const { endedBuilds, sortSessionsNewestFirst } = await loadSessions();
    const builds = [{ buildId: "s1" }, { buildId: "g1" }];
    expect(endedBuilds(builds, [{ sessionId: "s1" }])).toEqual([{ buildId: "g1" }]);
    expect(sortSessionsNewestFirst([{ startedAt: 1 }, { startedAt: 3 }, { startedAt: 2 }]).map((s: { startedAt: number }) => s.startedAt))
      .toEqual([3, 2, 1]);
  });

  it("fetches with the paired session and reads any failure as no sessions", async () => {
    const { fetchVibeSessions } = await loadSessions();
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [{ sessionId: "s1", startedAt: 1, status: "streaming" }] }) }));
    const got = await fetchVibeSessions({ baseUrl: "https://home.alice.flagship.services/", token: "tok", fetchImpl: ok });
    expect(got).toHaveLength(1);
    expect(ok).toHaveBeenCalledWith("https://home.alice.flagship.services/api/llm/sessions", {
      headers: { "x-flagship-session": "tok" },
    });
    expect(await fetchVibeSessions({ baseUrl: "https://b", token: "t", fetchImpl: async () => ({ ok: false }) })).toEqual([]);
    expect(await fetchVibeSessions({ baseUrl: "https://b", token: "t", fetchImpl: async () => { throw new Error("down"); } })).toEqual([]);
    expect(await fetchVibeSessions({ baseUrl: null, token: "t" })).toEqual([]);
  });
});

describe("build chooser and build sessions screens", () => {
  it("the chooser puts resuming first and moves the explanations into help", async () => {
    const html = await asset("/webapp/index.html");
    const section = html.slice(html.indexOf('id="view-build-source"'), html.indexOf('id="view-build-key"'));
    expect(section).not.toContain("How do you want to build it?");
    expect(section).toContain("Resume or view past builds");
    expect(section.indexOf("Resume or view past builds")).toBeLessThan(section.indexOf("build-src-scratch"));
    expect(section).toContain("New build");
    expect(section).toContain('id="build-source-help"');
    const js = await asset("/webapp/views/build-source.js");
    expect(js).toContain("How building works");
    expect(js).toContain("A build stays open until your server restarts.");
    expect(js).toContain("countActiveSessions");
  });

  it("the build list is titled Build sessions and reopens open sessions", async () => {
    const html = await asset("/webapp/index.html");
    expect(html).toContain("<h2>Build sessions</h2>");
    const js = await asset("/webapp/views/build-journal.js");
    expect(js).toContain("Open on your server");
    expect(js).toContain("Past builds");
    expect(js).toContain("openVibeCodeSession");
  });

  it("Back from a session lands on the build chooser", async () => {
    const vibe = await asset("/webapp/views/vibe-code.js");
    expect(vibe).toMatch(/vibe-code-back[\s\S]{0,80}show\("view-build-source"\)/);
    const chat = await asset("/webapp/views/vibecode-chat.js");
    expect(chat).toMatch(/vibecode-chat-back[\s\S]{0,80}show\("view-build-source"\)/);
  });
});
