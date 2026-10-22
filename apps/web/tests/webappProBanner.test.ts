/**
 * Home "Become a Pro member" CTA banner.
 *
 * Flagship is free; monetization is bandwidth-metered (Free 50 GB / Pro
 * 250 GB) + a marketplace. Most users never hit the bandwidth cap, so the
 * cap-hit upgrade alert (a separate surface) never reaches the ~95% who'd
 * happily back the project. This always-available, fully-dismissible
 * membership CTA on the home view is their path; it links to /pro.
 *
 * We test the exported decision predicate directly (pure, DOM-free — mirrors
 * homeRecoveryBanner.test.ts) plus static-source assertions that the banner
 * carries the membership copy, links to /pro, and gates on a persisted
 * per-device dismiss flag (so it never nags — the project's hard rule for
 * marketing surfaces).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  shouldShowProBanner,
  PRO_URL,
  PRO_BANNER_DISMISS_KEY,
} from "../public/webapp/lib/proBanner.js";

const PRO_BANNER_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "lib", "proBanner.js"),
  "utf8",
);
const HOME_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "home.js"),
  "utf8",
);

describe("home pro-banner predicate", () => {
  it("is ALWAYS available until explicitly dismissed (no cap-hit precondition)", () => {
    expect(shouldShowProBanner({ dismissed: null })).toBe(true);
    expect(shouldShowProBanner({ dismissed: undefined })).toBe(true);
    expect(shouldShowProBanner({})).toBe(true);
    expect(shouldShowProBanner()).toBe(true);
  });

  it("hides once the user dismisses it on this device", () => {
    expect(shouldShowProBanner({ dismissed: "true" })).toBe(false);
  });
});

describe("home pro-banner copy + link", () => {
  it("uses membership / support framing — not a donation/guilt plea", () => {
    expect(PRO_BANNER_JS).toContain("Become a Pro member");
    expect(PRO_BANNER_JS).toMatch(/keep Flagship free & independent/);
    // The CTA wording is membership/support, never a donation ask.
    expect(PRO_BANNER_JS).toMatch(/ctaLabel:\s*"See Pro membership"/);
  });

  it("links to the /pro membership page on the .com origin", () => {
    expect(PRO_URL).toBe("https://flagshipserver.com/pro");
    expect(PRO_BANNER_JS).toContain("https://flagshipserver.com/pro");
  });
});

describe("home pro-banner dismiss behavior (non-naggy)", () => {
  it("persists a per-device dismiss flag via the profile store", () => {
    expect(PRO_BANNER_DISMISS_KEY).toBe("flagship.pro.banner.dismissed.v1");
    expect(PRO_BANNER_JS).toMatch(/profileSet\("proBannerDismissed", "true"\)/);
    expect(PRO_BANNER_JS).toMatch(/profileGet\("proBannerDismissed"\)/);
  });

  it("wires the dismiss + CTA off the announcementCard hooks", () => {
    expect(PRO_BANNER_JS).toMatch(/\[data-ann-dismiss\]/);
    expect(PRO_BANNER_JS).toMatch(/\[data-ann-cta\]/);
    // dismissible:true so the card renders the "x".
    expect(PRO_BANNER_JS).toMatch(/dismissible:\s*true/);
  });
});

describe("home pro-banner wiring into the home view", () => {
  it("renders on home enter, above the server list", () => {
    expect(HOME_JS).toMatch(/import\s*\{\s*renderProBanner\s*\}\s*from\s*["']\.\.\/lib\/proBanner\.js["']/);
    expect(HOME_JS).toMatch(/renderProBanner\(\)/);
    expect(PRO_BANNER_JS).toMatch(/getElementById\(["']servers-list["']\)/);
    expect(PRO_BANNER_JS).toMatch(/insertBefore/);
  });
});
