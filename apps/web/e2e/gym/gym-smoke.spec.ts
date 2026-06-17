/**
 * GYM webapp smoke (§12-G3 / §10 Phase-1) — the deterministic Tier-1 smoke the
 * gym harness drives on the webapp surface: cold-launch → the bootstrap shell
 * renders the expected elements, with NO backend (served by the gym static
 * server). This is the webapp leg of `gym:every-merge`.
 *
 * The verdict is the assertions below (Layer 1). Screenshots are captured at
 * the scenario's screenshot points (`gym-screenshot:<point>`) for the advisory
 * judge — they never decide pass/fail.
 *
 * It deliberately reuses the EXISTING handle convention (#view-bootstrap,
 * header h1#title, #bootstrap-go) so it stays robust to layout churn, mirroring
 * the s15 webapp-shell spec.
 */

import { test, expect } from "@playwright/test";

test.describe("gym webapp smoke — cold launch", () => {
  test("cold launch renders the bootstrap shell + primary action", async ({
    page,
  }, testInfo) => {
    // Capture to a FILE (not an inline body) so the JSON reporter records a
    // `path` — the gym web adapter maps `gym-screenshot:<point>` attachments
    // with a path into the artifact at their named point.
    const shot = async (point: string) => {
      const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(`gym-screenshot:${point}`, {
        path: file,
        contentType: "image/png",
      });
    };

    // Step: launch (cold).
    await page.goto("/index.html");

    // Assertion: the bootstrap view is present (the app booted to its
    // unauthenticated entry without a backend).
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await shot("cold-launch");

    // Assertion: the editorial brand title renders.
    const title = page.locator("header h1#title");
    await expect(title).toContainText("Flagship");

    // Assertion: the primary "create account" action is present + enabled
    // (the every-button-reachable spirit of D7-usable for this one screen).
    const go = page.locator("#bootstrap-go");
    await expect(go).toBeVisible();
    await expect(go).toBeEnabled();
    await shot("bootstrap-ready");
  });
});
