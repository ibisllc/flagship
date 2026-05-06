import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("marketing surface — design system v2", () => {
  it("/tokens.css exposes the design-system custom properties", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/tokens.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/--primary:\s+#3B5BFF/);
    expect(r.body).toContain("--font-heading");
    expect(r.body).toContain("--space-4");
    expect(r.body).toContain("--radius-md");
  });

  it("/components.css ships the primitive classes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/components.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(".btn");
    expect(r.body).toContain(".card");
    expect(r.body).toContain(".pill");
    expect(r.body).toContain(".nav");
    expect(r.body).toContain(".footer");
  });

  for (const path of ["/", "/how-it-works.html", "/pricing.html", "/marketplace/"]) {
    it(`${path} loads the new tokens + components stylesheets`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('href="/tokens.css"');
      expect(r.body).toContain('href="/components.css"');
    });
  }

  for (const path of ["/", "/how-it-works.html", "/pricing.html", "/marketplace/"]) {
    it(`${path} carries the Flagship brand in the nav`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.body).toContain('class="nav"');
      expect(r.body).toContain('class="nav-brand"');
      expect(r.body).toContain("Flagship");
    });
  }

  it("the landing page leads with the new positioning headline", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain("Your stuff, on your hardware");
    expect(r.body).toContain("real green padlock");
    expect(r.body).toContain("Get a build code");
  });

  it("how-it-works page covers the five stages", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/how-it-works.html" });
    expect(r.body).toContain("Pair your phone");
    expect(r.body).toContain("Mint a build code");
    expect(r.body).toContain("Every-boot unlock");
  });

  it("pricing page lists hardware tiers + subscription tiers + add-ons", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/pricing.html" });
    expect(r.body).toContain("Tiny");
    expect(r.body).toContain("Standard");
    expect(r.body).toContain("Pro");
    expect(r.body).toContain("Hobby");
    expect(r.body).toContain("Maker");
    expect(r.body).toContain("Security scan");
    expect(r.body).toContain("Featured slot");
  });

  it("marketplace page renders sidebar categories + listing grid", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/marketplace/" });
    expect(r.body).toContain("Categories");
    expect(r.body).toContain("Productivity");
    expect(r.body).toContain('class="card listing"');
  });

  it("the report form continues to live at /security/report.html", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security/report.html" });
    expect(r.statusCode).toBe(200);
  });

  it("login page CTA continues to the deck (not the legacy /app.html path)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/login.html" });
    expect(r.body).toContain('/deck/?session=');
    expect(r.body).not.toMatch(/href="\/app\.html\?session/);
  });
});
