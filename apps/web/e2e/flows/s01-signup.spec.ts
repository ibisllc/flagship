/**
 * S1 — signup + unlock cycle.
 *
 * First-run bootstrap (passphrase + confirm + Generate) lands the
 * user on view-home. Reload the page; IndexedDB persistence pulls
 * back the wrapped UMK, so the user lands on view-unlock instead.
 * Unlock with the same passphrase → home again.
 *
 * No .com calls — the home view's /api/me/servers fetch is allowed
 * to fail / 404; we just assert the views are reachable.
 */

import { test, expect } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S1 — bootstrap → home → reload → unlock → home", async ({ page }) => {
  // Bootstrap.
  await page.goto("/");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // Reload — wrapped UMK persists in IndexedDB → unlock prompt.
  await page.reload();
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#view-bootstrap")).not.toBeVisible();

  // Unlock with the same passphrase.
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
});

test("S1 — wrong passphrase keeps the user on view-unlock with a toast", async ({ page }) => {
  // Set up state first.
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // Reload + try with the wrong passphrase.
  await page.reload();
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", "wrong-passphrase");
  await page.click("#unlock-go");
  // Stay on view-unlock; toast appears with the err class.
  await expect(page.locator("#view-unlock")).toBeVisible();
  await expect(page.locator("#view-home")).not.toBeVisible();
  await expect(page.locator("#toast")).toContainText(/wrong passphrase/i, { timeout: 3_000 });
});
