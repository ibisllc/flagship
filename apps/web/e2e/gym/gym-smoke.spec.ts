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
  // The cover is username-first now; "Create a new account" opens an inline
  // passphrase prompt + confirm, then mints the device identity client-side
  // (bootstrapNewIdentity + unlockSession persist the wrapped UMK to IndexedDB)
  // BEFORE the random-handle suggestion fetch. In the backendless gym that
  // /api/username/suggest 404s → an error toast — but the identity is already
  // persisted, so a reload→unlock (reachShell) still works.
  await page.click("#bootstrap-create");
  await expect(page.locator(".modal-title")).toHaveText("Create your account");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  // The suggestion fetch fails (no backend) → toast; waiting for it guarantees
  // the async mint has already landed before any reload.
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
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
  // generateIdentity already waited for the post-mint toast, so the wrapped UMK
  // is persisted; reload with the deep-link → boot sees it → unlock screen.
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
    // The username-first cover: the typed-name field + the primary "create a
    // new account" action are present + enabled (the every-button-reachable
    // spirit of D7-usable for this screen).
    await expect(page.locator("#bootstrap-username")).toBeVisible();
    const go = page.locator("#bootstrap-create");
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
    // The passphrase moved off the cover into the create-account modals: the
    // confirm step's inline validator rejects a mismatch (no identity minted).
    await page.click("#bootstrap-create");
    await expect(page.locator(".modal-title")).toHaveText("Create your account");
    await page.fill(".modal-input", PASSPHRASE);
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
    await page.fill(".modal-input", PASSPHRASE + "-different");
    await page.click("[data-modal-ok]");
    // Stays in the confirm modal with the mismatch error — nothing minted.
    await expect(page.locator("[data-modal-error]")).toContainText(/don'?t match/i);
    await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
    await shot(page, testInfo, "mismatch-toast");
  });

  test("gym webapp bootstrap rejects a too-short passphrase", async ({ page }, testInfo) => {
    await coldLaunch(page);
    // The first create-account modal's inline validator rejects a < 8-char
    // passphrase and stays open (no identity minted).
    await page.click("#bootstrap-create");
    await expect(page.locator(".modal-title")).toHaveText("Create your account");
    await page.fill(".modal-input", "short");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toContainText(/8\+? char/i);
    await expect(page.locator(".modal-title")).toHaveText("Create your account");
    await shot(page, testInfo, "short-toast");
  });

  // ─── Create-account mint + the username-first cover validation ───────────

  test("gym webapp bootstrap mints an identity and reaches the home shell", async ({
    page,
  }, testInfo) => {
    // The create flow mints the device identity client-side (the random-handle
    // suggestion 404s with no backend, but the wrapped UMK is persisted), so a
    // reload→unlock reaches the real Home shell — a backendless full round-trip.
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "home-reached");
  });

  test("gym webapp wizard rejects an invalid username client-side", async ({
    page,
  }, testInfo) => {
    // Username typing now lives on the username-first cover (the typed
    // create-screen + wizard username step were removed). The cover's sign-in
    // path validates client-side BEFORE any directory call, so an invalid
    // handle is rejected with no backend: stays on the cover + an error toast.
    await coldLaunch(page);
    await page.fill("#bootstrap-username", "AB"); // uppercase + too short
    await page.click("#bootstrap-continue");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
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
