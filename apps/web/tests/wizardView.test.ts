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
