import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp marketplace + vibe-code — scan-grade pill + publish flow (task #28)", () => {
  it("marketplace.js exports scanGradePill and renders the grade in listing cards", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/marketplace.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function scanGradePill");
    // Listing rendering must consume the pill — pattern-match the call site
    // so we catch the case where the export exists but no listing uses it.
    expect(r.body).toContain("scanGradePill(l.scan_grade");
  });

  it("scanGradePill recognises A/B/C/D/F + ungraded", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/marketplace.js" });
    expect(r.statusCode).toBe(200);
    // All five grades + ungraded fall-through must be present.
    for (const grade of ["A:", "B:", "C:", "D:", "F:"]) {
      expect(r.body).toContain(grade);
    }
    expect(r.body).toMatch(/ungraded/);
    // Tooltip text — the user must learn what each grade means.
    expect(r.body).toMatch(/passed every scanner check/);
  });

  it("vibe-code.js exposes a Publish-to-marketplace flow on the deployed success state", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/vibe-code.js" });
    expect(r.statusCode).toBe(200);
    // Button text + endpoint + the call wrapper.
    expect(r.body).toContain("Publish this app");
    expect(r.body).toContain("/api/screens/marketplace/publish");
    expect(r.body).toContain("publishToMarketplace");
  });
});
