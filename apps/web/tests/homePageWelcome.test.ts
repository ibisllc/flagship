/**
 * Home's voi.ci page welcome card. Same truth table as iOS PageWelcomeCardTests and Android
 * PageWelcomeCardStoreTest, plus static-source checks of its wiring (it waits for the backup nudge,
 * opens the page editor, and keeps its dismissal per account).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldShowPageWelcome } from "../public/webapp/views/home.js";

const WEBAPP = join(__dirname, "..", "public", "webapp");
const HOME_JS = readFileSync(join(WEBAPP, "views", "home.js"), "utf8");
const MESSAGES_JS = readFileSync(join(WEBAPP, "views", "messages.js"), "utf8");
const STORE_JS = readFileSync(join(WEBAPP, "lib", "profilesStore.js"), "utf8");

const show = (o: Partial<{ hasAccount: boolean; checked: boolean; published: boolean; pendingChanges: number; dismissed: string | null }> = {}) =>
  shouldShowPageWelcome({ hasAccount: true, checked: true, published: false, pendingChanges: 0, dismissed: null, ...o });

describe("home page-welcome predicate", () => {
  it("shows for an account with no page", () => {
    expect(show()).toBe(true);
  });

  it("hides once the page is published", () => {
    expect(show({ published: true })).toBe(false);
  });

  it("hides while a change waits to be published", () => {
    expect(show({ pendingChanges: 1 })).toBe(false);
  });

  it("hides after the person dismisses it", () => {
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
    expect(HOME_JS).toMatch(/document\.getElementById\(RECOVERY_BANNER_ID\)\) return hide\(\)/);
    expect(HOME_JS).toMatch(/document\.getElementById\(RECOVERY_BANNER_ID\)\?\.remove\(\);\s*void renderPageWelcome\(\);/);
  });

  it("opens the page editor from its button", () => {
    expect(HOME_JS).toContain('tr("Set up your page")');
    expect(HOME_JS).toMatch(/import\("\.\/page-editor\.js"\)\.then\(\(m\) => m\.enterPageEditor\(\)\)/);
  });

  it("the Messages page row says what it does", () => {
    expect(MESSAGES_JS).toContain('tr("Set up your page")');
    expect(MESSAGES_JS).toContain('tr("Edit your page")');
  });
});
