/**
 * Home's recovery reminders (owner, 2026-11-21: no backup page after creating
 * an account; Home reminds instead). One card at a time: cloud recovery while
 * `.com` holds none for the account, then a backup file once the cloud card was
 * put off and no key file was written from this browser. Each x snoozes its
 * card for a week. Same rule as iOS and Android RecoveryBannerStore.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeReminder, isSnoozed, REMINDER_SNOOZE_MS } from "../public/webapp/views/home.js";

const HOME_JS = readFileSync(join(__dirname, "..", "public", "webapp", "views", "home.js"), "utf8");
const BOOTSTRAP_JS = readFileSync(join(__dirname, "..", "public", "webapp", "views", "bootstrap.js"), "utf8");
const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "webapp", "index.html"), "utf8");

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("homeReminder", () => {
  it("a new account without cloud recovery gets the cloud recovery card first", () => {
    expect(homeReminder({ now: NOW })).toBe("cloud-recovery");
  });

  it("none once cloud recovery is set up, whatever else holds", () => {
    expect(homeReminder({ hasCloudRecovery: true, now: NOW })).toBe(null);
    expect(homeReminder({ hasCloudRecovery: true, recoveryDismissedAt: String(NOW), now: NOW })).toBe(null);
  });

  it("none for a demo account", () => {
    expect(homeReminder({ demo: true, now: NOW })).toBe(null);
  });

  it("the backup file card follows once the cloud card is put off", () => {
    expect(homeReminder({ recoveryDismissedAt: String(NOW - DAY), now: NOW })).toBe("backup-file");
  });

  it("a key file written from this browser is enough", () => {
    expect(homeReminder({ recoveryDismissedAt: String(NOW - DAY), hasBackupFile: true, now: NOW })).toBe(null);
  });

  it("both put off: nothing until a snooze ends", () => {
    const both = { recoveryDismissedAt: String(NOW - DAY), backupFileDismissedAt: String(NOW - DAY), now: NOW };
    expect(homeReminder(both)).toBe(null);
    expect(homeReminder({ ...both, now: NOW + REMINDER_SNOOZE_MS })).toBe("cloud-recovery");
  });

  it("a snooze lasts a week, and no stamp or a bad one is no snooze", () => {
    expect(isSnoozed(String(NOW), NOW + REMINDER_SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(String(NOW), NOW + REMINDER_SNOOZE_MS)).toBe(false);
    expect(isSnoozed(null, NOW)).toBe(false);
    expect(isSnoozed("nonsense", NOW)).toBe(false);
  });
});

describe("home recovery reminders wiring", () => {
  it("asks .com whether the account has cloud recovery, not a local flag", () => {
    expect(HOME_JS).toMatch(/hasCloudRecovery\(username\)/);
    expect(HOME_JS).not.toMatch(/recoveryStoreGet\("recoveryWarn"\)/);
  });

  it("an old forever dismissal becomes a snooze from now", () => {
    expect(HOME_JS).toMatch(/if \(at === "true"\)/);
  });

  it("the cloud card opens Recovery; the file card runs the key file ceremony", () => {
    expect(HOME_JS).toMatch(/enterRecovery\(\)/);
    expect(HOME_JS).toMatch(/runKeyfileExportCeremony\(\)/);
    expect(HOME_JS).toContain("Save a passkey so you can recover your account if you get a new device.");
  });

  it("the page welcome waits below a recovery reminder", () => {
    expect(HOME_JS).toMatch(/renderRecoveryBanner\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => renderPageWelcome\(\)\)/);
    expect(HOME_JS).toMatch(/getElementById\(BACKUP_FILE_REMINDER_ID\)/);
  });

  it("creating an account goes straight to Home, not the wizard's backup step", () => {
    expect(BOOTSTRAP_JS).not.toContain('enterWizard({ step: "secure-account" })');
    expect(BOOTSTRAP_JS).toMatch(/markVoiciIntroPending\(finalName\);\s+try \{\s+const \{ enterHome \} = await import\("\.\/home\.js"\);/);
  });

  it("Recovery says what cloud recovery is: a copy locked by a passkey, so no password", () => {
    expect(INDEX_HTML).toContain('id="recovery-explainer"');
    expect(INDEX_HTML).toContain("so there is no password to make up");
  });
});
