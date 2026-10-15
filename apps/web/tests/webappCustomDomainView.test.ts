// Phase 6 (#80/#81) — webapp custom-domain UX parity with the iOS
// Mock-faithful client. Served-asset string assertions (same pattern
// as the other webapp*View tests): the JS isn't executed here, we
// pin the load-bearing wire + copy so it can't silently drift from
// the iOS reference / the .com contract.

import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("webapp services-list — short→custom swap (#81)", () => {
  it("swaps the short slot to the custom domain only once confirmed", async () => {
    const body = await asset("/webapp/views/services-list.js");
    // Gated strictly on customDomainConfirmed === true (the .com
    // active-order signal), not merely on a present customDomain.
    expect(body).toContain("links?.customDomainConfirmed === true");
    expect(body).toContain("`https://${links.customDomain}`");
    expect(body).toContain("const short = confirmedCustom ?? links?.shortUrl ?? null;");
  });
});

describe("webapp service-detail — SET CUSTOM DOMAIN (#80)", () => {
  it("signs the exact .com canonical bytes and hits the custom-domain POST", async () => {
    const body = await asset("/webapp/views/service-detail.js");
    expect(body).toContain('"flagship/custom-domain/v1"');
    expect(body).toContain("/custom-domain`");
    expect(body).toContain("signWithIrk(session.umk, canonical)");
    // Decoupled: a 200 records + re-renders; no pending UI.
    expect(body).toContain("recordCustomDomainChangeLocally()");
  });

  it("mirrors the iOS apex→www and destructive-replace prompts verbatim", async () => {
    const body = await asset("/webapp/views/service-detail.js");
    // U+2014 em dash, byte-identical to ServiceDetailViewModel.
    expect(body).toContain(
      "This only supports subdomains — an apex like ${fqdn} can't take a CNAME. Use ${suggested}?",
    );
    expect(body).toContain("Subdomains only");
    expect(body).toContain(
      "This will permanently replace the current custom domain (${existing}). It can't be undone, even if the new one fails to verify.",
    );
    // Apex test is structural (<3 labels), not a DNS check.
    expect(body).toContain('fqdn.split(".").length < 3');
  });

  it("has a 300s on-device cooldown, M:SS countdown and CNAME guidance", async () => {
    const body = await asset("/webapp/views/service-detail.js");
    expect(body).toContain("CUSTOM_DOMAIN_COOLDOWN_MS = 300_000");
    expect(body).toContain('"flagship.customDomain.lastChanged."');
    expect(body).toContain("startCooldownTicker");
    expect(body).toContain(
      "Prior to claiming a FQDN, you must set a CNAME record targeting",
    );
    // The CUSTOM DOMAIN group sits atop WEB DOMAINS once bound.
    expect(body).toContain('<div class="label-tiny">CUSTOM DOMAIN</div>');
  });

  it("dropped the legacy P1.22 TXT-verify custom-domain model", async () => {
    const body = await asset("/webapp/views/service-detail.js");
    expect(body).not.toContain("/api/screens/url-controller/verify");
    expect(body).not.toContain("expectedTxtRecord");
  });
});
