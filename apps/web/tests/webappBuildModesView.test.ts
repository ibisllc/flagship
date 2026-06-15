import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError, buildEntryError } from "../public/webapp/lib/api.js";

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("webapp build-modes views", () => {
  it("the source chooser registers a view and fans out to all modes", async () => {
    const body = await asset("/webapp/views/build-source.js");
    expect(body).toContain('registerView("view-build-source")');
    expect(body).toContain("export function initBuildSourceView");
    expect(body).toContain("export function enterBuildSource");
    expect(body).toContain("enterVibeCode");
    expect(body).toContain("enterBuildGit");
    expect(body).toContain("enterBuildMcp");
    expect(body).toContain("enterBuildJournal");
    // feat/marketplace: the tile opens the live marketplace catalog.
    expect(body).toContain("enterMarketplace");
  });

  it("scratch routes through the AI-key step before opening the chat", async () => {
    const body = await asset("/webapp/views/build-source.js");
    expect(body).toContain("enterBuildKey");
    // The chosen credential is handed onward to the vibe-code chat.
    expect(body).toContain("enterVibeCode({ credential })");
  });

  it("git view checks fitness then deploys via /api/build", async () => {
    const body = await asset("/webapp/views/build-git.js");
    expect(body).toContain('registerView("view-build-git")');
    expect(body).toContain("/api/build/git");
    expect(body).toContain("/deploy");
    expect(body).toMatch(/Flagship-ready/);
    expect(body).toMatch(/Build with AI instead/);
  });

  it("the not-fit path runs the adapt endpoint and falls back to scratch on 503", async () => {
    const body = await asset("/webapp/views/build-git.js");
    // The AI button now calls the adapt endpoint (not a direct route to scratch).
    expect(body).toContain("/adapt");
    expect(body).toMatch(/adapting/i);
    // On success it reveals an Install (deploy) button reusing the deploy call.
    expect(body).toMatch(/Adapted/);
    expect(body).toContain("build-git-deploy");
    // 503 → friendly toast + fall back to the scratch vibe flow.
    expect(body).toContain("e.status === 503");
    expect(body).toContain("enterVibeCode");
    expect(body).toMatch(/starting from scratch instead/i);
    // Parity with iOS/Android: the from-scratch fall-back routes through the
    // AI-key step FIRST (it still drives the box's model), then opens the chat
    // seeded with the chosen credential — not a bare enterVibeCode().
    expect(body).toContain("enterBuildKey");
    expect(body).toContain("onChosen: (credential) => enterVibeCode({ credential })");
  });

  it("git-adapt confirms an AI key first and sends it as credential", async () => {
    const body = await asset("/webapp/views/build-git.js");
    // The not-fit AI button routes through the reusable key step…
    expect(body).toContain("enterBuildKey");
    // …and the adapt request carries the in-memory credential.
    expect(body).toContain("adaptCredential");
    expect(body).toContain("{ credential: adaptCredential }");
  });

  it("mcp view mints a connection and shows the key + IDE config", async () => {
    const body = await asset("/webapp/views/build-mcp.js");
    expect(body).toContain('registerView("view-build-mcp")');
    expect(body).toContain("/api/build/mcp");
    expect(body).toContain("/mcp/rotate");
    expect(body).toContain("ideConfig");
    expect(body).toMatch(/no model key on the box/i);
  });

  it("mcp view surfaces value-free env requests and reassures about the value", async () => {
    const body = await asset("/webapp/views/build-mcp.js");
    expect(body).toContain("/env-requests");
    expect(body).toContain("mcp-env-requests");
    // Reassurance: the IDE/AI never sees the value; the owner sets it on the box.
    expect(body).toMatch(/never see/i);
    expect(body).toMatch(/Configure environment/);
    // No value-carrying field is ever read/rendered.
    expect(body).not.toMatch(/\.value\b/);
  });

  it("journal viewer reads the shared journal", async () => {
    const body = await asset("/webapp/views/build-journal.js");
    expect(body).toContain('registerView("view-build-journal")');
    expect(body).toContain("/api/build/sessions");
    expect(body).toContain("/journal");
    expect(body).toContain("export async function enterBuildJournal");
  });

  it("index.html has all four build-mode sections", async () => {
    const body = await asset("/webapp/index.html");
    for (const id of ["view-build-source", "view-build-git", "view-build-mcp", "view-build-journal"]) {
      expect(body).toContain(`id="${id}"`);
    }
    // The create-a-service entry now opens the chooser.
    expect(body).toContain('id="build-src-scratch"');
    expect(body).toContain('id="build-src-mcp"');
  });

  it("a 404 on a build ENTRY call reads as platform-absent, not generic", () => {
    const msg = buildEntryError(new ScreensError("not found", 404));
    expect(msg).toMatch(/isn't set up to build services yet/i);
    expect(msg).not.toMatch(/moved or been removed/i);
    expect(msg).not.toMatch(/\b404\b/);
    // Non-404 errors fall through to the normal message.
    expect(buildEntryError(new ScreensError("boom", 500))).toBe("boom");
  });

  it("git/mcp/journal entry views use the platform-absent mapper", async () => {
    for (const view of ["build-git.js", "build-mcp.js", "build-journal.js"]) {
      const body = await asset(`/webapp/views/${view}`);
      expect(body).toContain("buildEntryError");
    }
  });

  it("app.js wires the chooser as the create-service entry", async () => {
    const body = await asset("/webapp/app.js");
    expect(body).toContain("initBuildSourceView");
    expect(body).toContain('wire("services-list-open-vibe-code", enterBuildSource)');
    expect(body).toContain('"view-build-source": "apps"');
  });
});
