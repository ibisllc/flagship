import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

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
    // Marketplace degrades gracefully (no marketplace code on this branch).
    expect(body).toMatch(/marketplace is coming soon/i);
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

  it("app.js wires the chooser as the create-service entry", async () => {
    const body = await asset("/webapp/app.js");
    expect(body).toContain("initBuildSourceView");
    expect(body).toContain('wire("services-list-open-vibe-code", enterBuildSource)');
    expect(body).toContain('"view-build-source": "apps"');
  });
});
