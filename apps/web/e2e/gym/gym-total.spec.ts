/**
 * GYM webapp TOTAL-gym Tier-1 tranche (§12-G5 / §6 matrix) — the higher-value,
 * fixture-feasible, DETERMINISTIC, NO-BACKEND scenarios that go BEYOND the
 * every-merge subset (`gym-smoke.spec.ts`) into the §6 dimensions the webapp
 * can render + assert client-side with NO backend.
 *
 * NO BACKEND, by construction. The gym static server serves only the static
 * webapp tree — every `/api/*` is a hard 404, SW blocked. Two backendless seed
 * techniques are used here, matching the existing rig:
 *
 *   1. CLIENT-SIDE STORE SEEDING (the trust + ops slivers, the PIN lock, the
 *      keyfile export) — drive the served ES modules through `page.evaluate`;
 *      everything is in-memory / IndexedDB / WebCrypto, no network at all.
 *   2. ROUTE-STUBBED BFF (server-detail, build-git/mcp/journal) — the views
 *      DO call `/api/screens/*` (or `/api/build/*`) on the *pod*, so we seed a
 *      pod base-url + session token client-side (`seedPairedPod`) and intercept
 *      exactly those requests with `page.route` returning a fixture body. The
 *      static server still 404s everything we DON'T route, so an un-stubbed call
 *      fails closed — the route map IS the seed surface, nothing leaks live.
 *
 * The verdict is the assertions (Layer 1, §2.1). Screenshots are captured at
 * each scenario's screenshot points (`gym-screenshot:<point>`) for the advisory
 * judge — they never decide pass/fail. Each `test(...)` title is the grep token
 * the gym web adapter selects on via `scenario.harness`, so every title is
 * UNIQUE. Handles reuse the EXISTING webapp id convention (§8) — grepped from
 * the real `apps/web/public/webapp` tree, never invented.
 *
 * Behavioral flows that genuinely need a *live* daemon round-trip (the deploy
 * EFFECT, a real adapt) stay on the pod-sim rig (s00..s16) or land in the live
 * slice (G6); here we assert the UI renders the seeded state + the confirm
 * ceremonies OPEN (non-destructive), which is exactly what a fixture proves.
 */

import { test, expect, type Page } from "@playwright/test";
import { formatWhen } from "../../public/webapp/lib/dateFormat.js";

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
  // Username-first cover: "Create a new account" opens an inline passphrase +
  // confirm, mints the device identity client-side (wrapped UMK → IndexedDB)
  // BEFORE the random-handle suggestion fetch (which 404s in the backendless
  // gym → toast). The identity persists regardless, so reachShell's
  // reload→unlock works.
  await page.click("#bootstrap-create");
  await expect(page.locator(".modal-title")).toHaveText("Create your account");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
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
  // generateIdentity waited for the post-mint toast → the wrapped UMK is
  // persisted; reload with the deep-link → boot routes to the unlock screen.
  await page.goto(`/index.html?view=${viewAlias}`);
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
}

/**
 * Reach Home AND wait for it to SETTLE. `reachShell` clicks unlock, which fires
 * `dispatchInitialView()` asynchronously (it honours `?view=home` → shows Home).
 * If a test navigates onward before that resolves, the late `dispatchInitialView`
 * clobbers the new view back to Home mid-assertion. So every test that navigates
 * past Home must first wait for Home to be the stable on-stage view — this is the
 * synchronisation point.
 */
async function reachHome(page: Page): Promise<void> {
  await reachShell(page, "home");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  // Belt-and-suspenders: let the unlock's dispatchInitialView microtasks drain so
  // a late show("view-home") can't fire after we navigate onward.
  await page.waitForTimeout(150);
}

/** Reach Home → the Settings TAB (the row-nav landing). */
async function reachSettingsTab(page: Page): Promise<void> {
  await reachHome(page);
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
}

/** Reach the Settings DETAIL page (`#view-settings`, the AI-keys manager),
 *  reached from the tab's "AI keys" row. The session and Danger zone
 *  buttons live on the tab itself (reachSettingsTab). */
async function reachSettingsDetail(page: Page): Promise<void> {
  await reachSettingsTab(page);
  await page.click("#settings-tab-providers");
  await expect(page.locator("#view-settings")).toBeVisible({ timeout: 10_000 });
}

/**
 * Seed a "paired pod" client-side so the `/api/screens/*` + `/api/build/*`
 * views think they are paired (without any backend): create + activate a demo
 * profile (`smoketest`, the §7-G fixture username) then write the per-profile
 * `podBaseUrl` + `sessionToken` slots through the served `lib/api.js`. Those
 * slots are per-profile (NOT device-wide), so an active profile is required —
 * without it `setPodBaseUrl` silently no-ops and `screensFetch` throws
 * "not paired" before any network. The base url is a fixed sentinel host the
 * `page.route` patterns below match on.
 */
const POD_BASE = "https://home.smoketest.flagship.services";
async function seedPairedPod(page: Page): Promise<void> {
  await page.evaluate(async (podBase) => {
    const [store, api] = await Promise.all([
      import("/lib/profilesStore.js"),
      import("/lib/api.js"),
    ]);
    store.ensureProfile("smoketest");
    store.setActiveCloudName("smoketest");
    api.setPodBaseUrl(podBase);
    api.setSessionToken("gym-fixture-session-token");
  }, POD_BASE);
}

/** Stub a single pod/daemon JSON endpoint (matched by URL substring) with a
 *  fixture body. The gym static server 404s everything we DON'T route, so the
 *  route map is the whole seed surface — an unstubbed daemon call fails closed. */
async function routePodJson(page: Page, pathSubstring: string, body: unknown, status = 200): Promise<void> {
  await page.route(
    (url) => url.href.startsWith(POD_BASE) && url.href.includes(pathSubstring),
    async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

/** A minimal ServerDetailResponse (P1.1) the server-detail view renders from.
 *  `certNotAfter` defaults ~60d out (healthy); override for the D5 cert states. */
function serverDetailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    serverFqdn: "home.smoketest.flagship.services",
    username: "smoketest",
    daemonVersion: "gym-fixture-1.0.0",
    uptimeMs: 3 * 86_400_000 + 4 * 3_600_000,
    certNotAfter: now + 60 * 86_400_000,
    certSans: ["home.smoketest.flagship.services", "*.home.smoketest.flagship.services"],
    serviceCount: 2,
    pairedSessionCount: 1,
    recentInstallEvents: [],
    ...overrides,
  };
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
    // device-local). Flagship Inference is the built-in first row, never
    // deletable; with no backend its status can't be read, so the row is
    // disabled with the reason and, with no saved key, the add-key form opens
    // instead of the step being skipped. No username prompt pops up over it.
    await page.click("#build-src-scratch");
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    const freeRow = page.locator("#build-key-saved #build-key-free-ai");
    await expect(freeRow).toBeVisible({ timeout: 10_000 });
    await expect(freeRow).toContainText("Flagship Inference");
    await expect(freeRow).toHaveClass(/is-disabled/);
    await expect(page.locator("#build-key-free-ai-status")).toHaveText(
      "Flagship Inference isn't available right now. You can add your own AI key.",
    );
    await expect(freeRow.locator(".build-key-delete")).toHaveCount(0);
    await expect(page.locator("#build-key-free-ai-use")).toHaveCount(0);
    await expect(page.locator("#build-key-form")).toBeVisible();
    await expect(page.locator(".modal-title")).toHaveCount(0);
    await shot(page, testInfo, "build-key");
  });

  // ─── D3 — settings: session tiers + grey-out gating ──────────────────────

  test("gym total webapp settings greys the recovery-gated session actions", async ({ page }, testInfo) => {
    await reachSettingsTab(page);
    // The tier-1 PIN lock is always available.
    await expect(page.locator("#settings-pin-lock")).toBeVisible();
    // Tiers 2+3 are greyed until recovery is enrolled. With no backend the
    // recovery probe fails closed → not-enrolled → both carry `gated`.
    await expect(page.locator("#settings-signout")).toHaveClass(/gated/, { timeout: 10_000 });
    await expect(page.locator("#settings-reset")).toHaveClass(/gated/);
    await page.locator("#settings-danger-zone-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "session-tiers-gated");
  });

  test("gym total webapp a greyed session action opens the last-device deletion ceremony", async ({ page }, testInfo) => {
    // D3-C1 — with no cloud recovery, "Lock with passkey" erases the only copy
    // of the account key, so a tap on the greyed button never wipes: it routes
    // into the account-deletion ceremony (typed username + confirm). Since the
    // private-naming cutover the device count is no longer public, so every
    // real account takes the ceremony (demo accounts are exempt). We back out
    // of it: no self-delete request fires and the account key stays in memory.
    const destructive: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/account\/self-delete|\/api\/devices\/.*\/revoke/.test(r.url())) destructive.push(r.url());
    });
    await reachSettingsTab(page);
    await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      getSession().username = "smoketest";
    });
    await expect(page.locator("#settings-signout")).toHaveClass(/gated/, { timeout: 10_000 });
    await page.click("#settings-signout");
    await expect(page.locator("#view-account-delete")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#account-delete-username")).toHaveText("smoketest");
    const go = page.locator("#account-delete-go");
    await expect(go).toBeDisabled();
    await page.fill("#account-delete-confirm-input", "someone-else");
    await expect(go).toBeDisabled();
    await page.fill("#account-delete-confirm-input", "smoketest");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "deletion-ceremony");
    await page.click("#account-delete-back");
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    const keyKept = await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      return getSession().umk instanceof Uint8Array;
    });
    expect(keyKept).toBe(true);
    expect(destructive).toEqual([]);
  });

  // ─── D3 — AI-keys manager + recovery screen ──────────────────────────────

  test("gym total webapp settings renders the AI-keys manager", async ({ page }, testInfo) => {
    await reachSettingsDetail(page);
    // The providers (AI-keys) section renders inline on the settings detail.
    // Flagship Inference is always listed first as the built-in provider with
    // no remove control (disabled with the reason when its status can't be
    // read, as here with no backend); the Add-provider affordance is present.
    // D3-C2.
    const freeCard = page.locator("#free-ai-card");
    await expect(freeCard).toBeVisible({ timeout: 10_000 });
    await expect(freeCard).toContainText("Flagship Inference");
    await expect(freeCard).toContainText("built-in");
    await expect(freeCard.locator('[data-action="remove"]')).toHaveCount(0);
    await expect(page.locator("#free-ai-line")).toContainText(/isn't available right now/);
    await expect(page.locator("#free-ai-add-key")).toBeVisible();
    await expect(page.locator("#add-provider-go")).toBeVisible();
    // A saved key lists AFTER the built-in entry, masked, with its own remove.
    await page.click("#add-provider-go");
    await page.fill("#np-label", "My OpenAI");
    await page.fill("#np-key", "sk-gymfixture-0123456789abcdef");
    await page.click("#np-save");
    const saved = page.locator("#providers-list .provider-entry");
    await expect(saved).toHaveCount(1, { timeout: 10_000 });
    await expect(saved).toContainText("My OpenAI");
    await expect(saved).not.toContainText("sk-gymfixture-0123456789abcdef");
    await expect(saved.locator('[data-action="remove"]')).toBeVisible();
    const order = await page.evaluate(() => {
      const a = document.getElementById("free-ai-card");
      const b = document.getElementById("providers-list");
      return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
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
    await reachSettingsTab(page);
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
    await reachSettingsTab(page);
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

  // ─── D1 — server lifecycle: server-detail render + control sections ──────

  test("gym total webapp server-detail renders its control sections", async ({ page }, testInfo) => {
    // D1-A6..A11 — the server-detail screen is the lifecycle CONTROL surface.
    // Seed a paired pod + route ONLY its ServerDetailResponse; the full card set
    // (cert / counters / auto-unlock / live metrics / front-page / lock & power
    // / dead-man / journal / danger-zone) renders from that one body. Every
    // other daemon read (metrics, leases, front-page, /api/services) stays
    // un-routed → 404 → its card degrades to its placeholder, never breaking the
    // page. Pure render assertion, no action fired (non-destructive).
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody());
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#view-server-detail")).toBeVisible({ timeout: 10_000 });
    // The load-bearing control sections each render their card.
    await expect(page.locator("#auto-unlock-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#lock-power-card")).toBeVisible();
    await expect(page.locator("#deadman-card")).toBeVisible();
    await expect(page.locator("#journal-card")).toBeVisible();
    await expect(page.locator("#front-page-card")).toBeVisible();
    await expect(page.locator("#danger-zone-card")).toBeVisible();
    await expect(page.locator("#revoke-server-btn")).toBeVisible();
    await shot(page, testInfo, "server-detail");
  });

  test("gym total webapp server-detail revoke opens the confirm ceremony", async ({ page }, testInfo) => {
    // D1-A11 / D6-G11 — tapping "Revoke this server" opens the confirm dialog
    // (reason radios + Cancel/Revoke), it does NOT delete anything. We Cancel —
    // the destructive path (the 3s countdown → revokeServer) never runs, so this
    // stays NON-destructive (no `destructive:` flag needed; nothing is flipped).
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody());
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#revoke-server-btn")).toBeVisible({ timeout: 10_000 });
    await page.click("#revoke-server-btn");
    // The confirm dialog opens with the reason picker. Revoking is reversible
    // now (Un-revoke restores the server; Delete is the permanent path), so
    // the copy says the name stays reserved until it's un-revoked.
    const dlg = page.locator('dialog[aria-label="Revoke server"]');
    await expect(dlg).toBeVisible({ timeout: 5_000 });
    await expect(dlg.locator(".modal-title")).toHaveText("Revoke home.smoketest.flagship.services?");
    await expect(dlg.locator(".modal-message")).toContainText("un-revoke it");
    await expect(dlg.locator(".modal-message")).toContainText("name stays reserved");
    await expect(dlg.locator('input[name="revoke-reason"]').first()).toBeVisible();
    await expect(dlg.locator('input[name="revoke-reason"]').first()).toBeChecked();
    await expect(dlg.locator("[data-revoke-go]")).toBeVisible();
    await shot(page, testInfo, "revoke-confirm");
    // Cancel — no revoke fired; back on the server-detail page.
    await dlg.locator("[data-revoke-cancel]").click();
    await expect(dlg).toBeHidden({ timeout: 5_000 });
    await expect(page.locator("#view-server-detail")).toBeVisible();
  });

  test("gym total webapp server-detail lock-and-power opens the confirm dialog", async ({ page }, testInfo) => {
    // D6-G3 (confirm-UI) — "Lock and turn off" opens its are-you-sure dialog;
    // the actual power order only fires AFTER a 3s countdown that runs inside
    // onConfirm — we never get there. We Cancel, so nothing is sent. The card
    // assumes LUKS (no diskEncryption in the BFF) → the label is "Lock and …".
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody());
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    const off = page.locator("#power-off-btn");
    await expect(off).toBeVisible({ timeout: 10_000 });
    await expect(off).toContainText(/turn off/i);
    await off.click();
    const dlg = page.locator('dialog[aria-label="Lock and turn off"]');
    await expect(dlg).toBeVisible({ timeout: 5_000 });
    await expect(dlg.locator("[data-power-go]")).toBeVisible();
    await shot(page, testInfo, "power-confirm");
    await dlg.locator("[data-power-cancel]").click();
    await expect(dlg).toBeHidden({ timeout: 5_000 });
  });

  // ─── Debug access (docs/recipe-delivery-and-remote-install.md) ──────────

  const GYM_DEBUG_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3";
  const debugOn = () => ({
    on: true,
    expiresAt: Date.now() + 3_600_000,
    keyFingerprint: "SHA256:2HS8bJpYBy7bDfWIQN304coFKT0s6CVPABFLYq+IX5E",
    grantedBy: "admin",
  });
  const DEBUG_OFF = { on: false, expiresAt: null, keyFingerprint: null, grantedBy: null };

  /** This device holds an admin root (or not), so the section offers the controls (or not). */
  async function setAdminDevice(page: Page, admin: boolean): Promise<void> {
    await page.evaluate(async (isAdmin) => {
      const { getSession } = await import("/lib/state.js");
      Object.assign(getSession(), {
        umk: getSession().umk ?? new Uint8Array(32).fill(7),
        adminRootSeed: isAdmin ? new Uint8Array(32).fill(0x5a) : null,
      });
    }, admin);
  }

  test("gym total webapp server-detail debug access turns on, renews and turns off", async ({ page }, testInfo) => {
    // An admin device pastes a key, picks 1 hour, accepts the warning, and the
    // signed grant goes to the box; the banner shows until when. Renew sends a
    // new grant; Turn off signs the revoke and the banner goes. The box is
    // route-stubbed, so nothing real is opened.
    await reachHome(page);
    await seedPairedPod(page);
    await setAdminDevice(page, true);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody({ debugAccess: DEBUG_OFF }));
    const sent: Array<{ url: string; body: { grant?: { sshPublicKey: string; issuedAt: number; expiresAt: number }; signatureHex: string } }> = [];
    await page.route(
      (url) => url.href.startsWith(POD_BASE) && url.pathname === "/api/screens/debug-access",
      async (route) => {
        sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, change: sent.length > 1 ? "renewed" : "granted", debugAccess: debugOn() }),
        });
      },
    );
    await page.route(
      (url) => url.href.startsWith(POD_BASE) && url.pathname === "/api/screens/debug-access/revoke",
      async (route) => {
        sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, change: "revoked", debugAccess: DEBUG_OFF }),
        });
      },
    );
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#debug-access-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#debug-access-pill")).toHaveText("Off");
    await expect(page.locator("#debug-access-banner")).toBeHidden();
    await expect(page.locator("#debug-access-warning")).toContainText("read everything on this server");

    await page.fill("#debug-access-ssh-key", `${GYM_DEBUG_KEY} me@laptop`);
    await page.selectOption("#debug-access-duration", "1h");
    // seedPairedPod switched to the "smoketest" profile: wrap this session's key
    // there too, so the fresh unlock below finds it under the passphrase.
    await page.evaluate(async (pass) => {
      const [{ getSession }, ks] = await Promise.all([import("/lib/state.js"), import("/keystore.js")]);
      await ks.persistSeedForProfile(getSession().umk, "smoketest", pass);
    }, PASSPHRASE);
    await page.click("#debug-access-on-btn");
    // One fresh unlock per grant: a wrong passphrase sends nothing.
    await expect(page.locator(".modal-message")).toContainText("read everything on this server");
    await page.fill(".modal-input", "not-the-passphrase");
    await page.locator("[data-modal-ok]").click();
    await expect.poll(() => sent.length).toBe(0);
    await page.click("#debug-access-on-btn");
    await page.fill(".modal-input", PASSPHRASE);
    await page.locator("[data-modal-ok]").click();
    await expect(page.locator("#debug-access-banner")).toContainText("Debug access is on until", { timeout: 10_000 });
    await expect(page.locator("#debug-access-pill")).toHaveText("On");
    await expect(page.locator("#debug-access-key")).toContainText("SHA256:");
    expect(sent[0]!.body.grant!.sshPublicKey).toBe(GYM_DEBUG_KEY);
    expect(sent[0]!.body.grant!.expiresAt - sent[0]!.body.grant!.issuedAt).toBe(3_600_000);
    expect(sent[0]!.body.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    await shot(page, testInfo, "debug-access-on");

    await expect(page.locator("#debug-access-on-btn")).toHaveText("Renew");
    await page.click("#debug-access-on-btn");
    await page.fill(".modal-input", PASSPHRASE);
    await page.locator("[data-modal-ok]").click();
    await expect.poll(() => sent.length).toBe(2);

    await page.click("#debug-access-off-btn");
    await page.locator("[data-modal-ok]").click();
    await expect(page.locator("#debug-access-banner")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#debug-access-pill")).toHaveText("Off");
    expect(sent[2]!.url).toContain("/api/screens/debug-access/revoke");
    await shot(page, testInfo, "debug-access-off");
  });

  test("gym total webapp server-detail debug access is read-only on a non-admin device", async ({ page }, testInfo) => {
    await reachHome(page);
    await seedPairedPod(page);
    await setAdminDevice(page, false);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody({ debugAccess: debugOn() }));
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#debug-access-banner")).toContainText("Debug access is on until", { timeout: 10_000 });
    await expect(page.locator("#debug-access-admin-only")).toHaveText("Only an admin device can turn debug access on or off.");
    await expect(page.locator("#debug-access-on-btn")).toHaveCount(0);
    await expect(page.locator("#debug-access-off-btn")).toHaveCount(0);
    await shot(page, testInfo, "debug-access-read-only");
  });

  // ─── D5 — server-event seed states (server-detail cert) ──────────────────

  test("gym total webapp server-detail surfaces a near-expiry certificate", async ({ page }, testInfo) => {
    // D5-F8 — a near-expiry cert (validUntil ~5d out) is seeded on the BFF;
    // server-detail renders it in the Cert card's "Not after" row. We assert the
    // rendered date matches the seeded one (the surfaced event), not a literal
    // string, so it stays robust to locale formatting.
    const soon = Date.now() + 5 * 86_400_000;
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody({ certNotAfter: soon }));
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#view-server-detail")).toBeVisible({ timeout: 10_000 });
    // server-detail routes cert dates through the shared S2 date helper.
    const expected = formatWhen(soon);
    await expect(page.locator("#server-detail-content")).toContainText(expected, { timeout: 10_000 });
    await shot(page, testInfo, "cert-near-expiry");
  });

  test("gym total webapp server-detail reflects a renewed certificate date", async ({ page }, testInfo) => {
    // D5-F7 — cert renewal advances `certNotAfter`; server-detail reflects the
    // new far-future date on the next render. Asserts the renewed date is shown.
    const renewed = Date.now() + 89 * 86_400_000;
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody({ certNotAfter: renewed }));
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#view-server-detail")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#server-detail-content")).toContainText(formatWhen(renewed), {
      timeout: 10_000,
    });
    await shot(page, testInfo, "cert-renewed");
  });

  // ─── D2 — build modes IN DETAIL (route-stubbed pod BFF) ──────────────────

  test("gym total webapp git build shows the Flagship-ready verdict and Install", async ({ page }, testInfo) => {
    // D2-B5/B6 — paste a repo URL → the box reports FIT → the verdict card +
    // "Install it" render. The /api/build/git POST is stubbed; the verdict is
    // the seeded body. No deploy fired (that needs a live daemon → live slice).
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/build/git", {
      buildId: "gym-git-fit",
      fit: true,
      reason: "Has a Flagship manifest",
      fileCount: 12,
    });
    await page.evaluate(async () => {
      const { enterBuildGit } = await import("/views/build-git.js");
      enterBuildGit();
    });
    await expect(page.locator("#view-build-git")).toBeVisible({ timeout: 10_000 });
    await page.fill("#build-git-url", "https://github.com/you/flagship-app");
    await page.click("#build-git-check");
    await expect(page.locator("#build-git-verdict")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-git-verdict")).toContainText(/Flagship-ready/i);
    await expect(page.locator("#build-git-deploy")).toBeVisible();
    await shot(page, testInfo, "git-verdict-fit");
  });

  test("gym total webapp git build offers AI-adapt for a non-fit repo", async ({ page }, testInfo) => {
    // D2-B7 — a NOT-fit repo → the verdict says why in plain words + offers
    // "Use AI to adapt and deploy" (which routes through the AI-key step) and
    // the anonymous-share switch. We stop at the verdict render — no adapt fired.
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/build/git", {
      buildId: "gym-git-nofit",
      fit: false,
      reason: "no flagship.app.json in the repo root",
      fileCount: 40,
    });
    await page.evaluate(async () => {
      const { enterBuildGit } = await import("/views/build-git.js");
      enterBuildGit();
    });
    await expect(page.locator("#view-build-git")).toBeVisible({ timeout: 10_000 });
    await page.fill("#build-git-url", "https://github.com/you/some-saas");
    await page.click("#build-git-check");
    await expect(page.locator("#build-git-verdict")).toBeVisible({ timeout: 10_000 });
    const verdict = page.locator("#build-git-verdict");
    await expect(verdict).toContainText("This repo is not yet adapted for Flagship.");
    await expect(verdict).not.toContainText(/Flagship-ready/);
    await expect(page.locator("#build-git-deploy")).toHaveCount(0);
    await expect(page.locator("#build-git-adapt")).toHaveText("Use AI to adapt and deploy");
    await expect(page.locator("#build-git-share")).toBeVisible();
    await expect(page.locator("#build-git-recheck")).toBeVisible();
    await shot(page, testInfo, "git-verdict-nofit");
  });

  test("gym total webapp MCP connect shows the copyable key and IDE config", async ({ page }, testInfo) => {
    // D2-B8 — "Create a connection" → the box mints an MCP URL + per-build key +
    // IDE config; the connection card renders them with rotate + deploy + the
    // env-requests slot. Stubbed POST; nothing deployed.
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/build/mcp", {
      buildId: "gym-mcp-1",
      connection: {
        url: "https://home.smoketest.flagship.services/mcp/build/gym-mcp-1",
        key: "mcpk_gymfixture_do_not_use",
        ideConfig: { mcpServers: { flagship: { url: "…", headers: { Authorization: "Bearer …" } } } },
      },
    });
    // env-requests is fetched on render; empty list keeps the slot quiet.
    await routePodJson(page, "/env-requests", { requests: [] });
    await page.evaluate(async () => {
      const { enterBuildMcp } = await import("/views/build-mcp.js");
      enterBuildMcp();
    });
    await expect(page.locator("#view-build-mcp")).toBeVisible({ timeout: 10_000 });
    await page.click("#build-mcp-create");
    await expect(page.locator("#build-mcp-conn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#mcp-url")).toBeVisible();
    await expect(page.locator("#mcp-key")).toContainText("mcpk_gymfixture_do_not_use");
    await expect(page.locator("#mcp-copy-cfg")).toBeVisible();
    await expect(page.locator("#mcp-rotate")).toBeVisible();
    await shot(page, testInfo, "mcp-connect");
  });

  test("gym total webapp MCP env-requests never reveal a secret value", async ({ page }, testInfo) => {
    // D2-B9 (SECURITY) — the IDE's value-free env requests show the NAME + a
    // status (set ✓ / needs you) ONLY. We seed a request whose body carries a
    // sentinel `value` the UI must NEVER render, and assert the row shows the
    // name + "needs you" while the sentinel is absent from the whole view. This
    // is the value-free guarantee: the editor's AI never sees the secret.
    const SENTINEL = "SUPER_SECRET_GYM_VALUE_MUST_NOT_RENDER";
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/build/mcp", {
      buildId: "gym-mcp-env",
      connection: {
        url: "https://home.smoketest.flagship.services/mcp/build/gym-mcp-env",
        key: "mcpk_env_fixture",
        ideConfig: { mcpServers: {} },
      },
    });
    await routePodJson(page, "/env-requests", {
      requests: [
        // A maliciously-overshared payload: the daemon would NEVER send a value,
        // but we include one to PROVE the client never displays it.
        { name: "STRIPE_API_KEY", why: "billing", secret: true, currentlySet: false, value: SENTINEL },
      ],
    });
    await page.evaluate(async () => {
      const { enterBuildMcp } = await import("/views/build-mcp.js");
      enterBuildMcp();
    });
    await expect(page.locator("#view-build-mcp")).toBeVisible({ timeout: 10_000 });
    await page.click("#build-mcp-create");
    const envBox = page.locator("#mcp-env-requests");
    await expect(envBox).toContainText("STRIPE_API_KEY", { timeout: 10_000 });
    await expect(envBox).toContainText(/needs you/i);
    // THE GUARANTEE: the secret value is nowhere in the rendered view.
    await expect(page.locator("#view-build-mcp")).not.toContainText(SENTINEL);
    await shot(page, testInfo, "mcp-env-value-free");
  });

  test("gym total webapp build journal lists prior builds and opens a timeline", async ({ page }, testInfo) => {
    // D2-B10 — the journal viewer lists past builds (seeded /api/build/sessions)
    // then opens one build's timeline (seeded /journal). Resume/deploy live off
    // the timeline; we assert the list + timeline render (the resume surface).
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/build/sessions", {
      builds: [
        { buildId: "gym-build-a", serviceId: "blog", mode: "scratch", entryCount: 5, lastKind: "deployed" },
      ],
    });
    await routePodJson(page, "/gym-build-a/journal", {
      entries: [
        { ts: Date.now() - 60_000, kind: "created", actor: "owner", summary: "Build started", detail: "" },
        { ts: Date.now(), kind: "deployed", actor: "box", summary: "Deployed blog", detail: "" },
      ],
    });
    await page.evaluate(async () => {
      const { enterBuildJournal } = await import("/views/build-journal.js");
      await enterBuildJournal();
    });
    await expect(page.locator("#view-build-journal")).toBeVisible({ timeout: 10_000 });
    const tile = page.locator("#build-journal-list [data-build='gym-build-a']");
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await tile.click();
    await expect(page.locator("#build-journal-detail")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".build-journal-timeline")).toContainText(/Deployed blog/i);
    await shot(page, testInfo, "build-journal");
  });

  test("gym total webapp scratch chat needsCredential routes to the AI-key step", async ({ page }, testInfo) => {
    // D2-B3 (edge) — the scratch composer sends a first turn; the box has no
    // model wired so it answers `200 {needsCredential:true}`; the view gently
    // routes into the AI-key step instead of streaming. Asserts the
    // needsCredential → "add an AI key" transition (the BuildKey screen opens).
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/vibe-code/start", { needsCredential: true });
    await routePodJson(page, "/api/screens/vibe-code/name-check", { ok: true, name: "habits" });
    await page.evaluate(async () => {
      const { enterVibeCode } = await import("/views/vibe-code.js");
      enterVibeCode();
    });
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    // The owner names the app (its web address) before Build it enables.
    await page.fill("#vc-prompt", "A simple habit tracker");
    await expect(page.locator("#vc-send")).toBeDisabled();
    await page.fill("#vc-name", "habits");
    await expect(page.locator("#vc-name-status")).toHaveText("✓ Available", { timeout: 10_000 });
    await expect(page.locator("#vc-send")).toBeEnabled();
    await page.click("#vc-send");
    // needsCredential → enterBuildKey opens the AI-key step.
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "needs-credential");
  });

  // ─── D3 — settings EDGE CASES: add-device SAS, trusted devices, keyfile ──

  test("gym total webapp add-device renders the QR and SAS pairing chrome", async ({ page }, testInfo) => {
    // D3-C6 — the admin "Add device" screen renders the pairing QR box, the SAS
    // match-code display, the no-screenshot warning, and the confirm button.
    // With no relay peer the SAS stays the "— — —" placeholder and Confirm is
    // disabled (the double-tap-safe initial state, commit bc6a004e) — exactly
    // the pre-peer chrome a fixture proves. Needs an active profile (username)
    // so renderAddDevice's session guard passes.
    await reachHome(page);
    await page.evaluate(async () => {
      const store = await import("/lib/profilesStore.js");
      store.ensureProfile("smoketest");
      store.setActiveCloudName("smoketest");
      store.set("username", "smoketest");
      // Re-stamp the session username so startPairing's guard sees it.
      const { getSession } = await import("/lib/state.js");
      getSession().username = "smoketest";
    });
    await page.evaluate(async () => {
      const { enterAddDevice } = await import("/views/add-device.js");
      await enterAddDevice();
    });
    await expect(page.locator("#view-add-device")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#add-device-qr")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#add-device-sas")).toBeVisible();
    await expect(page.locator("#add-device-confirm")).toBeVisible();
    // The no-screenshot safeguard is present (login-and-account-redesign §Safeguards).
    await expect(page.locator('[data-section="no-screenshot"]')).toBeVisible();
    await shot(page, testInfo, "add-device-sas");
  });

  test("gym total webapp trusted-devices lists the account's devices", async ({ page }, testInfo) => {
    // D3-C7 — the trusted-devices list comes only from the SIGNED account
    // directory (GET /api/accounts/<id>/directory, device-key signed). Human
    // device names travel as ciphertext and are decrypted in this unlocked
    // client; a device without a name falls back to its platform + support
    // code. We seed the profile's account + device ids, encrypt this device's
    // self-profile under the session's directory key, and route the directory.
    const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const THIS_DEVICE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
    await reachHome(page);
    const selfProfile = await page.evaluate(
      async ({ accountId, deviceId }) => {
        const [profiles, store, meta, { getSession }] = await Promise.all([
          import("/lib/profiles.js"),
          import("/lib/profilesStore.js"),
          import("/lib/accountMetadata.js"),
          import("/lib/state.js"),
        ]);
        profiles.addProfile({ cloudName: "smoketest", accountId, deviceId });
        store.ensureProfile("smoketest");
        store.setActiveCloudName("smoketest");
        store.set("username", "smoketest");
        const session = getSession();
        session.username = "smoketest";
        const fields = { accountId, recordType: "device-self-profile", deviceId, revision: 1, keyVersion: 1 };
        const sealed = await meta.encryptProfile(
          "Gym laptop",
          await meta.deriveDeviceDirectoryKey(session.umk),
          fields,
        );
        return { accountId, deviceId, revision: 1, keyVersion: 1, ...sealed };
      },
      { accountId: ACCOUNT_ID, deviceId: THIS_DEVICE },
    );
    let signedRead = false;
    await page.route(
      (url) => url.pathname === `/api/accounts/${ACCOUNT_ID}/directory`,
      async (route) => {
        const h = route.request().headers();
        signedRead =
          h["x-flagship-device-id"] === THIS_DEVICE && /^[0-9a-f]{128}$/.test(h["x-flagship-signature"] ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accountId: ACCOUNT_ID,
            devices: [
              { deviceId: THIS_DEVICE, platformClass: "web", createdAt: Date.now() - 3_600_000 },
              { deviceId: PHONE, platformClass: "ios", supportCode: "K7Q2-9XPM", createdAt: Date.now() - 86_400_000 },
            ],
            selfProfiles: [selfProfile],
            managedProfiles: [],
            grants: [],
          }),
        });
      },
    );
    await page.evaluate(async () => {
      const { show } = await import("/lib/router.js");
      show("view-trusted-devices");
    });
    await expect(page.locator("#view-trusted-devices")).toBeVisible({ timeout: 10_000 });
    const list = page.locator("#trusted-devices-list");
    const mine = list.locator(`[data-device-id="${THIS_DEVICE}"]`);
    await expect(mine).toContainText("Gym laptop", { timeout: 10_000 });
    await expect(mine).toContainText("This device");
    await expect(mine.locator("[data-self-rename]")).toBeVisible();
    const phone = list.locator(`[data-device-id="${PHONE}"]`);
    await expect(phone).toContainText("iPhone / iPad · Device K7Q2-9XPM");
    await expect(phone).not.toContainText("This device");
    await expect(list).toContainText("@smoketest");
    expect(signedRead).toBe(true);
    await shot(page, testInfo, "trusted-devices");
  });

  test("gym total webapp recovery keyfile export downloads a wrapped key file", async ({ page }, testInfo) => {
    // D3-C17 / E4 — the recovery keyfile export is pure client-side (argon2id +
    // AES-GCM over the in-memory seed → a Blob download), no backend. We unlock,
    // open Recovery, click "Back up account key", and assert a download fires
    // with the expected filename. This is the export half of the C11 round-trip.
    await reachHome(page);
    await page.evaluate(async () => {
      const { enterRecovery } = await import("/views/recovery.js");
      await enterRecovery();
    });
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
    // "Back up account key" opens the export CEREMONY modal: a strong backup
    // passphrase (twice) + the acknowledgment checkboxes, with the create button
    // gated until all are satisfied. Drive it exactly: fill both passphrase
    // fields with a strong passphrase, tick every ack, then create → a Blob
    // download fires (pure client-side; argon2id + AES-GCM, no backend).
    await page.click("#recovery-keyfile-export");
    const card = page.locator(".modal-card");
    await expect(card.locator("[data-pass1]")).toBeVisible({ timeout: 10_000 });
    // The backup passphrase must pass the strength gate (≥12 chars + ≥3 of
    // upper/lower/digit/symbol) — distinct from the device unlock passphrase.
    const BACKUP_PASS = "Gym-Backup-Passphrase-2026!";
    await card.locator("[data-pass1]").fill(BACKUP_PASS);
    await card.locator("[data-pass2]").fill(BACKUP_PASS);
    const acks = card.locator("[data-ack]");
    const ackCount = await acks.count();
    for (let i = 0; i < ackCount; i++) await acks.nth(i).check();
    const ok = card.locator("[data-ok]");
    await expect(ok).toBeEnabled({ timeout: 5_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await ok.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.(flagshipkey|json)$/);
    await shot(page, testInfo, "keyfile-export");
  });

  // ─── D4 — security: PIN lockout + trust override ─────────────────────────

  test("gym total webapp PIN lockout wipes the PIN and falls back to passphrase", async ({ page }, testInfo) => {
    // D4-E3 (security) — five wrong PINs trip the lockout: the PIN is WIPED
    // (clearPin) and the app falls back to the passphrase unlock screen. We set
    // a PIN, then enter a wrong one 5x and assert it lands on #view-unlock. A
    // subsequent passphrase unlock works (the PIN is the real reset path).
    await reachSettingsTab(page);
    await page.click("#settings-pin-lock");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    await page.fill("#pin-set-input", "1357");
    await page.fill("#pin-set-confirm", "1357");
    await page.click("#pin-set-go");
    await expect(page.locator("#view-pin-unlock")).toBeVisible({ timeout: 10_000 });
    // Five wrong attempts (MAX_ATTEMPTS = 5 → clearPin + lockedOut on the 5th).
    for (let i = 0; i < 5; i++) {
      await page.fill("#pin-unlock-input", "0000");
      await page.click("#pin-unlock-go");
    }
    // Lockout → bounced to the passphrase screen, the PIN wiped.
    await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "pin-lockout");
    // The passphrase still unlocks (it's the real key); and because the PIN was
    // wiped at lockout, boot would no longer route to the PIN screen.
    await page.fill("#unlock-passphrase", PASSPHRASE);
    await page.click("#unlock-go");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    const pinGone = await page.evaluate(async () => {
      const { hasPin } = await import("/lib/pinLock.js");
      return !(await hasPin());
    });
    expect(pinGone).toBe(true);
    await shot(page, testInfo, "pin-wiped-after-lockout");
  });

  test("gym total webapp passphrase unlock from the PIN screen clears the PIN", async ({ page }, testInfo) => {
    // D4-E3 (the reset rule) — choosing "Unlock with passphrase instead" from the
    // PIN screen, then unlocking, CLEARS the PIN (the passphrase is the real
    // key). Assert the PIN is gone after a passphrase unlock.
    await reachSettingsTab(page);
    await page.click("#settings-pin-lock");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    await page.fill("#pin-set-input", "2468");
    await page.fill("#pin-set-confirm", "2468");
    await page.click("#pin-set-go");
    await expect(page.locator("#view-pin-unlock")).toBeVisible({ timeout: 10_000 });
    // Switch to the passphrase, then unlock. handleUnlock() clears the PIN then
    // dispatchInitialView()→Home; wait for HOME (the post-clearPin landing) — NOT
    // the already-hidden PIN-unlock view — before asserting the PIN is gone.
    await page.click("#pin-unlock-passphrase");
    await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
    await page.fill("#unlock-passphrase", PASSPHRASE);
    await page.click("#unlock-go");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(150);
    const pinGone = await page.evaluate(async () => {
      const { hasPin } = await import("/lib/pinLock.js");
      return !(await hasPin());
    });
    expect(pinGone).toBe(true);
    await shot(page, testInfo, "pin-cleared-by-passphrase");
  });

  test("gym total webapp PIN change requires the current PIN", async ({ page }, testInfo) => {
    // D4-E3 — once a PIN is set, "Lock the app" (the PIN lock) surfaces the CHANGE flow
    // (current + new + confirm). A wrong current PIN is rejected; the change
    // never lands. Asserts the current-PIN field shows + a wrong current errors.
    await reachSettingsTab(page);
    await page.click("#settings-pin-lock");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    await page.fill("#pin-set-input", "1111");
    await page.fill("#pin-set-confirm", "1111");
    await page.click("#pin-set-go");
    await expect(page.locator("#view-pin-unlock")).toBeVisible({ timeout: 10_000 });
    // Unlock; the PIN-unlock handler runs dispatchInitialView() → Home. Wait for
    // that to SETTLE (the lock screen leaves + Home shows) before navigating to
    // settings, else the late dispatch clobbers settings back to Home.
    await page.fill("#pin-unlock-input", "1111");
    await page.click("#pin-unlock-go");
    await expect(page.locator("#view-pin-unlock")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(150);
    await page.evaluate(async () => {
      const { refreshSessionGates } = await import("/views/settings.js");
      const { show } = await import("/lib/router.js");
      show("view-settings-tab");
      await refreshSessionGates();
    });
    // Once a PIN is set, the SEPARATE "Change PIN" row appears (not the lock
    // button, which just re-locks); it opens the change flow.
    await expect(page.locator("#settings-pin-change")).toBeVisible({ timeout: 10_000 });
    await page.click("#settings-pin-change");
    await expect(page.locator("#view-pin-set")).toBeVisible({ timeout: 10_000 });
    // Change mode: the current-PIN field is shown.
    await expect(page.locator("#pin-set-current")).toBeVisible({ timeout: 5_000 });
    // A wrong current PIN is rejected (the change doesn't land).
    await page.fill("#pin-set-current", "9999");
    await page.fill("#pin-set-input", "2222");
    await page.fill("#pin-set-confirm", "2222");
    await page.click("#pin-set-go");
    await expect(page.locator("#pin-set-error")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#view-pin-set")).toBeVisible();
    await shot(page, testInfo, "pin-change-wrong-current");
  });

  test("gym total webapp trust override grants an exception but the sliver persists", async ({ page }, testInfo) => {
    // D4-E8/E9 — tap the red trust sliver line → the PIN/typed-confirm gate →
    // a device-key-signed TrustException is recorded → traffic un-halts, but the
    // red line STAYS (now flagged "continuing"), because the degraded state must
    // remain visible. No PIN is set here, so the gate is the typed "ACCEPT"
    // confirmation. The exception POST has no username (no .com call) → no
    // backend needed. Asserts: line present → override → line still present +
    // overridden flag.
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.evaluate(async () => {
      const [{ serverTrust }, { renderTrustSliver }] = await Promise.all([
        import("/lib/serverTrust.js"),
        import("/lib/trustSliver.js"),
      ]);
      await serverTrust.setVerdict({
        trusted: false,
        reason: "gym-seeded untrusted verdict for override",
        caPubkey: "cd".repeat(48),
      });
      renderTrustSliver();
    });
    const sliver = page.locator("#trust-sliver");
    await expect(sliver).toBeVisible({ timeout: 10_000 });
    const line = sliver.locator(".trust-bar-line");
    await expect(line).toHaveCount(1);
    // Tap the line → the typed-ACCEPT confirm modal opens.
    await line.click();
    const modalInput = page.locator(".modal-card input").first();
    await expect(modalInput).toBeVisible({ timeout: 5_000 });
    await modalInput.fill("ACCEPT");
    await page.locator(".modal-card button").filter({ hasText: /^Accept$/i }).first().click();
    // The exception is granted (toast) AND the red line PERSISTS — it must not
    // vanish; it now carries the "continuing" accepted marker.
    await expect(sliver).toBeVisible();
    await expect(sliver.locator(".trust-bar-line")).toHaveCount(1);
    await expect(sliver.locator(".trust-bar-accepted")).toBeVisible({ timeout: 5_000 });
    await shot(page, testInfo, "trust-override-persists");
  });

  // ─── D6 — action→effect (SIMULATED at Tier-1) ────────────────────────────

  test("gym total webapp set front page reflects the chosen label", async ({ page }, testInfo) => {
    // D6-G1 (simulated) — the front-page picker loads the current assignment +
    // the installed-services options (both unauthenticated pod GETs, stubbed),
    // the owner picks a label and Saves; the IRK-signed POST is stubbed 200 and
    // the UI confirms the new assignment in the status line. No real apex 302
    // (that's the live slice) — the client records the action + updates the UI.
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody());
    // Current assignment (none) + the picker options (the pod's /api/services
    // returns installed services under `apps[]`, the shape listFrontPageOptions reads).
    await routePodJson(page, "/api/front-page", { label: "" });
    await routePodJson(page, "/api/services", { apps: [{ urlLabel: "blog", name: "Blog" }] });
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#front-page-card")).toBeVisible({ timeout: 10_000 });
    const select = page.locator("#front-page-select");
    // The options load async; wait for the select to be enabled then pick "blog".
    await expect(select).toBeEnabled({ timeout: 10_000 });
    await select.selectOption("blog");
    // The Save POST is stubbed 200.
    await routePodJson(page, "/api/front-page", { ok: true }, 200);
    await page.click("#front-page-save");
    await expect(page.locator("#front-page-status")).toContainText(/blog/i, { timeout: 10_000 });
    await shot(page, testInfo, "front-page-set");
  });

  test("gym total webapp view journal renders the returned lines", async ({ page }, testInfo) => {
    // D6-G7 (simulated) — Diagnostics → View journal signs an owner envelope and
    // POSTs /api/journal; we stub the response lines and assert they render into
    // the journal output. The signing is real (in-memory IRK); the daemon read
    // is the seeded body — the UI effect is what we assert.
    await reachHome(page);
    await seedPairedPod(page);
    await routePodJson(page, "/api/screens/server-detail", serverDetailBody());
    await routePodJson(page, "/api/journal", {
      unit: "flagship-daemon",
      lines: ["gym: daemon started", "gym: tunnel connected", "gym: ACME cert ok"],
    });
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#journal-fetch-btn")).toBeVisible({ timeout: 10_000 });
    await page.click("#journal-fetch-btn");
    await expect(page.locator("#journal-output")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#journal-output")).toContainText(/tunnel connected/i);
    await shot(page, testInfo, "journal-output");
  });
});
