/**
 * P1 — home backup-reminder banner.
 *
 * The banner shows on the home view when the first-run wizard flagged
 * recovery as skipped (not enrolled) AND the user hasn't dismissed the
 * nudge on this device. We test the exported decision predicate directly
 * (the rule lives in one pure function so it's testable without a DOM,
 * mirroring accountReset.test.ts) plus static-source assertions that the
 * banner wires to the right keys + recovery view.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldShowRecoveryBanner } from "../public/webapp/views/home.js";

const HOME_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "home.js"),
  "utf8",
);
const WIZARD_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "wizard.js"),
  "utf8",
);

describe("home recovery-banner predicate", () => {
  it("shows when recovery is flagged not-enrolled and not dismissed", () => {
    expect(shouldShowRecoveryBanner({ warn: "true", dismissed: null })).toBe(true);
    expect(shouldShowRecoveryBanner({ warn: "true", dismissed: undefined })).toBe(true);
    expect(shouldShowRecoveryBanner({ warn: "true" })).toBe(true);
  });

  it("hides after the user dismisses it", () => {
    expect(shouldShowRecoveryBanner({ warn: "true", dismissed: "true" })).toBe(false);
  });

  it("hides when recovery IS enrolled (the warn flag is absent)", () => {
    // The wizard REMOVES the warn key once a real backup completes, so a
    // missing / non-"true" value means recovery is enrolled → no nudge.
    expect(shouldShowRecoveryBanner({ warn: null, dismissed: null })).toBe(false);
    expect(shouldShowRecoveryBanner({ warn: undefined, dismissed: null })).toBe(false);
    expect(shouldShowRecoveryBanner({})).toBe(false);
  });

  it("never shows when both enrolled and dismissed", () => {
    expect(shouldShowRecoveryBanner({ warn: null, dismissed: "true" })).toBe(false);
  });
});

describe("home recovery-banner wiring", () => {
  it("reuses the EXACT recovery-warn key the wizard sets", () => {
    // The signal must be identical on both ends or the nudge desyncs from
    // the actual enrolment state.
    expect(HOME_JS).toContain('"flagship.recovery.warn.v1"');
    expect(WIZARD_JS).toContain('"flagship.recovery.warn.v1"');
  });

  it("dismiss writes a local flag (no API) so it stays hidden", () => {
    expect(HOME_JS).toMatch(/RECOVERY_BANNER_DISMISS_KEY/);
    expect(HOME_JS).toMatch(/localStorage\.setItem\(RECOVERY_BANNER_DISMISS_KEY, "true"\)/);
  });

  it("the CTA routes into Settings → Recovery via enterRecovery()", () => {
    expect(HOME_JS).toMatch(/import\(["']\.\/recovery\.js["']\)/);
    expect(HOME_JS).toMatch(/enterRecovery\(\)/);
  });

  it("renders the banner above the server list on home enter", () => {
    expect(HOME_JS).toMatch(/renderRecoveryBanner\(\)/);
    expect(HOME_JS).toMatch(/getElementById\(["']servers-list["']\)/);
  });
});
