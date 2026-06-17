/**
 * GYM webapp TOTAL-gym Tier-1 tranche (§12-G5 / §6 matrix) — the higher-value,
 * fixture-feasible, DETERMINISTIC, NO-BACKEND scenarios that go BEYOND the
 * every-merge subset (`gym-smoke.spec.ts`) into the §6 dimensions the webapp
 * can render + assert client-side with NO backend:
 *
 *   - D2 build modes (screens render): the build chooser; the AI-key step
 *     (BuildKeyScreen renders backendless — keys are device-local IndexedDB).
 *     (Git / MCP / journal / vibe-code hard-fetch the daemon → covered live in
 *     G6, not here. Marketplace is on feat/marketplace — absent on main.)
 *   - D3 settings: session-tiers + the recovery grey-out gating + the "set up
 *     recovery" toast on a greyed tap; the AI-keys manager (providers); the
 *     recovery screen.
 *   - D4 security: the webapp PIN lock (set / validate / set+unlock roundtrip —
 *     E3, webapp-only); the maintainer-trust red sliver (E7, seeded via the
 *     client-side store); the active-operations teal sliver (D5-F11/F12).
 *   - D7 (light): a "primary action present + enabled/disabled per state" check
 *     on the PIN-set form (Save rejects a mismatch).
 *
 * NO BACKEND, by construction. The gym static server serves only the static
 * webapp tree — every `/api/*` is a hard 404, SW blocked. So these specs cover
 * EXACTLY the surface that renders client-side: the build chooser + AI-key step
 * (IndexedDB), the settings session-tier cluster (the recovery probe fails
 * closed → greyed, which is the assertion), the PIN lock (IndexedDB + WebCrypto,
 * fully client-side), and the two slivers (in-memory stores seeded via the
 * served ES modules through `page.evaluate`). Behavioral flows that genuinely
 * need the backend (server-detail, git/mcp/journal build, account-security
 * status) stay on the pod-sim rig (s00..s16) or land in the live slice (G6).
 *
 * The verdict is the assertions (Layer 1, §2.1). Screenshots are captured at
 * each scenario's screenshot points (`gym-screenshot:<point>`) for the advisory
 * judge — they never decide pass/fail. Each `test(...)` title is the grep token
 * the gym web adapter selects on via `scenario.harness`, so every title is
 * UNIQUE. Handles reuse the EXISTING webapp id convention (§8).
 */

import { test, expect, type Page } from "@playwright/test";

/** A passphrase that satisfies the bootstrap 8+ rule. */
const PASSPHRASE = "correct-horse-battery-staple-gym";

async function shot(page: Page, testInfo: import("@playwright/test").TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

async function coldLaunch(page: Page): Promise<void> {
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
}

async function generateIdentity(page: Page): Promise<void> {
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
}

/**
 * Reach a logged-in shell view with NO backend, via the proven S1 path:
 * bootstrap (mint identity → wrapped UMK to IndexedDB) → RELOAD with
 * `?view=<alias>` → unlock with the passphrase → land on the target view.
 * After this the session holds the in-memory UMK, so device-local stores
 * (providers IndexedDB, PIN WebCrypto) work, and the slivers' unlocked
 * resolver returns true.
 */
async function reachShell(page: Page, viewAlias: string): Promise<void> {
  await coldLaunch(page);
  await generateIdentity(page);
  await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 10_000 });
  await page.goto(`/index.html?view=${viewAlias}`);
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
}

/** Reach Home → the Settings TAB (the row-nav landing). */
async function reachSettingsTab(page: Page): Promise<void> {
  await reachShell(page, "home");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
}

/** Reach the Settings DETAIL page (`#view-settings`) — the providers (AI-keys)
 *  section + the session-tier cluster (PIN lock / passkey-lock / remove-device)
 *  live here, reached from the tab's "AI providers" row. `renderProviders()`
 *  runs on entry, which is what greys the recovery-gated session actions. */
async function reachSettingsDetail(page: Page): Promise<void> {
  await reachSettingsTab(page);
  await page.click("#settings-tab-providers");
  await expect(page.locator("#view-settings")).toBeVisible({ timeout: 10_000 });
}

test.describe("gym webapp total", () => {
  // ─── D2 — build-a-service modes (render client-side) ─────────────────────

  test("gym total webapp build chooser shows the on-main source tiles", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    // Services tab → the build-a-service affordance opens the chooser.
    await page.click('[data-tab-target="apps"]');
    await expect(page.locator("#view-services-list")).toBeVisible();
    await page.click("#services-list-open-vibe-code");
    await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
    // The three on-main source tiles (marketplace ships on feat/marketplace).
    await expect(page.locator("#build-src-scratch")).toBeVisible();
    await expect(page.locator("#build-src-git")).toBeVisible();
    await expect(page.locator("#build-src-mcp")).toBeVisible();
    await shot(page, testInfo, "build-chooser");
  });

  test("gym total webapp scratch routes through the AI-key step", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.click('[data-tab-target="apps"]');
    await page.click("#services-list-open-vibe-code");
    await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
    // Scratch → the reusable AI-key step (renders backendless; keys are
    // device-local). With no saved keys it shows the placeholder + the
    // use-a-different-key affordance.
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-key-saved")).toContainText(/no saved keys/i, { timeout: 5_000 });
    await expect(page.locator("#build-key-different")).toBeVisible();
    await shot(page, testInfo, "build-key");
  });

  // ─── D3 — settings: session tiers + grey-out gating ──────────────────────

  test("gym total webapp settings greys the recovery-gated session actions", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    // The tier-1 PIN lock is always available.
    await expect(page.locator("#settings-pin-lock")).toBeVisible();
    // Tiers 2+3 are greyed until recovery is enrolled. With no backend the
    // recovery probe fails closed → not-enrolled → both carry `gated`.
    await expect(page.locator("#settings-signout")).toHaveClass(/gated/, { timeout: 10_000 });
    await expect(page.locator("#settings-reset")).toHaveClass(/gated/);
    await shot(page, testInfo, "session-tiers-gated");
  });

  test("gym total webapp a greyed session action shows the set-up-recovery toast", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    await expect(page.locator("#settings-signout")).toHaveClass(/gated/, { timeout: 10_000 });
    // Tapping the greyed tier-2 action does NOT run the destructive path; it
    // surfaces a toast routing the user to recovery enrollment.
    await page.click("#settings-signout");
    await expect(page.locator("#toast")).toContainText(/set up account recovery/i, { timeout: 5_000 });
    // It must NOT have left the settings detail page (the wipe never ran).
    await expect(page.locator("#view-settings")).toBeVisible();
    await shot(page, testInfo, "recovery-toast");
  });

  // ─── D3 — AI-keys manager + recovery screen ──────────────────────────────

  test("gym total webapp settings renders the AI-keys manager", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    // The providers (AI-keys) section renders inline on the settings detail; with
    // the in-memory UMK the list renders (empty + the free-credits CTA) and the
    // Add-provider affordance is present (never displays a full key). D3-C2.
    await expect(page.locator("#providers-list")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#add-provider-go")).toBeVisible();
    await shot(page, testInfo, "ai-keys");
  });

  test("gym total webapp settings opens the recovery screen", async ({ page }, testInfo) => {
    await reachSettingsTab(page);
    // The recovery row (on the settings TAB) routes to the recovery view, which
    // renders its static chrome backendless (the keyfile export + cloud-setup
    // affordances); the cloud-status refresh is async + swallowed. D3-C4/C17.
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#recovery-keyfile-export")).toBeVisible();
    await shot(page, testInfo, "recovery");
  });

  // ─── D4 — the webapp PIN lock (E3) ───────────────────────────────────────

  test("gym total webapp PIN-set rejects a mismatch then accepts a valid PIN", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    // Tier-1 PIN lock → first-time set screen (no backend; WebCrypto + IndexedDB).
    await page.click("#settings-pin-lock");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    // D7-light: a mismatch is rejected client-side (Save surfaces the inline
    // error and stays on the set screen — the primary action validates).
    await page.fill("#pin-set-input", "1234");
    await page.fill("#pin-set-confirm", "5678");
    await page.click("#pin-set-go");
    await expect(page.locator("#view-pin-set")).toBeVisible();
    await expect(page.locator("#pin-set-error")).toBeVisible({ timeout: 5_000 });
    await shot(page, testInfo, "pin-set-mismatch");
    // A matching PIN is accepted → it locks to the PIN-unlock screen.
    await page.fill("#pin-set-input", "1234");
    await page.fill("#pin-set-confirm", "1234");
    await page.click("#pin-set-go");
    await expect(page.locator("#view-pin-unlock")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "pin-locked");
  });

  test("gym total webapp PIN set then unlock returns to the shell", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    await page.click("#settings-pin-lock");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    await page.fill("#pin-set-input", "4242");
    await page.fill("#pin-set-confirm", "4242");
    await page.click("#pin-set-go");
    // Locked to the PIN screen; unlocking with the same PIN restores the shell.
    await expect(page.locator("#view-pin-unlock")).toBeVisible({ timeout: 10_000 });
    await page.fill("#pin-unlock-input", "4242");
    await page.click("#pin-unlock-go");
    // After a successful PIN unlock the app leaves the lock screen (the unlock
    // view is hidden — the shell/home is shown). E3 roundtrip.
    await expect(page.locator("#view-pin-unlock")).toBeHidden({ timeout: 10_000 });
    await shot(page, testInfo, "pin-unlocked");
  });

  // ─── D4/D5 — the global slivers (seeded client-side) ─────────────────────

  test("gym total webapp the maintainer-trust red sliver renders an untrusted verdict", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    // Seed a positively-untrusted control-server verdict directly on the
    // client-side trust store (the in-memory ServerTrustStore the sliver reads),
    // then re-render. The store + sliver are wired at boot; setVerdict emits and
    // the subscribed sliver re-renders. E7.
    await page.evaluate(async () => {
      const [{ serverTrust }, { renderTrustSliver }] = await Promise.all([
        import("/lib/serverTrust.js"),
        import("/lib/trustSliver.js"),
      ]);
      await serverTrust.setVerdict({
        trusted: false,
        reason: "gym-seeded untrusted verdict",
        // A fixed, obviously-fake DER-pubkey-ish hex so a cert-hash is derived.
        caPubkey: "ab".repeat(48),
      });
      renderTrustSliver();
    });
    const sliver = page.locator("#trust-sliver");
    await expect(sliver).toBeVisible({ timeout: 10_000 });
    await expect(sliver.locator(".trust-bar-line")).toHaveCount(1);
    await shot(page, testInfo, "trust-sliver");
  });

  test("gym total webapp the active-operations teal sliver shows a seeded build", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    // Seed one in-flight build op on the client-side ActiveOperationsCenter the
    // teal bar reads, then refresh the bar. D5-F12.
    await page.evaluate(async () => {
      const [{ activeOperations }, { refreshOperationsBar }] = await Promise.all([
        import("/lib/activeOperations.js"),
        import("/lib/operationsBar.js"),
      ]);
      activeOperations.upsertBuild("gym-total-build", "blog", "Home", { view: "view-vibecode-chat" });
      refreshOperationsBar();
    });
    await expect(page.locator("#global-operations-bar")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#global-operations-bar")).toContainText(/building/i);
    await shot(page, testInfo, "operations-sliver");
  });
});
