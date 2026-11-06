/**
 * Home's voi.ci page welcome card (the compact row's states are in webappVoiciPageRemove.test.ts). Same truth
 * table as iOS PageWelcomeCardTests and Android PageWelcomeCardStoreTest, plus static-source checks of its wiring
 * (it waits for the backup nudge, points to the page header at the top of Messages, and keeps its dismissal per
 * account).
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

  it("points to the page header at the top of Messages, from the card and the compact row", () => {
    expect(HOME_JS).toContain('tr("Your public page")');
    expect(HOME_JS).toContain('tr("Set up your page")');
    expect(HOME_JS).toMatch(/import\("\.\/messages\.js"\)\.then\(\(m\) => m\.enterPageHeader\(\)\)/);
    expect(MESSAGES_JS).toMatch(/export async function enterPageHeader\(\)/);
  });

  it("Settings has a Your page entry that opens the same place", () => {
    expect(INDEX).toMatch(/id="settings-tab-page"[^]*?Your page/);
    expect(APP_JS).toContain('wire("settings-tab-page", enterPageHeader)');
  });

  it("the Messages tab stands out in the tab bar and keeps its badge and name", () => {
    expect(INDEX).toMatch(/data-tab-target="messages" role="tab" aria-label="Messages"/);
    expect(INDEX).toContain('id="messages-tab-badge"');
    expect(STYLE).toMatch(/\.tab-bar-btn\[data-tab-target="messages"\] \.icon \{[^}]*background: var\(--teal\)/);
  });

  it("the page header comes first on the Messages tab", () => {
    expect(INDEX).toMatch(/<div class="ph-bar" id="messages-page-bar"[^>]*><\/div>\s*<div id="messages-page-row"><\/div>\s*<h2>Messages<\/h2>/);
  });
});
