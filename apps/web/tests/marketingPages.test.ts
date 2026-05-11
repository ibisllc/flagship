import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("marketing surface — design system v2", () => {
  it("/tokens.css exposes the design-system custom properties", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/tokens.css" });
    expect(r.statusCode).toBe(200);
    // Unified palette: signal amber accent (replaces the prior blue), exposed
    // through both the new `--accent` token and the legacy `--primary` alias.
    expect(r.body).toMatch(/--accent:\s+#B26016/);
    expect(r.body).toContain("--primary");
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

  it("/blog/ ships a landing page that links the RSS feed", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/blog/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('href="/blog/rss.xml"');
    expect(r.body).toContain("Flagship");
  });

  it("/blog/rss.xml is well-formed RSS 2.0 with the canonical channel link", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/blog/rss.xml" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<?xml version="1.0"');
    expect(r.body).toContain('<rss version="2.0"');
    expect(r.body).toContain("<title>Flagship blog</title>");
    expect(r.body).toContain("<link>https://flagshipserver.com/blog/</link>");
  });

  it("/open-source.html lists the BUSL-1.1 license + 2030 Change Date", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/open-source.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("BUSL-1.1");
    expect(r.body).toContain("2030");
    expect(r.body).toContain("Apache 2.0");
    // Names the canonical repo so contributors know where to file PRs.
    expect(r.body).toContain("github.com/flagshipserver/flagship");
  });

  it("the landing page leads with the new positioning headline", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    // The hero now wraps the brand promise across <br> tags + an <em>; the
    // contiguous substring is gone but the key words still anchor the page.
    expect(r.body).toContain("Your stuff");
    expect(r.body).toContain("your");
    expect(r.body).toContain("hardware");
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

  for (const path of ["/faq.html", "/privacy.html", "/terms.html", "/help.html", "/docs/index.html", "/disambiguate.html"]) {
    it(`${path} loads the design tokens + has the Flagship nav`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('href="/tokens.css"');
      expect(r.body).toContain('class="nav"');
      expect(r.body).toContain("Flagship");
    });
  }

  it("faq covers the major topic groups", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/faq.html" });
    // The FAQ should organize into sections; we check for at least 3 of the 5
    const groups = ["Setup", "Privacy", "Apps", "money", "company"];
    const hits = groups.filter((g) => r.body.toLowerCase().includes(g.toLowerCase()));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("privacy + terms include real contact addresses", async () => {
    const app = buildServer();
    const priv = await app.inject({ method: "GET", url: "/privacy.html" });
    const terms = await app.inject({ method: "GET", url: "/terms.html" });
    expect(priv.body).toContain("@flagship.services");
    expect(terms.body).toContain("@flagship.services");
  });

  it("disambiguation page is a static fallback (no client-side resolver call)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/disambiguate.html" });
    expect(r.body).toContain("No app here");
    expect(r.body).not.toContain("/api/aliases/");
  });
});
