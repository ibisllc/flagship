/**
 * Onboarding (docs/login-and-account-redesign.md): the cover and the
 * first-run wizard, with no backend. Creating an account runs to the end:
 * the passphrase, the random handle sheet and its Try another, the two name
 * prompts and the account-open POST, whose signatures are checked here the
 * way `.com` checks them (the username claim under the IRK, the account
 * profile and device grant under the admin root it publishes, the device
 * profile under the device key, and the names only as ciphertext). Then
 * each wizard step's buttons, the sign-in paths on the cover (an unknown
 * name, a taken name's access options, a multi-device account's recovery
 * code, a demo account) and the Cancel on each prompt.
 *
 * `.com` is the gymKit router; anything it doesn't know is a 404.
 */

import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { PASSPHRASE, createAccount, mock, reachHome, sawToast, shot, toastMark, unlock, watchToasts, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const FIRST = "braveotter";
const SECOND = "quietfalcon";

/** Every relay socket stays in the page (Scan a pairing code opens one). */
async function noSockets(page: Page): Promise<void> {
  await page.routeWebSocket(/.*/, () => {});
}

/** The handle service hands out FIRST, then SECOND. */
function suggestions(m: Mock): { asked: number } {
  const state = { asked: 0 };
  m.post("/api/username/suggest", () => {
    state.asked++;
    return { json: { name: state.asked === 1 ? FIRST : SECOND, retryAfterMs: 0 } };
  });
  return state;
}

/** Cold launch → Create a new account → both passphrase prompts. */
async function passphrases(page: Page): Promise<void> {
  await watchToasts(page);
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.click("#bootstrap-create");
  await expect(page.locator(".modal-title")).toHaveText("Create your account");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
}

/** From the passphrases to an open account, taking the second handle. */
async function openNewAccount(page: Page, testInfo?: TestInfo): Promise<void> {
  await passphrases(page);
  const sheet = page.locator(".modal-card", { has: page.locator("[data-suggest-name]") });
  await expect(sheet.locator(".modal-title")).toHaveText("Your handle", { timeout: 30_000 });
  await expect(sheet.locator("[data-suggest-name]")).toHaveText(FIRST);
  await sheet.locator("[data-suggest-regen]").click();
  await expect(sheet.locator("[data-suggest-name]")).toHaveText(SECOND);
  if (testInfo) await shot(page, testInfo, "handle-sheet");
  await sheet.locator("[data-modal-ok]").click();

  await expect(page.locator(".modal-title")).toHaveText("Name this account");
  await expect(page.locator(".modal-input")).toHaveValue("Quietfalcon");
  await page.fill(".modal-input", " ");
  await page.click("[data-modal-ok]");
  await expect(page.locator("[data-modal-error]")).toHaveText("Enter an account name");
  await page.fill(".modal-input", "Our house");
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Name this device");
  await expect(page.locator(".modal-input")).toHaveValue("This browser");
  await page.fill(".modal-input", "Kitchen laptop");
  await page.click("[data-modal-ok]");
}

/** `.com`'s account-open endpoint: records the body and accepts it. */
function accountsEndpoint(m: Mock): { bodies: any[] } {
  const state = { bodies: [] as any[] };
  m.post(/\/api\/accounts$/, (call) => {
    state.bodies.push(call.body);
    return { json: { created: true } };
  });
  return state;
}

/** Check an account-open body the way `.com` does, in the page (real crypto). */
async function verifyOpenBody(page: Page, body: unknown) {
  return page.evaluate(async (body: any) => {
    const ks = await import("/keystore.js");
    const meta = await import("/lib/accountMetadata.js");
    const { getSession } = await import("/lib/state.js");
    const s = getSession();
    const hex = ks.hexToBytes;
    const enc = (t: string) => new TextEncoder().encode(t);
    const irkPub = ks.bytesToHex(s.irk.publicKey);
    const adminPub = s.adminRootSeed ? await ks.adminRootPubHex(s.adminRootSeed) : null;
    const r = body.claim.request;
    const claimOk = await ks.verifyWithEd25519Pub(
      hex(r.irkPub),
      hex(body.claim.signature),
      enc(`flagship/claim-username/v1|${r.username}|${r.irkPub}|${r.issuedAt}`),
    );
    const { signatureHex: aSig, ...aUnsigned } = body.accountProfile;
    const accountOk = await ks.verifyWithEd25519Pub(hex(body.adminRootPub), hex(aSig), meta.canonicalAccountProfile(aUnsigned));
    const accountByIrk = await ks.verifyWithEd25519Pub(hex(irkPub), hex(aSig), meta.canonicalAccountProfile(aUnsigned));
    const { signatureHex: dSig, ...dUnsigned } = body.deviceProfile;
    const deviceOk = await ks.verifyWithEd25519Pub(hex(body.device.devicePubHex), hex(dSig), meta.canonicalDeviceSelfProfile(dUnsigned));
    return {
      claimOk,
      claimUsesThisIrk: r.irkPub === irkPub,
      adminRootIsThisDevices: body.adminRootPub === adminPub,
      adminRootIsNotIrk: body.adminRootPub !== irkPub,
      accountOk,
      accountByIrk,
      accountSigner: body.accountProfile.signerPubHex === body.adminRootPub,
      deviceOk,
      grantDevice: body.grant.devicePubHex === body.device.devicePubHex,
      grantAdmin: body.grant.scopes.includes("admin"),
      grantSig: /^[0-9a-f]{128}$/.test(body.grant.signatureHex),
      sessionUsername: s.username,
    };
  }, body);
}

async function wizardTitle(page: Page) {
  return page.locator("#view-wizard .card-title");
}

/** An unlocked device with no account yet (the passphrase is set). */
async function deviceOnly(page: Page): Promise<void> {
  await createAccount(page);
  await unlock(page, "home");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 15_000 });
}

async function enterWizardAt(page: Page, stepIdx: number): Promise<void> {
  await page.evaluate(async (stepIdx) => {
    const store = await import("/lib/profilesStore.js");
    store.set("wizardState", JSON.stringify({ stepIdx, completed: [] }));
    const { enterWizard } = await import("/views/wizard.js");
    await enterWizard();
  }, stepIdx);
  await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 10_000 });
}

/** A `.com` resolution for the cover's Sign in. */
function resolution(username: string, extra: Record<string, unknown>) {
  return {
    username,
    exists: true,
    kind: "single",
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    graceModel: "3d",
    ...extra,
  };
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.fill("#bootstrap-username", username);
  await page.click("#bootstrap-continue");
}

test.describe("gym webapp onboarding", () => {
  test("gym onboarding creates an account to the end with a suggested handle and its two names", async ({ page }, testInfo) => {
    const m = await mock(page);
    const handles = suggestions(m);
    const open = accountsEndpoint(m);
    await openNewAccount(page, testInfo);

    await sawToast(page, `Account created — ${SECOND}`, 30_000);
    await expect(await wizardTitle(page)).toHaveText("Secure your account", { timeout: 15_000 });
    expect(handles.asked).toBe(2);
    expect(open.bodies).toHaveLength(1);
    const body = open.bodies[0];
    expect(body.claim.request.username).toBe(SECOND);
    expect(body.device.platformClass).toBe("web");
    // The private names reach `.com` only as ciphertext.
    expect(JSON.stringify(body)).not.toContain("Our house");
    expect(JSON.stringify(body)).not.toContain("Kitchen laptop");
    const v = await verifyOpenBody(page, body);
    expect(v).toEqual({
      claimOk: true,
      claimUsesThisIrk: true,
      adminRootIsThisDevices: true,
      adminRootIsNotIrk: true,
      accountOk: true,
      accountByIrk: false,
      accountSigner: true,
      deviceOk: true,
      grantDevice: true,
      grantAdmin: true,
      grantSig: true,
      sessionUsername: SECOND,
    });
    // This device is the account's admin device: it holds the admin root.
    const admin = await page.evaluate(async () => (await import("/lib/addServerGate.js")).canAddServers());
    expect(admin).toBe(true);
    await shot(page, testInfo, "account-opened-secure-step");
  });

  // Opening an account used to re-wrap the device key under the account's
  // keystore record with a random passphrase it then dropped, so after a
  // reload the owner's passphrase no longer opened it, and the admin root
  // stayed behind on the bootstrap record.
  test("gym onboarding a new account unlocks again with its passphrase after a reload", async ({ page }, testInfo) => {
    const m = await mock(page);
    suggestions(m);
    accountsEndpoint(m);
    await openNewAccount(page);
    await expect(await wizardTitle(page)).toHaveText("Secure your account", { timeout: 30_000 });
    // Reload: the account's key must open with the passphrase the owner chose.
    await page.goto("/index.html?view=home");
    await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 15_000 });
    const opens = await page.evaluate(async (pass) => {
      const ks = await import("/keystore.js");
      const tryOpen = async (id?: string) => {
        try {
          await (id ? ks.unlockUmk(pass, id) : ks.unlockUmk(pass));
          return true;
        } catch {
          return false;
        }
      };
      return { activeRecord: await tryOpen(), defaultRecord: await tryOpen(ks._internal.DEFAULT_PROFILE_ID) };
    }, PASSPHRASE);
    // The account's own keystore record must open with the owner's passphrase.
    expect(opens).toEqual({ activeRecord: true, defaultRecord: true });
    const mark = await toastMark(page);
    await page.fill("#unlock-passphrase", PASSPHRASE);
    await page.click("#unlock-go");
    await sawToast(page, "Unlocked", 30_000, mark);
    const who = await page.evaluate(async () => (await import("/lib/state.js")).getSession().username);
    expect(who).toBe(SECOND);
    // Still the account's admin device after the reload.
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().adminRootSeed)).toBe(true);
    await shot(page, testInfo, "account-reopened");
  });

  test("gym onboarding Cancel on the passphrase prompt or the handle sheet opens no account", async ({ page }, testInfo) => {
    const m = await mock(page);
    suggestions(m);
    const open = accountsEndpoint(m);
    await watchToasts(page);
    await page.goto("/index.html");
    await expect(page.locator("#view-bootstrap a.pill")).toHaveAttribute("href", /^https?:\/\//);
    // Cancel at the first prompt: still on the cover, no key made.
    await page.click("#bootstrap-create");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(false);

    // A too-short passphrase is refused in the prompt; a mismatch in the second.
    await page.click("#bootstrap-create");
    await page.fill(".modal-input", "short");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("8+ characters");
    await page.fill(".modal-input", PASSPHRASE);
    await page.click("[data-modal-ok]");
    await page.fill(".modal-input", `${PASSPHRASE}x`);
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("passphrases don't match");
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#view-bootstrap")).toBeVisible();

    // Cancel on the handle sheet: no account is opened, and the key the
    // sign-up just made is dropped, so the next load shows the cover again.
    await passphrases(page);
    const sheet = page.locator(".modal-card", { has: page.locator("[data-suggest-name]") });
    await expect(sheet.locator("[data-suggest-name]")).toHaveText(FIRST, { timeout: 30_000 });
    await shot(page, testInfo, "handle-sheet-cancel");
    await sheet.locator("[data-modal-cancel]").click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    expect(open.bodies).toHaveLength(0);
    await expect.poll(() => page.evaluate(async () => {
      const ks = await import("/keystore.js");
      try {
        await ks.unlockUmk("x".repeat(8));
        return true;
      } catch (e) {
        return !/no identity/.test(String((e as Error).message));
      }
    })).toBe(false);
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(false);

    // Cancel at "Name this device": still nothing opened, no key left.
    await passphrases(page);
    await expect(sheet.locator("[data-suggest-name]")).toBeVisible({ timeout: 30_000 });
    await sheet.locator("[data-modal-ok]").click();
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Name this device");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    expect(open.bodies).toHaveLength(0);
    await expect.poll(() => page.evaluate(async () => {
      const ks = await import("/keystore.js");
      try {
        await ks.unlockUmk("x".repeat(8));
        return true;
      } catch (e) {
        return !/no identity/.test(String((e as Error).message));
      }
    })).toBe(false);
  });

  test("gym onboarding the secure step's Skip asks first, then each later step skips to Home", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    m.get("/api/users/", { pods: [] });
    await enterWizardAt(page, 2);
    await expect(await wizardTitle(page)).toHaveText("Secure your account");
    // Chromium has passkeys, so the cloud option is offered and pre-chosen.
    await expect(page.locator("#wizard-secure-cloud")).toBeChecked();
    await page.locator("#wizard-secure-file").check();
    await expect(page.locator("#wizard-secure-cloud")).not.toBeChecked();
    await page.locator("#wizard-secure-cloud").check();
    await expect(page.locator("#wizard-secure-file")).not.toBeChecked();
    await shot(page, testInfo, "wizard-secure");

    // Skip asks first; Back stays on the step.
    await page.click("#wizard-secure-skip");
    await expect(page.locator(".modal-title")).toHaveText("Skip backup?");
    await page.click("[data-modal-cancel]");
    await expect(await wizardTitle(page)).toHaveText("Secure your account");
    await page.click("#wizard-secure-skip");
    await expect(page.locator("[data-modal-ok]")).toHaveText("Skip anyway");
    await page.click("[data-modal-ok]");

    await expect(await wizardTitle(page)).toHaveText("Set recovery passphrase");
    await page.click("#wizard-skip-recovery");
    await expect(await wizardTitle(page)).toHaveText("Cloud recovery (WebAuthn)");
    await page.click("#wizard-skip-recovery");
    await expect(await wizardTitle(page)).toHaveText("Add your first server");
    await page.click("#wizard-skip-create-server");
    await expect(await wizardTitle(page)).toHaveText("Help others (peer-backup)");
    await page.click("#wizard-pb-later");
    await expect(await wizardTitle(page)).toHaveText("Try a demo app");
    await shot(page, testInfo, "wizard-finish");
    await page.click("#wizard-skip-demo");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

    const kept = await page.evaluate(async () => {
      const store = await import("/lib/profilesStore.js");
      return { warn: store.get("recoveryWarn"), pb: store.get("peerBackupChoice") };
    });
    // Skipping the backup leaves Home's reminder on; "Maybe later" records no "no".
    expect(kept).toEqual({ warn: "true", pb: "deferred" });
  });

  test("gym onboarding the secure step's backup file runs the key file ceremony and advances", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    await mock(page);
    await enterWizardAt(page, 2);
    await page.locator("#wizard-secure-file").check();
    await page.click("#wizard-secure-continue");
    const card = page.locator(".modal-card");
    await expect(card.locator("[data-pass1]")).toBeVisible({ timeout: 10_000 });
    const BACKUP_PASS = "Gym-Backup-Passphrase-2026!";
    await card.locator("[data-pass1]").fill(BACKUP_PASS);
    await card.locator("[data-pass2]").fill(BACKUP_PASS);
    const acks = card.locator("[data-ack]");
    for (let i = 0; i < (await acks.count()); i++) await acks.nth(i).check();
    await expect(card.locator("[data-ok]")).toBeEnabled({ timeout: 5_000 });
    await shot(page, testInfo, "wizard-keyfile-ceremony");
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await card.locator("[data-ok]").click();
    expect((await download).suggestedFilename()).toMatch(/\.(flagshipkey|json)$/);
    // The backup exists, so the step is done and no reminder is pinned.
    await expect(await wizardTitle(page)).toHaveText("Set recovery passphrase", { timeout: 30_000 });
    const warn = await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("recoveryWarn"));
    expect(warn ?? null).toBeNull();
  });

  test("gym onboarding Set up recovery, Add a server, peer-backup Enable and No thanks open their screens", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    m.get("/api/users/", { pods: [] });
    // Set up recovery → the Recovery screen.
    await enterWizardAt(page, 3);
    await page.click("#wizard-go-recovery");
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });

    // Add a server → the create form (this device holds the account's admin root).
    await enterWizardAt(page, 5);
    await expect(await wizardTitle(page)).toHaveText("Add your first server");
    await page.click("#wizard-go-create-server");
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "wizard-add-server");

    // Peer-backup: Enable opens its screen and records the choice; No thanks records "declined".
    await enterWizardAt(page, 6);
    await page.click("#wizard-pb-enable");
    await expect(page.locator("#view-peer-backup")).toBeVisible({ timeout: 10_000 });
    expect(await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("peerBackupChoice"))).toBe("enabled");
    await enterWizardAt(page, 6);
    await page.click("#wizard-pb-decline");
    await expect(await wizardTitle(page)).toHaveText("Try a demo app");
    expect(await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("peerBackupChoice"))).toBe("declined");
  });

  test("gym onboarding the username step refuses a bad name, shows a taken one with the trademark link, then opens the account", async ({ page }, testInfo) => {
    await deviceOnly(page);
    const m = await mock(page);
    const open = accountsEndpoint(m);
    m.post("/api/users/check", (call) => ({ json: { username: call.body.username, available: call.body.username !== "taken" } }));

    // Step 1 (device key) moves on to the username step.
    await enterWizardAt(page, 0);
    await expect(await wizardTitle(page)).toHaveText("Generate device key");
    await page.click("#wizard-go-bootstrap");
    await expect(await wizardTitle(page)).toHaveText("Open your account", { timeout: 10_000 });

    await page.fill("#wizard-username-input", "AB");
    await page.click("#wizard-go-username");
    await sawToast(page, "Username must be 3–30 lowercase letters");
    expect(open.bodies).toHaveLength(0);

    await page.fill("#wizard-username-input", "taken");
    await page.click("#wizard-go-username");
    const takenPanel = page.locator("#wizard-username-taken");
    await expect(takenPanel).toContainText("The name taken is already taken. Try another.");
    await expect(page.locator("#wizard-trademark-claim")).toHaveAttribute("href", /^mailto:.*taken/);
    await shot(page, testInfo, "wizard-username-taken");
    expect(open.bodies).toHaveLength(0);

    await page.fill("#wizard-username-input", "ourhouse");
    await page.click("#wizard-go-username");
    await expect(takenPanel).toBeHidden();
    await expect(page.locator(".modal-title")).toHaveText("Name this account");
    await expect(page.locator(".modal-input")).toHaveValue("Ourhouse");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Name this device");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Account opened — ourhouse", 30_000);
    await expect(await wizardTitle(page)).toHaveText("Secure your account");
    expect(open.bodies).toHaveLength(1);
    const v = await verifyOpenBody(page, open.bodies[0]);
    expect(v.claimOk && v.accountOk && v.deviceOk && v.adminRootIsThisDevices && !v.accountByIrk).toBe(true);
  });

  test("gym onboarding signing in: an unknown name, a taken name's access options, and a pairing code", async ({ page }, testInfo) => {
    await noSockets(page);
    const m = await mock(page);
    m.get("/api/account/resolve/nobodyhere", { username: "nobodyhere", exists: false, kind: "unknown", recovery: { present: false } });
    m.get("/api/account/resolve/harry", resolution("harry", {}));
    await watchToasts(page);
    await page.goto("/index.html");

    // A malformed name is refused before any lookup, from Enter as from the button.
    await page.fill("#bootstrap-username", "AB");
    await page.press("#bootstrap-username", "Enter");
    await sawToast(page, "Username: 3–30 lowercase letters/digits");
    expect(m.sent("/api/account/resolve", "GET")).toHaveLength(0);

    await signIn(page, "nobodyhere");
    await expect(page.locator(".modal-title")).toHaveText("No account by that name");
    await expect(page.locator(".modal-message")).toContainText('couldn\'t find an account called "nobodyhere"');
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    await expect(page.locator("#bootstrap-access")).toBeHidden();

    // A taken name offers the ways back in; without cloud recovery the passkey is off and says why.
    await signIn(page, "harry");
    const access = page.locator("#bootstrap-access");
    await expect(access).toContainText('"harry" already exists');
    await expect(access.locator('[data-access="recover"]')).toBeDisabled();
    await expect(access).toContainText("No cloud recovery is set up on this account.");
    await shot(page, testInfo, "signin-access-options");

    // Scan a pairing code: Cancel does nothing; a link opens the join screen.
    await access.locator('[data-access="scan"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Scan a pairing code");
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await access.locator('[data-access="scan"]').click();
    await page.fill(".modal-input", `https://flagshipserver.com/join?sid=${"ab".repeat(16)}&pk=${"cd".repeat(32)}`);
    await page.click("[data-modal-ok]");
    await expect(page.locator("#view-join")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#join-confirm")).toBeDisabled();

    // Import a key file → the Recovery screen.
    await page.goto("/index.html");
    await signIn(page, "harry");
    await page.locator('#bootstrap-access [data-access="keyfile"]').click();
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
  });

  test("gym onboarding a multi-device account asks for a recovery code before taking over, and Cancel sends nothing", async ({ page }, testInfo) => {
    const m = await mock(page);
    m.get("/api/account/resolve/harry", resolution("harry", { kind: "multi", recovery: { present: true, hasFetchGate: true }, graceModel: "24h" }));
    await watchToasts(page);
    await page.goto("/index.html");
    await signIn(page, "harry");
    const recover = page.locator('#bootstrap-access [data-access="recover"]');
    await expect(recover).toBeEnabled();

    // The take-over explainer: Cancel stops there.
    await recover.click();
    await expect(page.locator(".modal-title")).toHaveText("Take over this account (2FA)");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);

    // Take over → the recovery code, required for a multi-device account.
    await recover.click();
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Recovery code");
    await expect(page.locator(".modal-message")).toContainText("This account requires a second factor.");
    await shot(page, testInfo, "signin-recovery-code");
    await page.fill(".modal-input", " ");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("enter a 6-digit code or a recovery code");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    // Nothing reached `.com` beyond the lookup.
    expect(m.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(false);
  });

  test("gym onboarding signing in to a demo account joins it and lands on Home", async ({ page }, testInfo) => {
    const m = await mock(page);
    const DEMO = "home.gymdemo.flagship.services";
    m.get("/api/account/resolve/gymdemo", resolution("gymdemo", {
      kind: "demo",
      demoServer: { fqdn: DEMO, status: "up", phase: "live" },
    }));
    m.get("/api/users/gymdemo/pods", { pods: [{ serverDomain: DEMO, liveness: "live" }] });
    await watchToasts(page);
    await page.goto("/index.html");
    await signIn(page, "gymdemo");
    await sawToast(page, "Joined gymdemo", 30_000);
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 15_000 });
    const who = await page.evaluate(async () => {
      const profiles = await import("/lib/profiles.js");
      const p = profiles.getActiveProfile();
      return { user: (await import("/lib/state.js")).getSession().username, demo: p?.demoServer?.fqdn ?? null };
    });
    expect(who).toEqual({ user: "gymdemo", demo: DEMO });
    // No account is opened or claimed for a demo.
    expect(m.sent(/\/api\/(accounts|username\/claim)$/)).toEqual([]);
    await shot(page, testInfo, "signin-demo-home");
  });
});
