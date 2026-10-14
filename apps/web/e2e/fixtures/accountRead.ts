import type { Page } from "@playwright/test";

/** Answer the webapp's account-read-token mint (docs/account-read-token.md)
 *  so a spec that stubs `/pods` never reaches a real `.com` to mint first. */
export async function stubAccountReadToken(page: Page): Promise<void> {
  await page.route("**/api/accounts/*/read-token", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "art1.e2e.mac", expiresAt: Date.now() + 86_400_000 }),
    }),
  );
}
