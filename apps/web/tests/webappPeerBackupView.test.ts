import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp /views/peer-backup.js — participation view", () => {
  it("is reachable as a static asset and registers a view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-peer-backup")');
  });

  it("hits the peer-backup BFF endpoints", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/screens/peer-backup/status");
    expect(r.body).toContain("/api/screens/peer-backup/toggle");
  });

  it("exports the standard view contract", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function initPeerBackupView");
    expect(r.body).toContain("export async function enterPeerBackup");
    expect(r.body).toContain("export async function renderPeerBackup");
  });

  it("speaks the empty state ('not in the pool — enable to get started')", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/not in the peer-backup pool/);
    expect(r.body).toMatch(/enable to get started/);
  });

  it("renders shard health + repair status sections", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Shard health");
    expect(r.body).toContain("Repair status");
    expect(r.body).toContain("Peers backing you up");
    expect(r.body).toContain("Peers you back up");
  });
});
