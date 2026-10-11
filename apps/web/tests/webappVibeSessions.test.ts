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
      { sessionId: "s1", startedAt: 10, status: "streaming", serviceId: "alice--todo", url: "https://x", name: null, visibility: null },
      { sessionId: "s2", startedAt: 20, status: "deployed", serviceId: null, url: null, name: null, visibility: null },
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

  it("names a session from itself, then its journal, then its service, then a fallback", async () => {
    const { sessionTitle } = await loadSessions();
    const builds = [{ buildId: "s2", serviceId: "alice--notes" }, { buildId: "s5", name: "garden" }];
    expect(sessionTitle({ sessionId: "s1", name: "todo", serviceId: null }, builds)).toBe("todo");
    expect(sessionTitle({ sessionId: "s2", serviceId: null }, builds)).toBe("notes");
    expect(sessionTitle({ sessionId: "s5", serviceId: null }, builds)).toBe("garden");
    expect(sessionTitle({ sessionId: "s4", serviceId: "alice--todo" }, builds)).toBe("todo");
    expect(sessionTitle({ sessionId: "s3", serviceId: null }, builds)).toBe("Unnamed build");
  });

  it("decodes the name and visibility the box now keeps", async () => {
    const { decodeSessions } = await loadSessions();
    const [s] = decodeSessions({ sessions: [{ sessionId: "a", startedAt: 1, status: "streaming", name: "garden", visibility: "just-me" }] });
    expect(s.name).toBe("garden");
    expect(s.visibility).toBe("just-me");
  });

  it("past builds show their name and how they were made", async () => {
    const { buildDisplayName, buildMethodLabel, pastBuildSubtitle } = await loadSessions();
    expect(buildDisplayName({ name: "garden", serviceId: "alice--garden" })).toBe("garden");
    expect(buildDisplayName({ serviceId: "alice--notes" })).toBe("notes");
    expect(buildDisplayName({ mode: "mcp" })).toBe("Unnamed build");
    expect(buildMethodLabel("scratch")).toBe("AI chat");
    expect(buildMethodLabel("git")).toBe("From Git");
    expect(buildMethodLabel("mcp")).toBe("From your IDE");
    expect(pastBuildSubtitle({ entryCount: 3 }, "today")).toBe("Started today · 3 steps");
    expect(pastBuildSubtitle({ entryCount: 1 }, "today")).toBe("Started today · 1 step");
  });

  it("only undeployed sessions offer Discard, and the warning names the freed name", async () => {
    const { canDiscard, discardMessage } = await loadSessions();
    expect(canDiscard({ status: "failed" })).toBe(true);
    expect(canDiscard({ status: "streaming" })).toBe(true);
    expect(canDiscard({ status: "deployed" })).toBe(false);
    expect(discardMessage({ name: "garden" })).toBe(
      'This stops the AI and deletes what it has written on your server. Its name, "garden", becomes free again.',
    );
    expect(discardMessage({ name: null })).toBe("This stops the AI and deletes what it has written on your server.");
  });

  it("discard posts to the box and throws the box's reason on failure", async () => {
    const { discardSession } = await loadSessions();
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await discardSession({ baseUrl: "https://home.alice.flagship.services/", token: "tok", sessionId: "s 1", fetchImpl: ok });
    expect(ok).toHaveBeenCalledWith("https://home.alice.flagship.services/api/llm/sessions/s%201/discard", {
      method: "POST",
      headers: { "x-flagship-session": "tok", "content-type": "application/json" },
      body: "{}",
    });
    await expect(
      discardSession({ baseUrl: "https://b", token: "t", sessionId: "x", fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: "session not found" }) }) }),
    ).rejects.toThrow("session not found");
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
    expect(js).toContain("Discard…");
    expect(js).toContain('okLabel: "Discard build"');
    expect(js).toContain("buildDisplayName(b)");
    expect(js).not.toContain("last: ");
  });

  it("Back from a session lands on the build chooser", async () => {
    const vibe = await asset("/webapp/views/vibe-code.js");
    expect(vibe).toMatch(/vibe-code-back[\s\S]{0,120}show\("view-build-source"\)/);
    const chat = await asset("/webapp/views/vibecode-chat.js");
    expect(chat).toMatch(/vibecode-chat-back[\s\S]{0,80}show\("view-build-source"\)/);
  });
});

const loadNames = () => load("lib/vibeNames.js");

describe("unique build names on the describe form", () => {
  it("reads a start refused for a taken name as a conflict", async () => {
    const { conflictFromError } = await loadNames();
    const body = { ok: false, kind: "session", sessionId: "abcd", message: "x", error: "x" };
    expect(conflictFromError({ status: 409, body })).toEqual(body);
    expect(conflictFromError({ status: 502, body })).toBeNull();
    expect(conflictFromError({ status: 409, body: "not json" })).toBeNull();
    expect(conflictFromError({ status: 409, body: { ok: true, name: "x" } })).toBeNull();
    expect(conflictFromError(null)).toBeNull();
  });

  it("sends session clashes to the list and app clashes to another name", async () => {
    const { conflictMessage, nameWarning } = await loadNames();
    expect(conflictMessage({ ok: false, kind: "session", name: "garden" }, "garden")).toBe(
      'A build session already uses "garden". To use the name for a new build, open Build sessions and discard that one first.',
    );
    expect(conflictMessage({ ok: false, kind: "app", serviceId: "alice--notes" }, "notes")).toBe(
      'You already have a service called "notes". Pick another name.',
    );
    expect(nameWarning({ ok: false, kind: "invalid", message: "Use lowercase letters." }, "-x")).toBe("Use lowercase letters.");
    expect(nameWarning({ ok: true, name: "x" }, "x")).toBeNull();
    expect(nameWarning(null, "x")).toBeNull();
  });

  it("Build needs a name, a description and a valid name", async () => {
    const { canBuild, slugify } = await loadNames();
    expect(canBuild({ slug: "", prompt: "a thing", check: null, starting: false })).toBe(false);
    expect(canBuild({ slug: "garden", prompt: "  ", check: null, starting: false })).toBe(false);
    expect(canBuild({ slug: "garden", prompt: "a thing", check: { ok: false, kind: "invalid" }, starting: false })).toBe(false);
    expect(canBuild({ slug: "garden", prompt: "a thing", check: null, starting: true })).toBe(false);
    expect(canBuild({ slug: "garden", prompt: "a thing", check: { ok: false, kind: "app" }, starting: false })).toBe(true);
    expect(slugify("My Garden!")).toBe("mygarden");
  });

  it("access defaults to Invite only and explains itself", async () => {
    const { INVITE_ONLY, VISIBILITIES, visibilityExplanation, EXAMPLES } = await loadNames();
    expect(INVITE_ONLY).toBe("just-me");
    expect(VISIBILITIES.map((v: { label: string }) => v.label)).toEqual(["Invite only", "Anyone with the link"]);
    expect(visibilityExplanation("just-me")).toBe("Only you and the people you invite on Flagship can open it.");
    expect(visibilityExplanation("link")).toBe(
      "Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship.",
    );
    expect(EXAMPLES.map((e: { label: string }) => e.label)).toEqual(["Habit tracker", "Family wishlist", "Recipe jar", "Sleep journal"]);
  });

  it("asks the box and treats an old or unreachable box as free", async () => {
    const { checkName } = await loadNames();
    const taken = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, kind: "app", serviceId: "a--x" }) }));
    expect(await checkName({ baseUrl: "https://home.alice.flagship.services/", token: "tok", name: "x y", fetchImpl: taken })).toEqual({
      ok: false, kind: "app", serviceId: "a--x",
    });
    expect(taken).toHaveBeenCalledWith("https://home.alice.flagship.services/api/screens/vibe-code/name-check?name=x%20y", {
      headers: { "x-flagship-session": "tok" },
    });
    expect(await checkName({ baseUrl: "https://b", token: "t", name: "x", fetchImpl: async () => ({ ok: false, status: 404 }) })).toEqual({ ok: true });
    expect(await checkName({ baseUrl: "https://b", token: "t", name: "x", fetchImpl: async () => { throw new Error("down"); } })).toEqual({ ok: true });
  });

  it("the form puts the name first, starts with an empty description, and defaults to Invite only", async () => {
    const html = await asset("/webapp/index.html");
    const section = html.slice(html.indexOf('id="view-vibe-code"'), html.indexOf("</section>", html.indexOf('id="view-vibe-code"')));
    expect(section).toContain("<h2>New Service</h2>");
    expect(section.indexOf('id="vc-name"')).toBeLessThan(section.indexOf('id="vc-prompt"'));
    expect(section).toContain("What should it do?");
    expect(section).toContain("Who can open it");
    expect(section).toContain('<option value="just-me">Invite only</option>');
    expect(section).not.toContain("Just me");
    expect(section).toMatch(/<textarea id="vc-prompt"[^>]*><\/textarea>/);
    const js = await asset("/webapp/views/vibe-code.js");
    expect(js).toContain("CONFLICT_TITLE");
    expect(js).toContain('okLabel: "Open build sessions"');
    expect(js).toContain('cancelLabel: "Pick another name"');
    expect(js).toContain("enterBuildJournal()");
    expect(js).toContain("conflictFromError(e)");
    expect(js).toContain("inviteOnly === false");
    expect(js).toContain("This server couldn't make it invite only, so anyone with the link can open it.");
    expect(js).toContain('"Starting…"');
  });

  it("the shell precaches the session and name helpers", async () => {
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/vibeSessions.js"');
    expect(sw).toContain('"/lib/vibeNames.js"');
  });
});
