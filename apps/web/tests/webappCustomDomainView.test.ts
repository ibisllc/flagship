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

describe("webapp apps-list — short→custom swap (#81)", () => {
  it("swaps the short slot to the custom domain only once confirmed", async () => {
    const body = await asset("/webapp/views/apps-list.js");
    // Gated strictly on customDomainConfirmed === true (the .com
    // active-order signal), not merely on a present customDomain.
    expect(body).toContain("links?.customDomainConfirmed === true");
    expect(body).toContain("`https://${links.customDomain}`");
    expect(body).toContain("const short = confirmedCustom ?? links?.shortUrl ?? null;");
  });
});
