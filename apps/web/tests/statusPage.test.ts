import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/status/ page", () => {
  it("serves the status dashboard HTML", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/status/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Flagship — status");
    expect(r.body).toContain("flagship.services");
  });

  it("includes a 'Configured infrastructure' section that consumes /api/services/endpoints", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/status/" });
    // The card and the data-loading script must both be in place; without
    // them, infra drift wouldn't be visible from the dashboard.
    expect(r.body).toContain("Configured infrastructure");
    expect(r.body).toContain("/api/services/endpoints");
    expect(r.body).toContain('id="tunnelHub"');
    expect(r.body).toContain('id="passthroughIPv4"');
    expect(r.body).toContain('id="passthroughIPv6"');
  });

  it("polls the existing /api/_status/probe for live health (unchanged)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/status/" });
    expect(r.body).toContain("/api/_status/probe");
  });
});
