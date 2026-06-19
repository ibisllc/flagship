import { describe, expect, it } from "vitest";
import { defaultApexPage } from "../src/runtime.js";

describe("defaultApexPage (the box's unassigned-apex landing)", () => {
  const page = defaultApexPage("az2.harry.flagship.services");

  it("identifies itself and tells the owner how to replace it", () => {
    expect(page).toContain("This is a Flagship server.");
    expect(page).toContain("az2.harry.flagship.services");
    expect(page).toContain("choose what appears here");
    expect(page).toContain("Flagship app");
  });

  it("carries the content-blind claim", () => {
    expect(page).toContain("TLS terminates on this server");
    expect(page).toContain("ciphertext");
  });

  it("is fully self-contained with ZERO outbound references — never leaks visitors to .com", () => {
    // No remote fonts, stylesheets, scripts, or images (loading any asset from
    // .com would leak the box's visitors), AND no clickable link to .com either:
    // the wordmark is plain text ("Get yours at flagshipserver.com"), so a click
    // can't send a Referer carrying this box's hostname to the mothership.
    const outbound = (page.match(/https?:\/\/[^"'\s)]+/g) ?? []).filter(
      // The SVG xmlns in the favicon data URI is an identifier, not a fetch.
      (u) => !u.startsWith("http://www.w3.org/"),
    );
    expect(outbound).toEqual([]);
    expect(page).not.toContain("<script");
    expect(page).not.toContain('href="https://flagshipserver.com"');
    expect(page).toContain("Get yours at");
    expect(page).toContain('href="data:image/svg+xml');
  });

  it("stays out of search indexes (hostnames are CT-log-public already)", () => {
    expect(page).toContain('name="robots" content="noindex"');
  });

  it("escapes a hostile serverFqdn", () => {
    const evil = defaultApexPage(`x"><script>alert(1)</script>`);
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
  });
});
