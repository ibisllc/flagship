/**
 * S10 — manual export/import of the wrapped UMK (no-cloud recovery).
 *
 * From the recovery view, click "Export wrapped UMK" → assert a
 * download fires with a JSON payload that has the expected shape.
 * The full export-then-import-on-a-fresh-browser roundtrip is the
 * harder half (Playwright can't easily share IndexedDB state across
 * contexts); scope here is the export download fires correctly.
 */

import { test, expect, bootstrapToHome } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S10 — export wrapped UMK downloads a JSON file", async ({ page }) => {
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);

  await page.click("#open-recovery");
  await expect(page.locator("#view-recovery")).toBeVisible();

  // Listen for the download fired by `a.click()` in exportWrapped().
  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 });
  await page.click("#recovery-export");
  const download = await downloadPromise;

  // The filename follows the pattern flagship-wrapped-umk-<ms>.json.
  expect(download.suggestedFilename()).toMatch(/^flagship-wrapped-umk-\d+\.json$/);

  // The downloaded content is the JSON-serialised wrapped UMK with
  // salt + nonce + ciphertext fields (per keystore.js).
  const path = await download.path();
  if (path) {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.salt).toMatch(/^[0-9a-f]+$/);
    expect(parsed.nonce).toMatch(/^[0-9a-f]+$/);
    expect(parsed.ciphertext).toMatch(/^[0-9a-f]+$/);
  }
});
