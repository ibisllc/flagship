/**
 * S3 — marketplace browse + install.
 *
 * Seed the pod-sim's marketplace endpoint with a listing, open the
 * Marketplace view, click Install on the listing → assert the
 * pod-sim received a POST /api/apps with an IRK-signed install-app
 * envelope.
 */

import { test, expect, syncWebappPubkey } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S3 — install a marketplace listing via the webapp", async ({
  page,
  identity,
  podSim,
}) => {
  // runInstall() calls window.confirm(); stub it before page scripts run.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "confirm", {
      value: () => true,
      writable: true,
      configurable: true,
    });
  });
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await syncWebappPubkey(page, podSim);

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
            // Webapp's marketplace view reads title / summary /
            // installCount (camelCase). Server-side data uses
            // snake_case for some fields; the BFF flattens. Keep this
            // fixture in the BFF-flat shape.
            title: "Habit Tracker",
            summary: "Daily streaks.",
            tags: ["productivity", "habits"],
            category: "productivity",
            canonicalUrl: "habit-tracker.vendorbob.flagship.services",
            manifestHash: "ab".repeat(32),
            scanGrade: "A",
            installCount: 42,
            publicDistribution: true,
            rankScore: 1.5,
            screenshots: [],
            listedAt: Date.now() - 30 * 86400_000,
            updatedAt: Date.now() - 86400_000,
          },
        ],
      }),
    }),
  );

  // installFromMarketplace fetches the per-listing endpoint to get
  // the canonical manifestJson before signing. Stub it so the install
  // POST can proceed.
  // installFromMarketplace fetches the per-listing endpoint to get
  // the canonical manifestJson before signing. Stub it.
  await page.route("**/api/marketplace/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        creator: "vendorbob",
        slug: "habit-tracker",
        manifestJson: JSON.stringify({
          name: "Habit Tracker",
          version: "1.0.0",
          slug: "habit-tracker",
          creator: "vendorbob",
        }),
      }),
    }),
  );

  await page.click("#open-marketplace");
  await expect(page.locator("#view-marketplace")).toBeVisible();
  await expect(page.locator("text=Habit Tracker")).toBeVisible({ timeout: 5_000 });

  // confirm() is already stubbed via addInitScript at the top.
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
