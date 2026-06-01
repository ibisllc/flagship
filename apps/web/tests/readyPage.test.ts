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
    // OS-detected installer surfaces + the "install once" message.
    expect(r.body).toContain('id="installerPrimary"');
    expect(r.body).toContain('id="installerOthers"');
    expect(r.body).toContain("only install the Assembler once");
    // The no-recipe fallback exists for direct navigation.
    expect(r.body).toContain('id="noRecipe"');
    expect(r.body).toContain('src="/ready/ready.js"');
    // The self-download image path still exists, now behind Advanced.
    expect(r.body).toContain('id="alpineCta"');
    expect(r.body).toContain('id="downloadIso"');
    expect(r.body).toContain("ready-to-flash");
  });

  it("makes the Assembler flow primary and tucks the self-download ISO into an Advanced disclosure", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);

    const detailsIdx = r.body.indexOf("<details");
    expect(detailsIdx).toBeGreaterThan(-1);

    // The recipe + Assembler affordances are now primary — outside the disclosure.
    expect(r.body.indexOf('id="copyRecipe"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="downloadRecipe"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="installerPrimary"')).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="installerOthers"')).toBeLessThan(detailsIdx);

    // The Advanced path is an explicit collapsible disclosure with the new copy.
    expect(r.body).toMatch(/<details[^>]*class="advanced-disclosure"/);
    expect(r.body).toContain("Advanced: download a ready-to-flash image yourself");

    // The self-download personalized-image path now lives inside the disclosure.
    const detailsBlock = r.body.slice(detailsIdx, r.body.indexOf("</details>"));
    expect(detailsBlock).toContain('id="alpineCta"');
    expect(detailsBlock).toContain('id="downloadIso"');
    expect(detailsBlock).toContain('id="isoStatus"');
  });

  it("serves /ready/ready.js wired to the QR hand-off key + on-brand installer links", async () => {
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
    // #12: the custom-ISO download POSTs the recipe to the personalize endpoint
    // via a streamed form submit (not an in-memory blob).
    expect(r.body).toContain("/api/personalize-iso");
    expect(r.body).toContain("downloadAlpineIso");
  });
});
