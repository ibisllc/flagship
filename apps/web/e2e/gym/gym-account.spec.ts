/**
 * Settings and the account with no backend, reached by clicking from Home:
 * every Settings row and its Back, Appearance/Privacy/About, no developer
 * tools, Sign out and Remove this device with cloud recovery set up, the
 * Delete account ceremony (signed under the admin root), a demo account's
 * Settings, Browser sessions (only browsers opened through Remote), the
 * Remote browsers list, two-factor enrolment and disable, Profiles, Open
 * secured sessions, Trusted devices' Replace countdown, and the 429
 * sentences `.com`'s rate limiter produces (lib/rateLimited.js).
 *
 * `.com` and the boxes are the gymKit router; anything it doesn't know is a 404.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNT_ID,
  HOME,
  OFFICE,
  livePod,
  mock,
  reachHome,
  sawToast,
  sensitive,
  shot,
  toastMark,
  toasts,
  watchToasts,
  type Mock,
} from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const box = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;
const RATE_LIMITED_12_MIN = (limit: string) => ({
  status: 429,
  json: { error: "rate-limited", endpoint: "x", limit, retryAfterSec: 720, message: "rate limited" },
});

/** Drop the gym's apex override so `.com` is this page's own origin: the
 *  libs captured that apex at load, and the global `.com` guard (which turns
 *  the rate limiter's 429 into its sentence) must see the same host. In
 *  production both are flagshipserver.com. */
async function samePageApex(page: Page): Promise<void> {
  await page.evaluate(async () => (await import("/lib/apex.js")).setApexOverride(null));
}

/** Remote/QR relays never reach a network. */
async function noSockets(page: Page): Promise<void> {
  await page.routeWebSocket(/.*/, () => {});
}

async function openSettings(page: Page): Promise<void> {
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
}

/** The account has cloud recovery set up (the recovery directory knows it). */
function recoveryEnrolled(m: Mock): void {
  m.get("/api/recovery/by-username/smoketest", { ok: true });
}

function baseAccount(m: Mock): void {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
  m.get(`/api/accounts/${ACCOUNT_ID}/directory`, {
    accountId: ACCOUNT_ID,
    devices: [],
    selfProfiles: [],
    managedProfiles: [],
    grants: [],
  });
}

/** The cover's "Connect to an existing account" page holds the account-name
 *  field (dbb1d746e); open it when it isn't already showing. */
async function openConnect(page: Page): Promise<void> {
  if (await page.locator("#bootstrap-username").isVisible()) return;
  await page.click("#bootstrap-connect");
  await expect(page.locator("#bootstrap-username")).toBeVisible();
}

test.describe("gym webapp account", () => {
  test("gym account every Settings row opens its screen from Home and Back leaves it", async ({ page }, testInfo) => {
    await noSockets(page);
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    baseAccount(m);
    m.get(box(HOME, "/api/screens/paired-sessions/list"), { sessions: [] });
    m.get(box(HOME, "/api/screens/companion/list"), { companions: [] });

    // row → the screen it opens → its Back → where Back lands: every screen
    // opened from Settings goes Back to the Settings tab.
    const rows: Array<[row: string, view: string, back: string, landing: string]> = [
      ["#settings-tab-account-security", "#view-account-security", "#account-security-back", "#view-settings-tab"],
      ["#settings-tab-providers", "#view-settings", "#settings-back", "#view-settings-tab"],
      ["#settings-tab-push", "#view-settings", "#settings-back", "#view-settings-tab"],
      ["#settings-tab-recovery", "#view-recovery", "#recovery-back", "#view-settings-tab"],
      ["#settings-tab-backup-key", "#view-recovery", "#recovery-back", "#view-settings-tab"],
      ["#settings-tab-profiles", "#view-profiles", "#profiles-back", "#view-settings-tab"],
      ["#settings-tab-trusted-devices", "#view-trusted-devices", "#trusted-devices-back", "#view-settings-tab"],
      ["#settings-tab-sessions", "#view-paired-sessions", "#paired-sessions-back", "#view-settings-tab"],
      ["#settings-tab-companion-dock", "#view-companion-dock", "#companion-dock-back", "#view-settings-tab"],
      ["#settings-tab-companion-requests", "#view-companion-requests", "#companion-requests-back", "#view-settings-tab"],
      ["#settings-tab-secured-sessions", "#view-secured-sessions", "#secured-sessions-back", "#view-settings-tab"],
      ["#settings-tab-process-url", "#view-access-authorize", "#access-authorize-back", "#view-settings-tab"],
      ["#settings-tab-peer-backup", "#view-peer-backup", "#peer-backup-back", "#view-settings-tab"],
      ["#settings-tab-appearance", "#view-appearance", "#appearance-back", "#view-settings-tab"],
      ["#settings-tab-privacy", "#view-privacy", "#privacy-back", "#view-settings-tab"],
      ["#settings-tab-about", "#view-about", "#about-back", "#view-settings-tab"],
    ];
    for (const [row, view, back, landing] of rows) {
      await openSettings(page);
      await page.click(row);
      await expect(page.locator(view), `${row} opens ${view}`).toBeVisible({ timeout: 10_000 });
      if (row === "#settings-tab-push") await expect(page.locator("#push-switch")).toBeAttached();
      if (row === "#settings-tab-backup-key") await expect(page.locator("#recovery-keyfile-export")).toBeInViewport();
      await page.click(back);
      await expect(page.locator(view), `${back} leaves ${view}`).toBeHidden();
      if (landing) await expect(page.locator(landing), `${back} lands on ${landing}`).toBeVisible();
    }
    await shot(page, testInfo, "settings-rows-walked");

    // Scan a pairing code: a link that isn't one is refused in the dialog; Cancel closes it.
    await openSettings(page);
    await page.click("#settings-tab-join-account");
    const join = page.locator("dialog [data-join-input]");
    await expect(join).toBeVisible();
    await join.fill("https://example.com/nope");
    await page.click("dialog [data-join-continue]");
    await expect(page.locator("dialog [data-join-error]")).toBeVisible();
    await shot(page, testInfo, "settings-join-refused");
    await page.click("dialog [data-join-cancel]");
    await expect(page.locator("dialog [data-join-input]")).toHaveCount(0);
  });

  test("gym account Appearance, Privacy and About carry their text and links", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await openSettings(page);
    await page.click("#settings-tab-appearance");
    await expect(page.locator("#view-appearance")).toContainText("follows your device's light or dark setting");
    await page.click("#appearance-back");
    await page.click("#settings-tab-privacy");
    const disclosure = page.locator("#view-privacy a.pill");
    await expect(disclosure).toHaveAttribute("href", "https://flagshipserver.com/security#disclosure");
    await expect(disclosure).toHaveAttribute("target", "_blank");
    await expect(disclosure).toHaveAttribute("rel", "noopener");
    await page.click("#privacy-back");
    await page.click("#settings-tab-about");
    await expect(page.locator('#view-about a[href="https://flagshipserver.com/"]')).toHaveAttribute("rel", "noopener");
    await expect(page.locator('#view-about a[href="https://flagshipserver.com/security#report"]')).toHaveText("Security report");
    await expect(page.locator("#view-about")).toContainText("BUSL-1.1");
    await shot(page, testInfo, "settings-about");
    await page.click("#about-back");
    await expect(page.locator("#view-settings-tab")).toBeVisible();
  });

  test("gym account Settings has no developer tools, even with ?debug=1", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await page.evaluate(() => history.replaceState({}, "", "/?debug=1"));
    await openSettings(page);
    await expect(page.locator("#view-settings-tab")).not.toContainText("DEVELOPER");
    for (const id of ["#settings-debug-toggle", "#settings-developer-row", "#settings-tab-orders-debug", "#view-orders-debug"]) {
      await expect(page.locator(id)).toHaveCount(0);
    }
    expect(await page.evaluate(() => localStorage.getItem("flagship.debug"))).toBeNull();
    await shot(page, testInfo, "settings-no-developer-tools");
  });

  test("gym account sign out with cloud recovery asks first, then erases this device's key", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    recoveryEnrolled(m);
    await openSettings(page);
    const signOut = page.locator("#settings-signout");
    // Recovery is set up, so neither session button is greyed.
    await expect(signOut).not.toHaveClass(/gated/, { timeout: 10_000 });
    await expect(page.locator("#settings-reset")).not.toHaveClass(/gated/);

    // An admin device is warned that the admin key goes with it. Dismissing
    // keeps the account key in memory.
    await signOut.click();
    await expect(page.locator(".modal-title")).toHaveText("Sign out?");
    await expect(page.locator(".modal-message")).toHaveText(
      "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway.",
    );
    await expect(page.locator("[data-modal-choice=save]")).toHaveText("Save my account key first");
    await expect(page.locator("[data-modal-choice=go]")).toHaveText("Sign out anyway");
    await shot(page, testInfo, "signout-confirm");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(true);

    // Sign out anyway: the key leaves this device and the app goes back to Welcome.
    await signOut.click();
    await page.click("[data-modal-choice=go]");
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 10_000 });
    await sawToast(page, "Signed out");
    expect(await page.evaluate(async () => (await import("/lib/state.js")).getSession().umk)).toBeNull();
    // Signing out is local: nothing is sent to `.com` or a box.
    expect(m.sent("/api/", "POST")).toEqual([]);
    await shot(page, testInfo, "signed-out");
  });

  test("gym account sign out after a key backup says what to keep, and Save my account key first signs nothing out", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    recoveryEnrolled(m);
    await openSettings(page);
    const signOut = page.locator("#settings-signout");
    await expect(signOut).not.toHaveClass(/gated/, { timeout: 10_000 });

    // Save my account key first opens the account-key backup; nothing is signed out.
    await signOut.click();
    await page.click("[data-modal-choice=save]");
    await expect(page.locator(".modal-overlay")).toContainText("ACCOUNT BACKUP");
    await page.locator("[data-cancel]").click();
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(true);

    // Once this device has written a key file, the warning says what to keep.
    await page.evaluate(async () => (await import("/lib/profilesStore.js")).set("keyBackupAt", Date.now()));
    await signOut.click();
    await expect(page.locator(".modal-message")).toHaveText(
      "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe.",
    );
    await expect(page.locator("[data-modal-choice=cancel]")).toHaveText("Cancel");
    await expect(page.locator("[data-modal-choice=go]")).toHaveText("Sign out");
    await shot(page, testInfo, "signout-confirm-backed-up");
    await page.click("[data-modal-choice=cancel]");
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(true);
  });

  test("gym account Remove this device with cloud recovery confirms and returns to Welcome", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    recoveryEnrolled(m);
    await openSettings(page);
    const reset = page.locator("#settings-reset");
    await expect(reset).not.toHaveClass(/gated/, { timeout: 10_000 });
    await reset.click();
    // The admin key goes too: asked first, in plain words.
    await expect(page.locator(".modal-title")).toHaveText("Remove this account from this browser?");
    await expect(page.locator(".modal-message")).toHaveText(
      "This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway.",
    );
    await page.click("[data-modal-choice=go]");
    await expect(page.locator(".modal-title")).toHaveText("Reset this device?");
    await expect(page.locator("[data-modal-ok]")).toHaveText("Reset");
    await shot(page, testInfo, "remove-device-confirm");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 10_000 });
    const left = await page.evaluate(async () => ({
      umk: (await import("/lib/state.js")).getSession().umk,
      token: (await import("/lib/profilesStore.js")).get("sessionToken"),
    }));
    expect(left.umk).toBeNull();
    expect(left.token ?? null).toBeNull();
  });

  test("gym account Delete account: the typed name gates it, Cancel keeps the account, then it signs under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    m.post(
      "/api/account/self-delete",
      sensitive(
        page,
        keys,
        (r: { username: string; issuedAt: number }) => `flagship/account-self-delete/v1|${r.username}|${r.issuedAt}`,
        (b) => ({ arg: b.accountSelfDelete?.request, sig: b.accountSelfDelete?.signature }),
        () => ({ json: { ok: true } }),
      ),
    );
    await openSettings(page);
    await page.click("#settings-tab-account-delete");
    await expect(page.locator("#view-account-delete")).toBeVisible();
    const go = page.locator("#account-delete-go");
    await expect(go).toBeDisabled();
    await page.fill("#account-delete-confirm-input", "someone-else");
    await expect(go).toBeDisabled();
    await page.fill("#account-delete-confirm-input", "SmokeTest");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "delete-account-gated");

    // Cancel: back to Settings, nothing sent, key kept.
    await page.click("#account-delete-back");
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    expect(m.sent("/api/account/self-delete")).toEqual([]);

    // The form starts gated again; ask the servers to wipe too, and delete.
    await page.click("#settings-tab-account-delete");
    await expect(go).toBeDisabled();
    await page.check("#account-delete-wipe-content");
    await page.fill("#account-delete-confirm-input", "smoketest");
    await go.click();
    // The mock answered 200 only because the order verified under the admin
    // root (an IRK signature gets `.com`'s 403 and the account stays).
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("header p")).toHaveText("account deleted");
    const post = m.last("/api/account/self-delete")!;
    expect(post.body.accountSelfDelete.request.username).toBe("smoketest");
    // "Also wipe my servers' content": the second order rides the same request.
    expect(post.body.serversSelfDelete.request).toEqual(post.body.accountSelfDelete.request);
    expect(await page.evaluate(async () => (await import("/lib/state.js")).getSession().umk)).toBeNull();
  });

  test("gym account a demo account hides the key rows and Sign out only removes it from this browser", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "demo", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await openSettings(page);
    // The demo holds no account key: nothing to back up or recover here.
    for (const id of ["#settings-tab-recovery", "#settings-tab-backup-key", "#settings-tab-trusted-devices"]) {
      await expect(page.locator(id)).toHaveClass(/\bhidden\b/);
      await expect(page.locator(id)).toBeHidden();
    }
    await expect(page.locator("#settings-signout")).not.toHaveClass(/gated/, { timeout: 10_000 });
    await shot(page, testInfo, "settings-demo");

    // Delete account and Sign out both explain the demo, and remove it here only.
    await page.click("#settings-tab-account-delete");
    await expect(page.locator(".modal-title")).toHaveText("Demo account");
    await page.click("[data-modal-cancel]");
    await page.click("#settings-signout");
    await expect(page.locator(".modal-title")).toHaveText("Demo account");
    await expect(page.locator("[data-modal-ok]")).toHaveText("Remove from this browser");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 10_000 });
    const profiles = await page.evaluate(async () => (await import("/lib/profiles.js")).loadProfiles().profiles.map((p: { cloudName: string }) => p.cloudName));
    expect(profiles).not.toContain("smoketest");
    expect(m.sent("/api/", "POST")).toEqual([]);
  });

  test("gym account Browser sessions lists only browsers opened through Remote and revokes one", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    let legacy = false;
    m.get(box(HOME, "/api/screens/paired-sessions/list"), () => ({
      json: {
        sessions: legacy
          ? [
              { tokenPrefix: "cccc1111", addedAt: Date.now() - 60_000 },
              { tokenPrefix: "dddd2222", addedAt: Date.now() - 60_000, current: true },
            ]
          : [
              { tokenPrefix: "aaaa1111", kind: "remote", addedAt: Date.now() - 3_600_000 },
              { tokenPrefix: "bbbb2222", kind: "device", addedAt: Date.now() - 86_400_000, current: true },
              { tokenPrefix: "eeee3333", kind: "device", addedAt: Date.now() - 86_400_000 },
            ],
      },
    }));
    m.on("DELETE", box(HOME, "/api/screens/paired-sessions/aaaa1111"), { ok: true });
    await openSettings(page);
    await page.click("#settings-tab-sessions");
    const content = page.locator("#paired-sessions-content");
    await expect(content.locator(".card")).toHaveCount(1, { timeout: 10_000 });
    await expect(content).toContainText("Session aaaa1111");
    await expect(content).not.toContainText("bbbb2222");
    await expect(content).not.toContainText("eeee3333");
    await shot(page, testInfo, "browser-sessions");

    // Revoke asks first; Cancel sends nothing.
    await content.locator('[data-action="revoke"][data-prefix="aaaa1111"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Revoke session aaaa1111…?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/paired-sessions/aaaa1111", "DELETE")).toEqual([]);
    await content.locator('[data-action="revoke"][data-prefix="aaaa1111"]').click();
    await page.click("[data-modal-ok]");
    await sawToast(page, "Revoked");
    expect(m.sent("/paired-sessions/aaaa1111", "DELETE")).toHaveLength(1);

    // A box from before `kind`: everything but this device's own session.
    legacy = true;
    await page.click("#paired-sessions-refresh");
    await expect(content).toContainText("Session cccc1111", { timeout: 10_000 });
    await expect(content).not.toContainText("dddd2222");
  });

  test("gym account Remote lists the connected browsers and disconnects one", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    let connected = true;
    m.get(box(HOME, "/api/screens/companion/list"), () => ({
      json: {
        companions: connected
          ? [{ tokenPrefix: "f00dcafe", redeemedAt: Date.now() - 600_000, expiresAt: Date.now() + 3 * 3_600_000, userAgent: "Firefox on Linux" }]
          : [],
      },
    }));
    m.post(box(HOME, "/api/screens/companion/revoke"), () => {
      connected = false;
      return { json: { ok: true } };
    });
    await openSettings(page);
    await page.click("#settings-tab-companion-dock");
    const content = page.locator("#companion-dock-content");
    await expect(content).toContainText("Session f00dcafe", { timeout: 10_000 });
    await expect(content).toContainText("Firefox on Linux");
    await expect(content.locator('a[target="_blank"]')).toHaveText("Open the remote page");
    await shot(page, testInfo, "remote-browsers");
    await content.locator('[data-action="revoke"][data-prefix="f00dcafe"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Disconnect remote f00dcafe…?");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Disconnected");
    expect(JSON.stringify(m.last(box(HOME, "/api/screens/companion/revoke"))!.body)).toContain("f00dcafe");
    await expect(content).toContainText("no browsers connected", { timeout: 10_000 });
  });

  test("gym account two-factor enrolment shows the secret, refuses a wrong code, saves the codes and disables", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    let type = "single";
    m.get((u) => u.pathname === "/api/users/smoketest", () => ({ json: { accountType: type, totpEnrolledAt: type === "multi" ? Date.now() : null } }));
    m.post("/totp/enroll-begin", { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Flagship:smoketest?secret=JBSWY3DPEHPK3PXP", qrPngBase64: "", issuer: "Flagship" });
    m.post("/totp/enroll-confirm", (call) => {
      if (call.body.code !== "123456") return { status: 401, json: { error: "code mismatch" } };
      type = "multi";
      return { json: { accountType: "multi", totpEnrolledAt: Date.now(), recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } };
    });
    m.post("/totp/disable", () => {
      type = "single";
      return { json: { accountType: "single" } };
    });
    await openSettings(page);
    await page.click("#settings-tab-account-security");
    const content = page.locator("#account-security-content");
    await expect(content.locator('[data-account-security-badge="single"]')).toBeVisible({ timeout: 10_000 });

    // Begin, then Cancel the staged secret.
    await page.click("#account-security-enable");
    await expect(content.locator("[data-account-security-manual-secret]")).toHaveText("JBSWY3DPEHPK3PXP", { timeout: 10_000 });
    await page.click("#account-security-cancel-enroll");
    await expect(content.locator("[data-account-security-staged]")).toHaveCount(0);

    // Begin again: an empty code, then a wrong one, then the right one.
    await page.click("#account-security-enable");
    await expect(page.locator("#account-security-verify")).toBeVisible({ timeout: 10_000 });
    await page.click("#account-security-verify");
    await expect(content.locator("[data-account-security-failed-msg]")).toContainText("Enter the 6-digit code");
    await page.fill("#account-security-sample-code", "000000");
    await page.click("#account-security-verify");
    await expect(content.locator("[data-account-security-failed-msg]")).toContainText("That code didn't match", { timeout: 10_000 });
    await shot(page, testInfo, "totp-wrong-code");
    await page.fill("#account-security-sample-code", "123456");
    await page.click("#account-security-verify");
    await expect(content.locator("[data-account-security-recovery-codes] li")).toHaveCount(2, { timeout: 10_000 });
    const confirm = m.last("/totp/enroll-confirm")!;
    expect(confirm.body.request.username).toBe("smoketest");
    expect(confirm.body.signature).toMatch(/^[0-9a-f]{128}$/);
    // Done waits for "I've saved these".
    await expect(page.locator("#account-security-done")).toBeDisabled();
    await page.check("#account-security-saved");
    await expect(page.locator("#account-security-done")).toBeEnabled();
    await shot(page, testInfo, "totp-recovery-codes");
    await page.click("#account-security-done");
    await expect(content.locator('[data-account-security-badge="multi"]')).toBeVisible({ timeout: 10_000 });
    await expect(content.locator("[data-account-security-recovery-codes]")).toHaveCount(0);

    // Disable: confirm, then the live code.
    await page.click("#account-security-disable");
    await expect(page.locator(".modal-title")).toHaveText("Disable multi-device + 2FA?");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Confirm with your 2FA code");
    await page.fill(".modal-input", "654321");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Two-factor disabled.");
    expect(m.last("/totp/disable")!.body.code).toBe("654321");
    await expect(content.locator('[data-account-security-badge="single"]')).toBeVisible({ timeout: 10_000 });
  });

  test("gym account Profiles lists each account and switches the active one", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await page.evaluate(async () => {
      const profiles = await import("/lib/profiles.js");
      profiles.addProfile({ cloudName: "work" }, { setActive: false });
    });
    await openSettings(page);
    await page.click("#settings-tab-profiles");
    const rows = page.locator("#profiles-content .profiles-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".profiles-row-active")).toHaveAttribute("data-cloud", "smoketest");
    await shot(page, testInfo, "profiles");
    await page.click('#profiles-content [data-action="switch"][data-cloud="work"]');
    await sawToast(page, "Switched to work");
    await expect(page.locator(".profiles-row-active")).toHaveAttribute("data-cloud", "work");
    expect(await page.evaluate(async () => (await import("/lib/profilesStore.js")).getActiveCloudName())).toBe("work");
    await page.click("#profiles-refresh");
    await expect(page.locator(".profiles-row-active")).toHaveAttribute("data-cloud", "work");
  });

  test("gym account Open secured sessions refreshes and stops a held session", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    const secretId = "ab".repeat(32);
    await page.evaluate(
      async ({ secretId, HOME }) => {
        const s = await import("/lib/securedSessions.js");
        s.saveSecuredSession({ secretId, serverId: HOME, serviceRef: "smoketest--notes", serviceUrl: `https://notes.${HOME}`, browserAgent: "Safari on a Mac", startedAt: Date.now() - 60_000 });
      },
      { secretId, HOME },
    );
    m.post(box(HOME, "/api/service-access/session/status"), { status: "online" });
    m.post(box(HOME, "/api/service-access/session/close"), { closed: true });
    await openSettings(page);
    await page.click("#settings-tab-secured-sessions");
    const content = page.locator("#secured-sessions-content");
    await expect(content).toContainText(`https://notes.${HOME}`);
    await expect(content).toContainText("Safari on a Mac");
    await content.locator(`[data-action="refresh"][data-secret="${secretId}"]`).click();
    await expect.poll(() => m.sent("/api/service-access/session/status").length).toBe(1);
    // The secret rides the body, never the URL.
    expect(m.last("/api/service-access/session/status")!.body.secretId).toBe(secretId);
    expect(m.last("/api/service-access/session/status")!.url.href).not.toContain(secretId);
    await shot(page, testInfo, "secured-sessions");
    await content.locator(`[data-action="stop"][data-secret="${secretId}"]`).click();
    await expect(page.locator(".modal-title")).toHaveText("Stop this session?");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Stopped");
    expect(m.sent("/api/service-access/session/close")).toHaveLength(1);
    await expect(content).toContainText("No secured sessions.");
    await page.click("#secured-sessions-refresh");
    await expect(content).toContainText("No secured sessions.");
  });

  test("gym account Trusted devices: Replace device counts down and Cancel stops it, Add device opens pairing", async ({ page }, testInfo) => {
    await noSockets(page);
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    const list = page.locator("#trusted-devices-list");
    await expect(list).toContainText("Just this device", { timeout: 10_000 });
    await page.click("#replace-device-btn");
    const sheet = page.locator("dialog.ceremony-dialog");
    await expect(sheet.locator(".modal-title")).toHaveText("Replace this device?");
    await sheet.locator("[data-primary]").click();
    await expect(sheet.locator("[data-countdown-line]")).toContainText("Replacing in");
    await expect(sheet.locator("[data-primary]")).toBeDisabled();
    await shot(page, testInfo, "replace-countdown");
    await sheet.locator("[data-cancel]").click();
    await expect(sheet).toHaveCount(0);
    const posts = m.calls.filter((c) => c.method !== "GET");
    expect(posts).toEqual([]);

    // Wipe & restart opens the same countdown; Cancel before it starts.
    await page.click("#wipe-restart-btn");
    await expect(page.locator("dialog.ceremony-dialog [data-primary]")).toBeEnabled();
    await page.locator("dialog.ceremony-dialog [data-cancel]").click();
    await expect(page.locator("dialog.ceremony-dialog")).toHaveCount(0);

    await page.click("#trusted-devices-add");
    await expect(page.locator("#view-add-device")).toBeVisible({ timeout: 10_000 });
  });

  test("gym account AI keys: Cancel, add a key with its options, the relay switch, use it and remove it", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseAccount(m);
    await openSettings(page);
    await page.click("#settings-tab-providers");
    await expect(page.locator("#view-settings")).toBeVisible();
    const stored = () =>
      page.evaluate(async () => {
        const p = await import("/providers.js");
        const { getSession } = await import("/lib/state.js");
        const s = await p.loadProviders(getSession().umk);
        return { activeId: s.activeId, entries: s.entries.map((e: Record<string, unknown>) => ({ id: e.id, provider: e.provider, label: e.label, baseUrl: e.baseUrl ?? null, defaultModel: e.defaultModel ?? null, relay: e.relay })) };
      });

    // Cancel closes the form and saves nothing.
    await page.click("#add-provider-go");
    await expect(page.locator("#add-provider-form")).toBeVisible();
    await page.click("#np-cancel");
    await expect(page.locator("#add-provider-form")).toBeHidden();
    expect((await stored()).entries).toEqual([]);

    // A key needs a label and a key.
    await page.click("#add-provider-go");
    await page.click("#np-save");
    await sawToast(page, "Label required");

    // OpenAI with a base URL, a default model, and the relay off.
    await page.selectOption("#np-provider", "openai");
    await page.fill("#np-label", "work");
    await page.fill("#np-key", "sk-gym-0123456789abcdef");
    await page.fill("#np-base", "https://proxy.example");
    await page.fill("#np-model", "gpt-gym");
    await page.uncheck("#np-relay");
    await page.click("#np-save");
    const entry = page.locator("#providers-list .provider-entry");
    await expect(entry).toHaveCount(1, { timeout: 10_000 });
    await expect(entry).toContainText("work");
    await expect(entry.locator(".pill")).toHaveText("openai");
    await expect(entry).not.toContainText("sk-gym-0123456789abcdef");
    const relay = entry.locator('[data-action="relay"]');
    await expect(relay).not.toBeChecked();
    let saved = await stored();
    expect(saved.entries).toEqual([
      expect.objectContaining({ provider: "openai", label: "work", baseUrl: "https://proxy.example", defaultModel: "gpt-gym", relay: false }),
    ]);
    await shot(page, testInfo, "ai-keys-saved");

    // The relay switch on the saved key.
    await relay.check();
    await expect.poll(async () => (await stored()).entries[0]?.relay).toBe(true);
    await expect(page.locator('#providers-list [data-action="relay"]')).toBeChecked();

    // Use it: it becomes the active provider.
    const id = saved.entries[0]!.id as string;
    await page.click(`#providers-list [data-action="set-active"][data-id="${id}"]`);
    await sawToast(page, "Active provider updated");
    await expect(page.locator(`#providers-list [data-action="set-active"][data-id="${id}"]`)).toHaveText("active");
    expect((await stored()).activeId).toBe(id);

    // Remove asks first; Cancel keeps it, OK deletes it from this device.
    await page.click(`#providers-list [data-action="remove"][data-id="${id}"]`);
    await expect(page.locator(".modal-title")).toHaveText("Remove this provider?");
    await page.click("[data-modal-cancel]");
    expect((await stored()).entries).toHaveLength(1);
    await page.click(`#providers-list [data-action="remove"][data-id="${id}"]`);
    await page.click("[data-modal-ok]");
    await expect(page.locator("#providers-list .provider-entry")).toHaveCount(0, { timeout: 10_000 });
    saved = await stored();
    expect(saved.entries).toEqual([]);
    // Keys never leave this device.
    expect(m.calls.filter((c) => JSON.stringify(c.body ?? "").includes("sk-gym-0123456789abcdef"))).toEqual([]);
  });

  test("gym account a rate-limited sign-in says who is limited and when to try again", async ({ page }, testInfo) => {
    const m = await mock(page);
    m.get("/api/account/resolve/harry", () => RATE_LIMITED_12_MIN("ip"));
    await watchToasts(page);
    await page.goto("/index.html");
    await openConnect(page);
    await page.fill("#bootstrap-username", "harry");
    await page.click("#bootstrap-continue");
    await sawToast(page, "Too many tries from your network. Try again in about 12 minutes.");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await shot(page, testInfo, "rate-limited-sign-in");
  });

  test("gym account rate-limited two-factor and Flagship Inference reads say who is limited and when", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await samePageApex(page);
    const m = await mock(page);
    baseAccount(m);
    m.get((u) => u.pathname === "/api/users/smoketest", { accountType: "single" });
    m.post("/totp/enroll-begin", { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://x", qrPngBase64: "", issuer: "Flagship" });
    m.post("/totp/enroll-confirm", () => RATE_LIMITED_12_MIN("irk"));
    m.post("/api/free-ai/status", () => ({ status: 429, json: { error: "rate-limited", limit: "irk", retryAfterSec: 30 } }));
    await openSettings(page);
    await page.click("#settings-tab-account-security");
    await page.click("#account-security-enable");
    await page.fill("#account-security-sample-code", "123456");
    await page.click("#account-security-verify");
    await expect(page.locator("[data-account-security-failed-msg]")).toHaveText(
      "Too many tries from this account. Try again in about 12 minutes.",
      { timeout: 10_000 },
    );
    await shot(page, testInfo, "rate-limited-totp");

    await page.click("#account-security-back");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#free-ai-line")).toHaveText("Too many tries from this account. Try again in a minute.", { timeout: 10_000 });
    await expect(page.locator("#free-ai-add-key")).toHaveCount(1);
    await shot(page, testInfo, "rate-limited-free-ai");
  });

  test("gym account a rate-limited account deletion keeps the account and this device's key", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    await samePageApex(page);
    const m = await mock(page);
    baseAccount(m);
    m.post("/api/account/self-delete", () => RATE_LIMITED_12_MIN("irk"));
    await openSettings(page);
    await page.click("#settings-tab-account-delete");
    await page.fill("#account-delete-confirm-input", "smoketest");
    const mark = await toastMark(page);
    await page.click("#account-delete-go");
    await expect.poll(async () => (await toasts(page)).length, { timeout: 10_000 }).toBeGreaterThan(mark);
    // The rate limiter's own sentence, and nothing local is touched: the
    // ceremony stays, the button comes back, the key stays.
    await sawToast(page, "Try again in about 12 minutes.", 15_000, mark);
    expect(m.sent("/api/account/self-delete")).toHaveLength(1);
    await expect(page.locator("#view-account-delete")).toBeVisible();
    await expect(page.locator("#account-delete-go")).toBeEnabled();
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(true);
    await shot(page, testInfo, "rate-limited-delete");
  });
});
