/**
 * #25 + #95 — first-run wizard + peer-backup opt-in.
 *
 * We don't drive the wizard end-to-end (that's covered by Playwright
 * e2e); these tests cover the static structure + module surface so
 * future refactors don't accidentally drop the load-bearing parts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VIEW_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "wizard.js"),
  "utf8",
);
const INDEX_HTML = readFileSync(
  join(__dirname, "..", "public", "webapp", "index.html"),
  "utf8",
);

describe("first-run wizard (#25)", () => {
  it("exports enterWizard, shouldShowRecoveryWarning, getPeerBackupChoice", () => {
    expect(VIEW_JS).toMatch(/export async function enterWizard\(/);
    expect(VIEW_JS).toMatch(/export function shouldShowRecoveryWarning\(/);
    expect(VIEW_JS).toMatch(/export function getPeerBackupChoice\(/);
  });

  it("registers view-wizard with the router", () => {
    expect(VIEW_JS).toMatch(/registerView\(['"]view-wizard['"]\)/);
  });

  it("declares the 7 steps the design pass agreed on", () => {
    for (const id of [
      "device-key",
      "username",
      "passphrase",
      "webauthn-recovery",
      "create-server",
      "peer-backup",
      "demo-app",
    ]) {
      expect(VIEW_JS).toContain(`"${id}"`);
    }
  });

  it("recovery + peer-backup + demo are explicitly skippable", () => {
    // The skippable flag is set on each step that the user can defer.
    const skippableLine = VIEW_JS.match(/skippable: true/g);
    expect(skippableLine?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("links to the no-KYC policy from the username step", () => {
    expect(VIEW_JS).toMatch(/security\.html#no-kyc/);
  });

  it("index.html includes the view-wizard slot", () => {
    expect(INDEX_HTML).toMatch(/<section id="view-wizard" class="hidden">/);
  });
});

describe("account-creation taken-name state + trademark claim (Change C)", () => {
  it("pre-flights availability via checkUsername before opening the account", () => {
    expect(VIEW_JS).toMatch(/import \{ checkUsername \}/);
    expect(VIEW_JS).toMatch(/await checkUsername\(username\)/);
    expect(VIEW_JS).toMatch(/avail\.available === false/);
  });

  it("renders a dedicated taken-name panel (not just a toast)", () => {
    // The wizard renders its step bodies dynamically into the
    // #view-wizard slot, so the taken-name panel markup lives in the JS,
    // not index.html.
    expect(VIEW_JS).toMatch(/wizard-username-taken/);
    expect(VIEW_JS).toMatch(/function renderTakenState\(/);
    expect(VIEW_JS).toMatch(/id="wizard-username-taken"/);
  });

  it("offers the trademark-claim affordance in the taken state", () => {
    expect(VIEW_JS).toMatch(/import \{ trademarkClaimMailto \}/);
    expect(VIEW_JS).toMatch(/trademarkClaimMailto\(username\)/);
    expect(VIEW_JS).toContain("I hold a trademark to this name");
  });

  it("also shows the taken state when the claim itself comes back conflicted", () => {
    expect(VIEW_JS).toMatch(/already claimed\|409\|conflict/);
  });
});

describe("trademark-claim mailto helper (Change C)", () => {
  it("targets trademarks@flagshipserver.com with the requested name pre-filled", async () => {
    const {
      trademarkClaimMailto,
      trademarkClaimSubject,
      trademarkClaimBody,
      TRADEMARK_CLAIM_EMAIL,
    } = await import("../public/webapp/lib/trademarkClaim.js");

    expect(TRADEMARK_CLAIM_EMAIL).toBe("trademarks@flagshipserver.com");
    expect(trademarkClaimSubject("acme")).toBe('Trademark claim for the name "acme"');

    const body = trademarkClaimBody("acme");
    expect(body).toContain("acme");
    expect(body).toContain("Trademark registration number:");
    expect(body).toContain("Requested name: acme");

    const mailto = trademarkClaimMailto("acme");
    expect(mailto.startsWith("mailto:trademarks@flagshipserver.com?")).toBe(true);
    expect(mailto).toContain(`subject=${encodeURIComponent(trademarkClaimSubject("acme"))}`);
    expect(mailto).toContain(`body=${encodeURIComponent(body)}`);
  });

  it("URL-encodes the requested name into both subject and body", async () => {
    const { trademarkClaimMailto } = await import("../public/webapp/lib/trademarkClaim.js");
    // A bare handle never has spaces, but the encoder must still run so
    // the body's newlines/spaces are escaped.
    const mailto = trademarkClaimMailto("widgets");
    expect(mailto).not.toContain("\n");
    expect(mailto).toContain("widgets");
  });
});

describe("peer-backup opt-in step (#95)", () => {
  it("renders three buttons: enable / decline / maybe-later", () => {
    expect(VIEW_JS).toMatch(/wizard-pb-enable/);
    expect(VIEW_JS).toMatch(/wizard-pb-decline/);
    expect(VIEW_JS).toMatch(/wizard-pb-later/);
  });

  it("persists the user's choice to localStorage", () => {
    expect(VIEW_JS).toMatch(/localStorage\.setItem\(PEER_BACKUP_CHOICE_KEY/);
  });

  it("links to the no-KYC framing (sealed against keys only you hold)", () => {
    expect(VIEW_JS).toMatch(/sealed against keys only you hold/i);
  });

  it("includes a Settings reference so the user knows they can change later", () => {
    expect(VIEW_JS).toMatch(/Settings.*Peer-backup/);
  });
});
