import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";
import {
  llmKeyEnvVarFor,
  LLM_KEY_ENV_DEFAULT,
} from "../public/webapp/lib/marketplaceLlmKey.js";

async function loadMarketplaceModule() {
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(__dirname, "..", "public", "webapp", "views", "marketplace.js");
  return await import(pathToFileURL(path).href + bust);
}

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

// ---- Task #29: install-confirm security gate (scan_grade) ---------------

describe("marketplace install gate — installConfirmParams(listing)", () => {
  it("static: the install path passes the danger flag through inlineConfirm", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/marketplace.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function installConfirmParams");
    // The gate output feeds inlineConfirm, INCLUDING the danger flag (the
    // distinct red "Install anyway" affordance for a failing grade).
    expect(r.body).toContain("installConfirmParams(listing)");
    expect(r.body).toContain("danger: gate.danger");
    expect(r.body).toContain("Install anyway");
  });

  it("grade F → BLOCKED with a danger 'Install anyway' override (not the normal tap)", async () => {
    const mod = await loadMarketplaceModule();
    const p = mod.installConfirmParams({ creator: "eve", slug: "sketchy", scan_grade: "F" });
    expect(p.blocked).toBe(true);
    expect(p.danger).toBe(true);
    expect(p.okLabel).toBe("Install anyway");
    // Distinct security warning, not the ordinary install copy.
    expect(p.title).toMatch(/Security warning/i);
    expect(p.message).toMatch(/critical/i);
    // Case-insensitive: lowercase "f" is still a blocking failing grade.
    expect(mod.installConfirmParams({ creator: "eve", slug: "x", scan_grade: "f" }).blocked).toBe(true);
    // Tolerates the camelCase `scanGrade` alias.
    expect(mod.installConfirmParams({ creator: "eve", slug: "x", scanGrade: "F" }).blocked).toBe(true);
  });

  it("null / ungraded → allowed, but the confirm cautions it was never scanned", async () => {
    const mod = await loadMarketplaceModule();
    for (const listing of [
      { creator: "bob", slug: "app", scan_grade: null },
      { creator: "bob", slug: "app" },
    ]) {
      const p = mod.installConfirmParams(listing);
      expect(p.blocked).toBe(false);
      expect(p.danger).toBe(false);
      expect(p.okLabel).toBe("Install");
      expect(p.message).toMatch(/has not been security-scanned yet/i);
    }
  });

  it("A / B / C / D → normal confirm, no extra warning (D allowed under policy)", async () => {
    const mod = await loadMarketplaceModule();
    for (const grade of ["A", "B", "C", "D"]) {
      const p = mod.installConfirmParams({ creator: "alice", slug: "app", scan_grade: grade });
      expect(p.blocked).toBe(false);
      expect(p.danger).toBe(false);
      expect(p.okLabel).toBe("Install");
      expect(p.title).toBe("Install alice/app?");
      // No failing/scan-warning copy on the passing grades.
      expect(p.message).not.toMatch(/critical|has not been security-scanned/i);
    }
  });
});
