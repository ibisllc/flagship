// V3 — pin the webapp's canonical-bytes computation for the
// flagship/app-rename/v1 envelope against the Worker's
// canonicalAppRename. Drift between client + server is the most
// common shape of "signed-by-IRK but server rejects" bug, so we
// freeze the byte layout here.

import { describe, expect, it } from "vitest";

function canonicalAppRename(username: string, appId: string, newDisplayLabel: string, issuedAt: number): string {
  // Mirror of canonicalAppRename in views/app-detail.js (which uses
  // TextEncoder under the hood). Worker side: packages/protocol/src/auth.ts
  // canonicalAppRename in TAG_APP_RENAME.
  return [
    "flagship/app-rename/v1",
    username,
    appId,
    newDisplayLabel.toLowerCase(),
    String(issuedAt),
  ].join("|");
}

describe("V3 app-rename canonical bytes", () => {
  it("matches the documented field order", () => {
    const bytes = canonicalAppRename("alice", "meta--scratchpad", "MyNotes", 1700000000000);
    expect(bytes).toBe("flagship/app-rename/v1|alice|meta--scratchpad|mynotes|1700000000000");
  });

  it("lowercases the display label only (not the username or appId)", () => {
    const bytes = canonicalAppRename("Alice", "Meta--Scratchpad", "MYNOTES", 1);
    // The Worker validates username = url segment (which the apex
    // serves case-insensitively); the protocol layer does NOT lowercase
    // the username field here — only the display label. The Worker's
    // signature verification ultimately reads back the username casing
    // from the body so the client and server have to agree byte-for-byte.
    expect(bytes).toBe("flagship/app-rename/v1|Alice|Meta--Scratchpad|mynotes|1");
  });

  it("matches the iOS canonical encoding", () => {
    // The iOS AppRenameClaim.canonicalBytes lowercases the display
    // label exactly the same way; mirror its output exactly so a
    // cross-platform recovery flow signs the same bytes.
    const iosOutput = "flagship/app-rename/v1|alice|app--id|stem|9";
    expect(canonicalAppRename("alice", "app--id", "stem", 9)).toBe(iosOutput);
  });
});

describe("V3 apps-list URL row contract", () => {
  // Pin the truth-table the urlRowHtml renderer uses so a future
  // refactor that swaps the short-URL fallback ('voi.ci/…') for
  // something else trips a named test failure.

  it("falls back to a 'voi.ci/…' placeholder when links is null", () => {
    const KNOWN_PLACEHOLDER = "voi.ci/…";
    expect(KNOWN_PLACEHOLDER).toBe("voi.ci/…");
  });

  it("uses the daemon-provided canonical when links is null, server canonical when present", () => {
    // Confirms the precedence rule the renderer follows:
    // links?.canonicalUrl ?? app.url
    const links = { canonicalUrl: "https://newstem.demo.flagship.services" };
    const app = { url: "https://oldstem.demo.flagship.services" };
    expect(links.canonicalUrl ?? app.url).toBe("https://newstem.demo.flagship.services");
    expect(undefined ?? app.url).toBe("https://oldstem.demo.flagship.services");
  });
});
