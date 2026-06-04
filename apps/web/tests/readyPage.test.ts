import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/ready/ — post-order recipe landing", () => {
  it("serves /ready/index.html with copy+download recipe + Assembler steps", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);
    // Both ways to hand off the recipe (copy preferred, download fallback).
    expect(r.body).toContain('id="copyRecipe"');
    expect(r.body).toContain('id="downloadRecipe"');
    // OS-detected installer surfaces.
    expect(r.body).toContain('id="installerPrimary"');
    expect(r.body).toContain('id="installerOthers"');
    // The recommended box is badged + reuses the Assembler install-once message.
    expect(r.body).toContain("Recommended");
    expect(r.body).toContain("only install it");
    // The no-recipe fallback exists for direct navigation.
    expect(r.body).toContain('id="noRecipe"');
    expect(r.body).toContain('src="/ready/ready.js"');
  });

  it("makes the Assembler flow primary and offers bring-your-own-ISO as an Advanced disclosure (no website-built image)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);

    const detailsIdx = r.body.indexOf("<details");
    expect(detailsIdx).toBeGreaterThan(-1);

    // The recipe + Assembler affordances are primary — outside the disclosure.
    expect(r.body.indexOf('id="copyRecipe"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="downloadRecipe"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="installerPrimary"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="installerOthers"')).toBeLessThan(detailsIdx);

    // The Advanced path is an explicit collapsible disclosure: bring your own ISO,
    // the Assembler bakes the same recipe in. No server-built/personalized image.
    expect(r.body).toMatch(/<details[^>]*class="advanced-disclosure"/);
    expect(r.body).toContain("Advanced: bring your own ISO");
    expect(r.body).toContain("remasters that image");

    // The curtailed website-built-image path is gone.
    expect(r.body).not.toContain('id="alpineCta"');
    expect(r.body).not.toContain('id="downloadIso"');
  });

  it("serves /ready/ready.js wired to the QR hand-off key + on-brand installer links, with no server-side ISO build", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/ready.js" });
    expect(r.statusCode).toBe(200);
    // Same sessionStorage key heroQr.js writes.
    expect(r.body).toContain("flagship:qr:recipe");
    // Copy + download paths.
    expect(r.body).toContain("copyRecipe");
    expect(r.body).toContain("downloadRecipe");
    expect(r.body).toContain("navigator.clipboard");
    // Installer links go through the on-brand /download/<os> redirect.
    expect(r.body).toContain("/download/mac");
    expect(r.body).toContain("/download/windows");
    expect(r.body).toContain("/download/linux");
    // The curtailed website-built-image path is gone from the client too.
    expect(r.body).not.toContain("/api/personalize-iso");
    expect(r.body).not.toContain("downloadAlpineIso");
  });
});
