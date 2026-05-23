import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/ready/ — post-order recipe landing", () => {
  it("serves /ready/index.html with the recipe + Assembler next-steps", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/" });
    expect(r.statusCode).toBe(200);
    // The download + installer surfaces + the "install once" message.
    expect(r.body).toContain('id="downloadRecipe"');
    expect(r.body).toContain('id="installerActions"');
    expect(r.body).toContain("only install the Assembler once");
    // The no-recipe fallback exists for direct navigation.
    expect(r.body).toContain('id="noRecipe"');
    expect(r.body).toContain('src="/ready/ready.js"');
  });

  it("serves /ready/ready.js wired to the QR recipe hand-off key", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/ready/ready.js" });
    expect(r.statusCode).toBe(200);
    // Same sessionStorage key heroQr.js writes.
    expect(r.body).toContain("flagship:qr:recipe");
    expect(r.body).toContain("triggerDownload");
  });
});
