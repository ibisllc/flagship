import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("marketing surface — modern look + shared stylesheet", () => {
  it("/site.css exists and exports the shared dark+green palette", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/site.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("--accent: #4ad295");
    expect(r.body).toContain(".topbar");
    expect(r.body).toContain(".cta");
  });

  for (const path of ["/", "/login.html", "/security.html", "/security/report.html"]) {
    it(`${path} links the shared /site.css`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('href="/site.css"');
    });
  }

  for (const path of ["/", "/login.html", "/security.html", "/security/report.html"]) {
    it(`${path} carries a topbar with the brand mark`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.body).toContain('class="topbar"');
      expect(r.body).toContain("Flagship");
    });
  }

  it("the landing page advertises the three device families and the data-layer story", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain("phone");
    expect(r.body).toContain("Postgres + MinIO + Redis");
    expect(r.body).toContain("Three device families");
  });

  it("the security page acknowledges the webapp's weaker key storage", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security.html" });
    expect(r.body).toContain("Three device families");
    expect(r.body).toContain("software-only");
  });

  it("the report form lists components added this week (data layer, webapp, deck)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security/report.html" });
    expect(r.body).toContain("Data layer");
    expect(r.body).toContain("Webapp");
    expect(r.body).toContain("Deck");
  });

  it("login page CTA continues to the deck (not the legacy /app.html path)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/login.html" });
    expect(r.body).toContain('/deck/?session=');
    expect(r.body).not.toMatch(/href="\/app\.html\?session/);
  });
});
