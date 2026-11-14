/**
 * Home's voi.ci page welcome card (the compact row's states are in webappVoiciPageRemove.test.ts). Same truth
 * table as iOS PageWelcomeCardTests and Android PageWelcomeCardStoreTest, plus static-source checks of its wiring
 * (it waits for the backup nudge, points to the Social tab's Profile, and keeps its dismissal per account).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldShowPageWelcome } from "../public/webapp/views/home.js";

const WEBAPP = join(__dirname, "..", "public", "webapp");
const HOME_JS = readFileSync(join(WEBAPP, "views", "home.js"), "utf8");
const MESSAGES_JS = readFileSync(join(WEBAPP, "views", "messages.js"), "utf8");
const STORE_JS = readFileSync(join(WEBAPP, "lib", "profilesStore.js"), "utf8");
const INDEX = readFileSync(join(WEBAPP, "index.html"), "utf8");
const APP_JS = readFileSync(join(WEBAPP, "app.js"), "utf8");
const STYLE = readFileSync(join(WEBAPP, "style.css"), "utf8");

const show = (o: Partial<{ hasAccount: boolean; checked: boolean; published: boolean; pendingChanges: number; dismissed: string | null }> = {}) =>
  shouldShowPageWelcome({ hasAccount: true, checked: true, published: false, pendingChanges: 0, dismissed: null, ...o });

describe("home page-welcome predicate", () => {
  it("shows for an account with no page", () => {
    expect(show()).toBe(true);
  });

  it("gives way to the compact row once the page is published, a change waits, or it was dismissed", () => {
    expect(show({ published: true })).toBe(false);
    expect(show({ pendingChanges: 1 })).toBe(false);
    expect(show({ dismissed: "true" })).toBe(false);
  });

  it("hides for a sample account or no account", () => {
    expect(show({ hasAccount: false })).toBe(false);
  });

  it("hides until the page was read (a failed read is not 'no page')", () => {
    expect(show({ checked: false })).toBe(false);
    expect(shouldShowPageWelcome()).toBe(false);
  });
});

describe("home page-welcome wiring", () => {
  it("keeps the dismissal in a per-profile slot", () => {
    expect(STORE_JS).toContain('slot: "voiciWelcomeDismissed"');
    expect(HOME_JS).toContain('recoveryStoreSet("voiciWelcomeDismissed", "true")');
  });

  it("waits for the backup nudge and comes back when that one is dismissed", () => {
    expect(HOME_JS).toMatch(/state === "card" && document\.getElementById\(RECOVERY_BANNER_ID\)\)\) return hide\(\)/);
    expect(HOME_JS).toMatch(/document\.getElementById\(RECOVERY_BANNER_ID\)\?\.remove\(\);\s*void renderPageWelcome\(\);/);
  });

  it("points to the Social tab's Profile, from the card and the compact row", () => {
    expect(HOME_JS).toContain('tr("Your public page")');
    expect(HOME_JS).toContain('tr("Set up your page")');
    expect(HOME_JS).toMatch(/import\("\.\/messages\.js"\)\.then\(\(m\) => m\.enterYourPage\(\)\)/);
    expect(MESSAGES_JS).toMatch(/export async function enterYourPage\(\) \{\s*await enterSocial\("profile"\);/);
  });

  it("fills a fixed slot below the servers, so its late arrival never moves Add / Restore a server under a tap", () => {
    expect(INDEX).toMatch(/<div id="servers-list"><\/div>\s*<!--[^]*?-->\s*<div id="home-page-welcome" class="home-page-slot"><\/div>/);
    const fn = HOME_JS.slice(HOME_JS.indexOf("async function renderPageWelcome"), HOME_JS.indexOf("E7 — peer"));
    expect(fn).not.toMatch(/insertBefore|createElement|\.remove\(\)/);
  });

  it("Settings has a Your page entry that opens the same place", () => {
    expect(INDEX).toMatch(/id="settings-tab-page"[^]*?Your page/);
    expect(APP_JS).toContain('wire("settings-tab-page", enterYourPage)');
    expect(INDEX).not.toContain('id="settings-tab-messages"');
  });

  it("the tab is Social, with the plain person glyph and its badge (no disc)", () => {
    expect(INDEX).toMatch(/data-tab-target="messages" role="tab" aria-label="Social">[^]*?<span class="tab-bar-label">Social<\/span>/);
    expect(INDEX).toContain('id="messages-tab-badge"');
    expect(APP_JS).toMatch(/const map = \{[^}]*messages: userIcon,/);
    expect(STYLE).not.toMatch(/\.tab-bar-btn\[data-tab-target="messages"\] \.icon \{/);
  });

  it("the tab opens on the title row, then Profile / Messages", () => {
    expect(INDEX).toMatch(/<section id="view-messages"[^>]*>\s*<div id="social-head"[^>]*><\/div>\s*<div class="fs-segmented social-switch"[^>]*>[^]*?data-social-side="profile"[^]*?data-social-side="messages"/);
    expect(INDEX).not.toContain('id="view-page-editor"');
    expect(INDEX).not.toContain('id="view-messages-settings"');
  });
});
