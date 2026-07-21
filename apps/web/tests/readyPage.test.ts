import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/ready/ — post-order recipe landing", () => {
  it("serves /ready/index.html with copy+download recipe + Builder steps", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);
    // Both ways to hand off the recipe (copy preferred, download fallback).
    expect(r.body).toContain('id="copyRecipe"');
    expect(r.body).toContain('id="downloadRecipe"');
    // OS-detected installer surfaces.
    expect(r.body).toContain('id="installerPrimary"');
    expect(r.body).toContain('id="installerOthers"');
    // The Builder reuses the install-once message.
    expect(r.body).toContain("only install it");
    // The no-recipe fallback exists for direct navigation.
    expect(r.body).toContain('id="noRecipe"');
    expect(r.body).toContain('src="/ready/ready.js"');
  });

  it("tells one story: copy/download the recipe + get the builder — no ISO/Alpine/Advanced framing", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);

    // The recipe + Builder affordances are the whole page.
    expect(r.body).toContain('id="copyRecipe"');
    expect(r.body).toContain('id="downloadRecipe"');
    expect(r.body).toContain('id="installerPrimary"');
    expect(r.body).toContain('id="installerOthers"');

    // The builder fetches the base OS — the user never picks/downloads an image.
    expect(r.body).toContain("fetches the right base OS");

    // No Advanced "bring your own ISO" disclosure, no OS-name framing on the page.
    expect(r.body).not.toContain("<details");
    expect(r.body).not.toContain("advanced-disclosure");
    expect(r.body).not.toMatch(/Advanced mode/i);
    expect(r.body).not.toMatch(/\bAlpine\b/);
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
    expect(r.body).not.toContain("/download/windows");
    expect(r.body).not.toContain("/download/linux");
    expect(r.body).toContain("Windows");
    expect(r.body).toContain("Linux");
    expect(r.body).toContain("Coming soon");
    // The curtailed website-built-image path is gone from the client too.
    expect(r.body).not.toContain("/api/personalize-iso");
    expect(r.body).not.toContain("downloadAlpineIso");
  });
});
