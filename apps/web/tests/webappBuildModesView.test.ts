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

  it("git view checks fitness then deploys via /api/build", async () => {
    const body = await asset("/webapp/views/build-git.js");
    expect(body).toContain('registerView("view-build-git")');
    expect(body).toContain("/api/build/git");
    expect(body).toContain("/deploy");
    expect(body).toMatch(/Flagship-ready/);
    expect(body).toMatch(/Build with AI instead/);
  });

  it("mcp view mints a connection and shows the key + IDE config", async () => {
    const body = await asset("/webapp/views/build-mcp.js");
    expect(body).toContain('registerView("view-build-mcp")');
    expect(body).toContain("/api/build/mcp");
    expect(body).toContain("/mcp/rotate");
    expect(body).toContain("ideConfig");
    expect(body).toMatch(/no model key on the box/i);
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
