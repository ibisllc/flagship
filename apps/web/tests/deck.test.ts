import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/deck cast surface", () => {
  it("serves /deck/ index with Flagship Deck branding + the dashboard scaffolding", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/deck/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Flagship Deck");
    expect(r.body).toContain('id="servers-grid"');
    expect(r.body).toContain('src="/deck/deck.js"');
  });

  it("serves /deck/style.css and /deck/deck.js", async () => {
    const app = buildServer();
    const css = await app.inject({ method: "GET", url: "/deck/style.css" });
    expect(css.statusCode).toBe(200);
    expect(css.body).toContain("--accent");
    const js = await app.inject({ method: "GET", url: "/deck/deck.js" });
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain("/api/me/servers");
  });

  it("/app.html redirects to /deck/ (preserving any session= query param)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/app.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('http-equiv="refresh"');
    expect(r.body).toContain("/deck/");
  });

  it("the deck holds no master keys (sanity: no `umk` / `irk` references in the script)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/deck/deck.js" });
    expect(r.body).not.toMatch(/\bumk\b/i);
    expect(r.body).not.toMatch(/\birkprivate\b/i);
  });
});
