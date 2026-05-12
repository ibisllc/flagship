import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * J.4 — webapp's post-recovery reattach-progress view.
 *
 * The webapp ships this module as a static asset; tests assert the
 * file is served, registers itself with the router, and polls the
 * documented BFF endpoint.
 */
describe("webapp /views/post-recovery.js — reattach progress view", () => {
  it("is reachable as a static asset and registers a view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/post-recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-post-recovery")');
    expect(r.body).toContain("enterPostRecovery");
    expect(r.body).toContain("initPostRecoveryView");
  });

  it("polls /api/screens/post-recovery/status", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/post-recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/screens/post-recovery/status");
    expect(r.body).toContain("screensFetch");
  });

  it("renders the 7-day undo summary on completion", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/post-recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("undo available until");
    expect(r.body).toContain("reattachedCount");
    expect(r.body).toContain("totalRewritten");
  });

  it("recovery.js exposes the reattach hook + the html surface declares the button", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("recovery-open-reattach");
    expect(r.body).toContain("post-recovery.js");

    const html = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('id="view-post-recovery"');
    expect(html.body).toContain('id="recovery-open-reattach"');
  });
});
