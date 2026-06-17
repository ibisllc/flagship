import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("marketing surface — design system v2 (dark+teal)", () => {
  it("/tokens.css exposes the v2 design-system custom properties", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/tokens.css" });
    expect(r.statusCode).toBe(200);
    // v2 canonical teal accent + legacy --accent / --primary aliases.
    expect(r.body).toMatch(/--teal:\s+#14B8A6/);
    expect(r.body).toContain("--accent");
    expect(r.body).toContain("--primary");
    expect(r.body).toContain("--font-sans");
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
    expect(r.body).toContain(".colophon");
  });

  for (const path of ["/how-it-works.html"]) {
    it(`${path} loads the design tokens + components stylesheets`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      // Either direct load or via /site.css which @imports them.
      expect(r.body).toMatch(/href="\/(tokens|site)\.css"/);
    });
  }

  for (const path of ["/"]) {
    it(`${path} carries the Flagship brand in the chrome`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      // Pages may use either the new `.nav` chrome or the legacy
      // `.topbar` (which v2 components.css restyles into the new look).
      expect(r.body).toMatch(/class="(nav|topbar)"/);
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
    expect(r.body).toContain("github.com/ibisllc/flagship");
  });

  it("the landing page leads with the new positioning headline + install CTAs", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain("Your stuff");
    expect(r.body).toContain("hardware");
    expect(r.body).toContain("real green padlock");
    // v2 primary CTAs replace "Get a build code".
    expect(r.body).toContain("Install for iOS");
    expect(r.body).toContain("Install for Android");
  });

  it("the landing page no longer advertises /build/ or /pricing", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).not.toMatch(/href="\/build\/?"/);
    expect(r.body).not.toMatch(/href="\/pricing"/);
  });

  it("/how-it-works.html is now a redirect stub pointing at /docs#how-it-works", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/how-it-works.html" });
    // The standalone page was folded into /docs; the static file is a thin
    // client-side redirect (meta-refresh + location.replace).
    expect(r.body).toContain("/docs#how-it-works");
    expect(r.body).toMatch(/location\.replace|http-equiv="refresh"/);
  });

  it("the four-step flow now lives in /docs (folded from how-it-works)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/docs/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Pair");
    expect(r.body).toMatch(/scan|QR|deliver/i);
    expect(r.body).toMatch(/boot|unlock/i);
  });

  it("the standalone /how-to.html explainer is deleted (no longer a served page)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/how-to.html" });
    // Fastify static returns 404 for the removed file. (In production the
    // Worker 302s /how-to + /how-to.html → /docs before the asset binding;
    // that redirect is covered in apps/com route tests.)
    expect(r.statusCode).toBe(404);
  });

  it("/docs folds in the 'assemble your server' section with centralized ISO recs", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/docs/index.html" });
    expect(r.statusCode).toBe(200);
    // Deep-link anchors preserved from the old how-to.html page.
    expect(r.body).toContain('id="certificate"');
    expect(r.body).toContain('id="recommended-linux"');
    expect(r.body).toContain('id="booting-process"');
    // The top-level folded section + its TOC entry.
    expect(r.body).toContain('id="burn"');
    // Debian 13 netinst is the recommended image, centralized here.
    expect(r.body).toContain(
      "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.5.0-amd64-netinst.iso",
    );
    expect(r.body).toMatch(/Debian 13/);
  });

  it("/pricing.html is retired (Worker SPA-fallback returns the homepage)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/pricing.html" });
    // Acceptable: either a true 404 or a graceful 200 that serves the
    // landing as fallback. We only assert it isn't a dedicated pricing
    // page anymore (no "Tiny / Standard / Pro" wording).
    expect(r.body).not.toMatch(/<h1[^>]*>\s*Pricing/);
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
    it(`${path} loads the design tokens + has the Flagship chrome`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatch(/href="\/(tokens|site)\.css"/);
      expect(r.body).toMatch(/class="(nav|topbar)"/);
      expect(r.body).toContain("Flagship");
    });
  }

  it("faq covers the major topic groups", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/faq.html" });
    const groups = ["Setup", "Privacy", "Services", "money", "company"];
    const hits = groups.filter((g) => r.body.toLowerCase().includes(g.toLowerCase()));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("privacy + terms include real contact addresses", async () => {
    const app = buildServer();
    const priv = await app.inject({ method: "GET", url: "/privacy.html" });
    const terms = await app.inject({ method: "GET", url: "/terms.html" });
    expect(priv.body).toContain("@flagship");
    expect(terms.body).toContain("@flagship");
  });

  it("disambiguation page is a static fallback (no client-side resolver call)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/disambiguate.html" });
    expect(r.body).toContain("No service here");
    expect(r.body).not.toContain("/api/aliases/");
  });
});
