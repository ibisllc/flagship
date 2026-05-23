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
  });
});
