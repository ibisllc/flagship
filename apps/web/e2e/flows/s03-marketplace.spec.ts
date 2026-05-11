/**
 * S3 — marketplace browse + install.
 *
 * Seed the pod-sim's marketplace endpoint with a listing, open the
 * Marketplace view, click Install on the listing → assert the
 * pod-sim received a POST /api/apps with an IRK-signed install-app
 * envelope.
 */

import { test, expect } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S3 — install a marketplace listing via the webapp", async ({
  page,
  identity,
  podSim,
}) => {
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  await page.click("#open-pod-pair");
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.fill("#pod-pair-label", "e2e-s3");
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  // The pod-sim's marketplace-browse returns []; override that here.
  // The pod proxies /api/screens/marketplace-browse to .com normally,
  // but our pod-sim shortcuts it to a static fixture.
  await page.route("**/api/screens/marketplace-browse**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        listings: [
          {
            creator: "vendorbob",
            slug: "habit-tracker",
            name: "Habit Tracker",
            tagline: "Daily streaks.",
            tags: ["productivity", "habits"],
            category: "productivity",
            canonical_url: "habit-tracker.vendorbob.flagship.services",
            manifest_hash: "ab".repeat(32),
            scan_grade: "A",
            install_count: 42,
            public_distribution: true,
            rank_score: 1.5,
            screenshots: [],
            listed_at: Date.now() - 30 * 86400_000,
            updated_at: Date.now() - 86400_000,
          },
        ],
      }),
    }),
  );

  await page.click("#open-marketplace");
  await expect(page.locator("#view-marketplace")).toBeVisible();
  await expect(page.locator("text=Habit Tracker")).toBeVisible({ timeout: 5_000 });

  // Click Install. The webapp signs an install-app envelope with
  // the IRK and POSTs /api/apps on the pod.
  await page.click('button[data-action="install"]');

  await expect.poll(() => podSim.orders.filterByType("install-app").length, {
    timeout: 5_000,
  }).toBe(1);

  const installed = podSim.orders.filterByType("install-app")[0]!;
  const raw = installed.raw as { creator: string; slug: string };
  expect(raw.creator).toBe("vendorbob");
  expect(raw.slug).toBe("habit-tracker");

  // identity is consumed by the fixture wiring; reference it to
  // keep linters happy.
  void identity;
});
