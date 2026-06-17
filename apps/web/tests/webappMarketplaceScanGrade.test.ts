import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import {
  llmKeyEnvVarFor,
  LLM_KEY_ENV_DEFAULT,
} from "../public/webapp/lib/marketplaceLlmKey.js";

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

  // ---- Fix 1: install must not dead-end when the app needs an LLM key -----

  it("llmKeyEnvVarFor returns the listing's env var, else the shared default", () => {
    expect(LLM_KEY_ENV_DEFAULT).toBe("OPENAI_API_KEY");
    // Listing declares its own name → use it verbatim.
    expect(llmKeyEnvVarFor({ requiresLlmKey: true, llmKeyEnvVar: "ANTHROPIC_API_KEY" })).toBe(
      "ANTHROPIC_API_KEY",
    );
    // No declared name → fall back to the default.
    expect(llmKeyEnvVarFor({ requiresLlmKey: true })).toBe(LLM_KEY_ENV_DEFAULT);
    expect(llmKeyEnvVarFor({ requiresLlmKey: true, llmKeyEnvVar: "" })).toBe(LLM_KEY_ENV_DEFAULT);
    expect(llmKeyEnvVarFor(null)).toBe(LLM_KEY_ENV_DEFAULT);
  });

  it("marketplace.js routes a requiresLlmKey install to Configure environment (not a bare success)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/marketplace.js" });
    expect(r.statusCode).toBe(200);
    // Gates on the flag and deep-links into the env editor with the prefilled
    // env-var name — the whole point of the fix.
    expect(r.body).toContain("listing.requiresLlmKey");
    expect(r.body).toContain("llmKeyEnvVarFor");
    expect(r.body).toContain("enterServiceEnv");
    // The serviceId handed to the editor mirrors the daemon's `<creator>--<slug>`.
    expect(r.body).toContain("${creator}--${slug}");
  });

  it("service-env.js accepts a prefill name and seeds the NAME field (never a value)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-env.js" });
    expect(r.statusCode).toBe(200);
    // enterServiceEnv now takes the prefill arg and writes it to the name input.
    expect(r.body).toContain("prefillName");
    expect(r.body).toMatch(/service-env-name/);
    // It must focus the VALUE field for the secret, and must NOT prefill a value.
    expect(r.body).toContain('$("service-env-value")?.focus()');
  });
});
