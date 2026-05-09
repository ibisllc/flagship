import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp promo UI — no proxy quota fetching", () => {
  it("the webapp does NOT post to the deleted /api/llm-promo/quota", async () => {
    const app = buildServer();
    // Promo logic lives in views/settings.js after the P2.0 split.
    for (const path of ["/webapp/app.js", "/webapp/views/settings.js"]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("/api/llm-promo/quota");
      expect(r.body).not.toContain("fetchPromoQuota");
      expect(r.body).not.toContain("renderQuotaMeter");
    }
  });

  it("views/settings.js wires the issuance flow against /api/llm-promo/issue/{start,complete}", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/settings.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/llm-promo/issue/start");
    expect(r.body).toContain("/api/llm-promo/issue/complete");
    expect(r.body).toContain("flagship/llm-promo-issue-start/v1");
    expect(r.body).toContain("flagship/llm-promo-issue-complete/v1");
  });

  it("/webapp/index.html exposes the two-step issuance form (phone → OTP)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/" });
    expect(r.body).toContain('id="promo-issuance-form"');
    expect(r.body).toContain('id="promo-phone"');
    expect(r.body).toContain('id="promo-otp"');
    expect(r.body).toContain('id="promo-step-phone"');
    expect(r.body).toContain('id="promo-step-otp"');
    expect(r.body).toContain('id="promo-start-go"');
    expect(r.body).toContain('id="promo-complete-go"');
  });

  it("the promo card text reassures the user we don't see prompts", async () => {
    const app = buildServer();
    // Both the active-provider chip (home.js) and the settings list (settings.js)
    // surface the privacy reassurance — check both files for the strings.
    const homeR = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    const settingsR = await app.inject({ method: "GET", url: "/webapp/views/settings.js" });
    const combined = homeR.body + settingsR.body;
    expect(combined).toContain("flagshipserver.com cannot read prompts");
    expect(combined).toContain("Verify a phone number to claim once");
  });
});
