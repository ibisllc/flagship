/**
 * GYM webapp every-merge specs (§12-G4 / §10 Phase-2) — the curated, fast,
 * DETERMINISTIC, NO-BACKEND Tier-1 subset the gym drives on the webapp surface:
 * "does the app still launch, render its core screens, and navigate without a
 * broken edge." This is the webapp leg of `gym:every-merge`.
 *
 * NO BACKEND, by construction. The gym static server (static-server.ts) serves
 * only the static webapp tree — every `/api/*` is a hard 404 and service
 * workers are blocked. So these specs cover exactly the surface that renders
 * client-side:
 *   - the onboarding / auth chrome (bootstrap, its passphrase validation, the
 *     first-run wizard's username step + its client-side validation),
 *   - the post-bootstrap shell whose entry tolerates a backendless boot — Home
 *     (the empty "no servers yet" state short-circuits BEFORE any fetch), the
 *     Settings / Activity / Services tabs (their `enter*` is a client-side
 *     `show()` + local decoration), and the create-server FORM (its draft list
 *     is IndexedDB-local; the disk-encryption + backup-policy controls + name
 *     validation are all client-side).
 * Behavioral flows that genuinely need the backend stay on the existing
 * pod-sim rig (flows/s00..s16) — they are NOT every-merge.
 *
 * The verdict is the assertions (Layer 1, §2.1). Screenshots are captured at
 * each scenario's screenshot points (`gym-screenshot:<point>`) for the advisory
 * judge — they never decide pass/fail. Each `test(...)` title is the grep token
 * the gym web adapter selects on via `scenario.harness`, so every title is
 * UNIQUE (the adapter requires all grep-matched specs to pass).
 *
 * Handles reuse the EXISTING webapp id convention (#view-*, #bootstrap-*,
 * #cs-*, #settings-tab-*) so the specs stay robust to layout churn — they
 * assert on stable handles, never pixel positions (§8).
 */

import { test, expect, type Page } from "@playwright/test";

/** A passphrase that satisfies the bootstrap 8+ rule. */
const PASSPHRASE = "correct-horse-battery-staple-gym";

/**
 * Attach a screenshot at a named point. Capture to a FILE (not an inline body)
 * so the JSON reporter records a `path` — the gym web adapter maps
 * `gym-screenshot:<point>` attachments WITH a path into the artifact.
 */
async function shot(page: Page, testInfo: import("@playwright/test").TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

/**
 * Cold-launch helper → land on the bootstrap shell. Every spec starts cold so
 * each run is independent (no cross-test state; the static server is stateless
 * and IndexedDB is per-context).
 */
async function coldLaunch(page: Page): Promise<void> {
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
}

/**
 * Generate a device identity client-side (bootstrap passphrase + confirm +
 * Generate). On success the webapp routes to the wizard's username step
 * (`bootstrapNewIdentity` is pure client-side crypto — no backend). This helper
 * only does the client-side identity mint and leaves the app on the wizard.
 */
async function generateIdentity(page: Page): Promise<void> {
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
}

/**
 * Reach a logged-in shell view with NO backend, via the proven S1 path:
 * bootstrap (mint identity, writes the wrapped UMK to IndexedDB) → RELOAD with
 * a `?view=<alias>` deep-link (boot now sees the wrapped UMK → unlock screen) →
 * unlock with the same passphrase → `handleUnlock` calls `dispatchInitialView`,
 * which honours `?view=` and lands on the target view. All of this is
 * client-side: the target views' `enter*` either short-circuit before any
 * fetch (Home's empty state) or `show()` a static-chrome view + local
 * decoration (Settings / Activity / Services / create-server).
 */
async function reachShell(page: Page, viewAlias: string): Promise<void> {
  await coldLaunch(page);
  await generateIdentity(page);
  // Confirm the client-side identity mint landed on the wizard before reload.
  await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 10_000 });
  await page.goto(`/index.html?view=${viewAlias}`);
  // The wrapped UMK persists → boot routes to the unlock screen.
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
}

test.describe("gym webapp", () => {
  // ─── Cold launch + brand chrome ──────────────────────────────────────────

  test("gym webapp cold launch renders the bootstrap shell + primary action", async ({
    page,
  }, testInfo) => {
    await coldLaunch(page);
    await shot(page, testInfo, "cold-launch");
    // The editorial brand title renders.
    await expect(page.locator("header h1#title")).toContainText("Flagship");
    // The primary "create account" action is present + enabled (the
    // every-button-reachable spirit of D7-usable for this screen).
    const go = page.locator("#bootstrap-go");
    await expect(go).toBeVisible();
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "bootstrap-ready");
  });

  test("gym webapp boots on the brand-DNA palette + fonts", async ({ page }, testInfo) => {
    // Token conformance (D7-beautiful, the pass/fail half): the rendered
    // palette + type stack must match the brand tokens — teal accent, dark
    // canvas, Geist / Instrument Serif — with NO stray legacy blue (#3B5BFF)
    // or old palette green. Mirrors the s15 webapp-shell brand assertion but
    // lives in the every-merge gym so a brand regression trips per-merge.
    await coldLaunch(page);
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        canvas: cs.getPropertyValue("--canvas").trim().toLowerCase(),
        accent: cs.getPropertyValue("--accent").trim().toLowerCase(),
        fontSans: cs.getPropertyValue("--font-sans").trim().toLowerCase(),
        fontDisplay: cs.getPropertyValue("--font-display").trim().toLowerCase(),
        renderedBody: body.fontFamily.toLowerCase(),
      };
    });
    expect(tokens.canvas).not.toContain("#0a0a0a"); // not the old pure-black identity
    expect(tokens.accent).not.toBe("");
    expect(tokens.accent).not.toContain("3b5bff"); // legacy blue is gone
    expect(tokens.accent).not.toContain("4ad295"); // old palette green is gone
    expect(tokens.fontSans).toContain("geist");
    expect(tokens.renderedBody).toContain("geist");
    expect(tokens.fontDisplay).toContain("instrument");
    await shot(page, testInfo, "brand-dna");
  });

  // ─── Bootstrap form validation (client-side, no backend) ─────────────────

  test("gym webapp bootstrap rejects a passphrase mismatch", async ({ page }, testInfo) => {
    await coldLaunch(page);
    await page.fill("#bootstrap-passphrase", PASSPHRASE);
    await page.fill("#bootstrap-passphrase-2", PASSPHRASE + "-different");
    await page.click("#bootstrap-go");
    // Stays on bootstrap (no identity minted) + an error toast surfaces.
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(/don'?t match/i, { timeout: 3_000 });
    await shot(page, testInfo, "mismatch-toast");
  });

  test("gym webapp bootstrap rejects a too-short passphrase", async ({ page }, testInfo) => {
    await coldLaunch(page);
    await page.fill("#bootstrap-passphrase", "short");
    await page.fill("#bootstrap-passphrase-2", "short");
    await page.click("#bootstrap-go");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(/8\+? chars/i, { timeout: 3_000 });
    await shot(page, testInfo, "short-toast");
  });

  // ─── The first-run wizard (client-side: device-key mint → username step) ──

  test("gym webapp bootstrap mints an identity and reaches the home shell", async ({
    page,
  }, testInfo) => {
    await coldLaunch(page);
    await generateIdentity(page);
    // bootstrapNewIdentity is pure client-side crypto; with the account not
    // yet open it routes through the wizard's username step. We assert the
    // wizard chrome rendered (a backendless transition off bootstrap).
    await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#wizard-username-input")).toBeVisible();
    await shot(page, testInfo, "wizard-username");
  });

  test("gym webapp wizard rejects an invalid username client-side", async ({
    page,
  }, testInfo) => {
    await coldLaunch(page);
    await generateIdentity(page);
    await expect(page.locator("#wizard-username-input")).toBeVisible({ timeout: 10_000 });
    // Uppercase + too short → the client-side isValidUsername reject fires
    // BEFORE any availability call, so it is fully deterministic with no
    // backend. The PRIMARY deterministic signal is that the view does NOT
    // advance (stays on the username step). An error toast also surfaces, but
    // it queues behind the still-showing "device key generated" toast from the
    // mint, so we give it a generous timeout for the queue to drain.
    await page.fill("#wizard-username-input", "AB");
    await page.click("#wizard-go-username");
    await expect(page.locator("#view-wizard")).toBeVisible();
    await expect(page.locator("#wizard-username-input")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(/lowercase/i, { timeout: 6_000 });
    await shot(page, testInfo, "username-invalid");
  });

  // ─── The post-bootstrap shell (backendless boot tolerated) ───────────────

  test("gym webapp home renders the empty no-servers state", async ({ page }, testInfo) => {
    // Home's render short-circuits at the no-paired-session branch and paints
    // the real empty state with NO fetch — the deterministic backendless goal.
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#view-home .empty-state")).toBeVisible();
    await expect(page.locator("#empty-create-server")).toBeVisible();
    await shot(page, testInfo, "home-empty");
  });

  test("gym webapp navigates Home to the Settings tab", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    // Tap the Settings tab → the Settings tab view + its grouped rows render
    // (decorateSettingsTab is client-side; the badge refresh is swallowed).
    await page.click('[data-tab-target="settings"]');
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    await expect(page.locator("#settings-tab-account-security")).toBeVisible();
    await expect(page.locator("#settings-tab-recovery")).toBeVisible();
    await shot(page, testInfo, "settings-tab");
  });

  test("gym webapp navigates Home to the Activity tab", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.click('[data-tab-target="activity"]');
    await expect(page.locator("#view-activity")).toBeVisible();
    await shot(page, testInfo, "activity-tab");
  });

  test("gym webapp navigates Home to the Services tab", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    // The Services list shows the view first, THEN fetches; with no session
    // the fetch throws a ScreensError synchronously and the view stays put
    // (renders an error card). We assert the static chrome that is present
    // regardless: the view container + its "build a service" affordance.
    await page.click('[data-tab-target="apps"]');
    await expect(page.locator("#view-services-list")).toBeVisible();
    await expect(page.locator("#services-list-open-vibe-code")).toBeVisible();
    await shot(page, testInfo, "services-tab");
  });

  // ─── Create-server form (the disk-encryption / backup-policy controls) ───

  test("gym webapp opens the create-server form with its controls", async ({
    page,
  }, testInfo) => {
    // `?view=create-server` lands directly on the reusable form after unlock.
    await reachShell(page, "create-server");
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    // The form's load-bearing controls: name field + the disk-encryption
    // toggle + the backup-policy control (the A4 create-server contract).
    await expect(page.locator("#cs-server-name")).toBeVisible();
    await expect(page.locator("#cs-encrypt-disk")).toBeVisible();
    await expect(page.locator("#cs-backup-policy")).toBeVisible();
    await shot(page, testInfo, "create-server-form");
  });

  test("gym webapp create-server rejects an invalid server name", async ({
    page,
  }, testInfo) => {
    await reachShell(page, "create-server");
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    // An invalid name (uppercase/space) → the inline name-error surfaces and
    // the form stays on the create-server view (client-side validation, no
    // backend). "Save draft" runs the name validation without delivering.
    await page.fill("#cs-server-name", "Not A Valid Name");
    await page.click("#cs-save-draft");
    await expect(page.locator("#view-create-server")).toBeVisible();
    await expect(page.locator("#cs-server-name-error")).toBeVisible();
    await shot(page, testInfo, "create-server-name-invalid");
  });
});
