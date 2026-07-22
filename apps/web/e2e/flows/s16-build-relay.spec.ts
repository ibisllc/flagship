/**
 * S16 — Compose draft + Deliver now (#24 + #59).
 *
 * E2E smoke of the webapp's create-server view against the live origin.
 *
 *   - bootstraps a fresh identity (random UMK from the in-browser keystore)
 *   - opens the create-server view via its module entry hook
 *   - fills the form, saves the draft
 *   - asserts the rendered card carries the typed server name
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
    // as 'view did not appear' Playwright timeouts.
    page.on("pageerror", (e) => console.error("[page error]", e.message));

    await page.goto("/");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await bootstrapToHome(page, PASSPHRASE);

    // Drive the view directly via its module entry hook. The hash
    // router only listens to button clicks (no popstate handler), so
    // page.goto("/#create-server") wouldn't fire the transition.
    await page.evaluate(async () => {
      const m = (await import("/views/create-server.js" as string)) as {
        enterCreateServer(): Promise<void>;
      };
      await m.enterCreateServer();
    });
    await expect(page.locator("#view-create-server")).toBeVisible();

    const serverName = `home-${Date.now().toString(36)}`;
    await page.fill("#cs-server-name", serverName);
    await page.selectOption("#cs-backup-policy", "phone-only");
    await page.fill("#cs-llm-pref", "anthropic:claude-opus-4-7");
    await page.click("#cs-save-draft");

    // The drafts list re-renders with the new card. The race-safe
    // refreshDrafts (gen-counter) guarantees the latest render wins.
    await expect(page.locator("#cs-drafts")).toContainText(serverName);
    await expect(
      page.locator("#cs-drafts .pill", { hasText: /draft/i }),
    ).toBeVisible();

    // Resume the draft — the form re-populates.
    await page.click("#cs-new"); // clear the form first
    await expect(page.locator("#cs-server-name")).toHaveValue("");
    await page.click("#cs-drafts button[data-action='resume']");
    await expect(page.locator("#cs-server-name")).toHaveValue(serverName);
    // textarea — Playwright's toContainText checks textContent, which
    // is empty for inputs; use toHaveValue for the typed string.
    await expect(page.locator("#cs-llm-pref")).toHaveValue(
      /anthropic:claude-opus-4-7/,
    );
  });
});
