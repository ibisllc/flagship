import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp promo UI — no proxy quota fetching", () => {
  it("/webapp/app.js does NOT post to the deleted /api/llm-promo/quota", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("/api/llm-promo/quota");
    expect(r.body).not.toContain("fetchPromoQuota");
    expect(r.body).not.toContain("renderQuotaMeter");
  });

  it("/webapp/app.js wires the issuance flow against /api/llm-promo/issue/{start,complete}", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
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
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    // The minted-key message tells the user prompts go phone → server → GPU directly.
    expect(r.body).toContain("flagshipserver.com cannot read prompts");
    // The CTA explains the issuance is one-time.
    expect(r.body).toContain("Verify a phone number to claim once");
  });
});
