/**
 * S16 — Compose draft + Deliver now (#24 + #59).
 *
 * E2E smoke of the webapp's create-server view against the live origin.
 *
 *   - bootstraps a fresh identity (random UMK from the in-browser keystore)
 *   - opens the create-server view via its module entry hook
 *   - fills the form, saves the draft
 *   - asserts the rendered card carries the typed server name
 *   - New resets the form; Resume restores every saved choice
 *
 * The crypto surface (canonical-bytes, deriveMatchCode parity with the
 * server-side Durable Object, sealForBrowserKey X25519 round-trip) is
 * unit-tested in apps/web/tests/createServerView.test.ts — that's where
 * the security-critical assertions live. This spec only proves the UI
 * flow renders without regressions.
 *
 * The deliver-now leg requires a live build-relay Durable Object on
 * the apex Worker plus a /build/ browser tab receiving the encrypted
 * blob. We don't reproduce that infrastructure under Playwright; that
 * scenario is exercised by the manual S16 walk-through in
 * docs/e2e-test-plan.md.
 */

import { test, expect, bootstrapToHome } from "../fixtures/pod-sim.js";

const PASSPHRASE = "compose-deliver-test-passphrase-1234";

test.describe("S16 — Compose draft (#24)", () => {
  // Bootstrap + IDB ops + module imports add up against the live origin; give
  // the test enough headroom that one slow asset fetch can't time it out.
  test.setTimeout(60_000);

  test("user composes a draft and the rendered card shows the server name", async ({
    page,
  }) => {
    // Capture page errors so silent JS crashes don't disguise themselves
    // as 'view did not appear' Playwright timeouts — and fail on them.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await bootstrapToHome(page, PASSPHRASE);

    // Drive the view directly via its module entry hook (Settings → Developer
    // → "Create a server" and Home → "+ Add a server" both land here).
    await page.evaluate(async () => {
      const m = (await import("/views/create-server.js" as string)) as {
        enterCreateServer(): Promise<void>;
      };
      await m.enterCreateServer();
    });
    await expect(page.locator("#view-create-server")).toBeVisible();

    // Non-default choices, so the round-trip proves they persist.
    const serverName = `home-${Date.now().toString(36)}`;
    await page.fill("#cs-server-name", serverName);
    await page.selectOption("#cs-backup-policy", "none");
    await page.uncheck("#cs-encrypt-disk");
    await page.click("#cs-save-draft");

    // The drafts list re-renders with the new card. The race-safe
    // refreshDrafts (gen-counter) guarantees the latest render wins.
    await expect(page.locator("#cs-drafts")).toContainText(serverName);
    await expect(
      page.locator("#cs-drafts .pill", { hasText: /draft/i }),
    ).toBeVisible();

    // New resets the whole form to its defaults.
    await page.click("#cs-new");
    await expect(page.locator("#cs-server-name")).toHaveValue("");
    await expect(page.locator("#cs-backup-policy")).toHaveValue("phone-only");
    await expect(page.locator("#cs-encrypt-disk")).toBeChecked();

    // Resume the draft — the form re-populates.
    await page.click("#cs-drafts button[data-action='resume']");
    await expect(page.locator("#cs-server-name")).toHaveValue(serverName);
    await expect(page.locator("#cs-backup-policy")).toHaveValue("none");
    await expect(page.locator("#cs-encrypt-disk")).not.toBeChecked();
    expect(pageErrors).toEqual([]);
  });
});
