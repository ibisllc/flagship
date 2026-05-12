import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp /views/url-controller.js — URL multiplex view", () => {
  it("is reachable as a static asset and registers a view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/url-controller.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-url-controller")');
  });

  it("hits both url-controller BFF endpoints + the live-siblings list", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/url-controller.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/screens/url-controller/owned");
    expect(r.body).toContain("/api/screens/url-controller/claim");
    expect(r.body).toContain("/api/live_siblings/list");
  });

  it("exports the standard view contract (init + enter + render)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/url-controller.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function initUrlControllerView");
    expect(r.body).toContain("export async function enterUrlController");
    expect(r.body).toContain("export async function renderOwned");
    expect(r.body).toContain("export async function renderLiveSiblings");
  });

  it("speaks the empty state for both lists", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/url-controller.js" });
    expect(r.statusCode).toBe(200);
    // Owned list empty copy
    expect(r.body).toMatch(/no URLs claimed yet/);
    // Live siblings empty copy
    expect(r.body).toMatch(/no live siblings/);
  });
});
