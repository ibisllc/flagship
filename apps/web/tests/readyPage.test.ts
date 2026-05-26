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
    // #12: the recommended default — download a ready-to-flash custom ISO.
    expect(r.body).toContain('id="alpineCta"');
    expect(r.body).toContain('id="downloadIso"');
    expect(r.body).toContain("ready-to-flash");
  });

  it("tucks the BYO-ISO / Assembler path into an Advanced options disclosure, ISO stays primary", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);

    // The recommended Alpine custom-ISO download stays primary + visible
    // (the button is NOT inside the disclosure).
    const ctaIdx = r.body.indexOf('id="alpineCta"');
    const detailsIdx = r.body.indexOf("<details");
    expect(ctaIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeLessThan(detailsIdx);
    expect(r.body.indexOf('id="downloadIso"')).toBeLessThan(detailsIdx);

    // The BYO path is an explicit collapsible disclosure with the agreed copy.
    expect(r.body).toMatch(/<details[^>]*class="advanced-disclosure"/);
    expect(r.body).toContain("Advanced options: Bring your own Linux");

    // The recipe + Assembler affordances now live inside the disclosure.
    const detailsBlock = r.body.slice(detailsIdx, r.body.indexOf("</details>"));
    expect(detailsBlock).toContain('id="copyRecipe"');
    expect(detailsBlock).toContain('id="downloadRecipe"');
    expect(detailsBlock).toContain('id="installerPrimary"');
    expect(detailsBlock).toContain('id="installerOthers"');
    expect(detailsBlock).toContain("only install the Assembler once");
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
