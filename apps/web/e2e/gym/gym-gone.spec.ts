/**
 * "This account was removed" on the webapp with no backend (docs/account-gone.md,
 * parity/features.json: account-gone): `.com` answers `404 account-not-found`
 * for the signed-in browser's own account, so a full-screen state takes over
 * (every menu and dialog closed, the page behind it inert), nothing keeps
 * asking, no error toast repeats. It leads with Save my servers' data (coming
 * soon until the rescue flow lands), then Create a new account, then a quiet
 * Remove it from this browser; on a device that holds an admin key both of the
 * last two ask first, in plain words (docs/account-gone.md).
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, livePod, mock, reachHome, shot, toasts, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const GONE = () => ({ status: 404, json: { error: "account-not-found", code: "account-not-found" } });
const ownCalls = (m: Mock) => m.calls.filter((c) => /^\/api\/(users|accounts)\/smoketest(\/|$)/.test(c.url.pathname));

async function goneHome(page: Page): Promise<Mock> {
  await reachHome(page, { kind: "admin", servers: [HOME] });
  const m = await mock(page);
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  return m;
}

/** What the live-sync loop does on its next tick: ask for the account's servers. */
async function askForServers(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { liveSync } = await import("/lib/liveSync.js");
    await liveSync.refresh();
  });
}

test.describe("gym webapp account gone", () => {
  test("gym account-gone a removed account shows This account was removed and stops asking", async ({ page }, testInfo) => {
    const m = await goneHome(page);
    // A menu is open when the answer arrives: it must not survive.
    await page.evaluate(async () => (await import("/views/home.js")).renderHome());
    await page.click("#home-add-server");
    await expect(page.locator('dialog[aria-label="Add or restore a server"]')).toBeVisible();

    m.first("GET", /\/api\/users\/smoketest\//, GONE);
    m.first("POST", /\/api\/accounts\/smoketest\//, GONE);
    await askForServers(page);

    const screen = page.locator("#account-gone");
    await expect(screen).toBeVisible();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(screen.locator("#account-gone-title")).toHaveText("This account was removed");
    await expect(screen.locator("[data-testid=account-gone-body]")).toHaveText(
      "This account no longer exists on Flagship. This can happen after a reset.",
    );
    await expect(screen.locator("[data-testid=account-gone-save]")).toHaveText("Save my servers' data");
    await expect(screen.locator("[data-testid=account-gone-save]")).toBeDisabled();
    await expect(screen.locator("[data-testid=account-gone-save-soon]")).toHaveText("Coming soon");
    await expect(screen.locator("[data-testid=account-gone-create]")).toHaveText("Create a new account");
    await expect(screen.locator("[data-testid=account-gone-remove]")).toHaveText("Remove it from this browser");
    await expect(screen.locator("[data-testid=account-gone-remove]")).toHaveClass(/ghost/);
    const y = async (id: string) => (await screen.locator(`[data-testid=${id}]`).boundingBox())!.y;
    expect(await y("account-gone-save")).toBeLessThan(await y("account-gone-create"));
    expect(await y("account-gone-create")).toBeLessThan(await y("account-gone-remove"));
    await expect(screen.locator("[data-testid=account-gone-name]")).toHaveText("Account: smoketest");
    await shot(page, testInfo, "account-gone");

    // The page behind it is inert.
    const inert = await page.evaluate(() => ["header", "main", "nav"].map((s) => document.querySelector(s)?.hasAttribute("inert")));
    expect(inert).toEqual([true, true, true]);

    // No retry storm: after the first 404 nothing more is sent for this account.
    const sentSoFar = ownCalls(m).length;
    await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) {
        await fetch("https://flagshipserver.com/api/users/smoketest/pods");
        await fetch("https://flagshipserver.com/api/users/smoketest/stream?cursor=x");
        await fetch("https://flagshipserver.com/api/accounts/smoketest/read-token", { method: "POST" });
      }
      const { liveSync } = await import("/lib/liveSync.js");
      await liveSync.refresh();
    });
    await page.waitForTimeout(1200);
    expect(ownCalls(m).length).toBe(sentSoFar);

    // No error toast while it is gone.
    await page.evaluate(async () => (await import("/lib/toast.js")).toast("That didn't work", "err"));
    expect((await toasts(page)).filter((t) => t.includes("That didn't work"))).toEqual([]);
  });

  test("gym account-gone another account's 404, or a 404 with no code, changes nothing", async ({ page }) => {
    const m = await goneHome(page);
    m.first("GET", /\/api\/users\/shared-owner\//, GONE);
    m.first("GET", /\/api\/users\/smoketest\/audit/, () => ({ status: 404, json: { error: "username not registered" } }));
    await page.evaluate(async () => {
      await fetch("https://flagshipserver.com/api/users/shared-owner/pods");
      await fetch("https://flagshipserver.com/api/users/smoketest/audit");
    });
    await expect(page.locator("#account-gone")).toBeHidden();
    await expect(page.locator("#view-home")).toBeVisible();
  });

  test("gym account-gone Remove it from this browser forgets the account and returns to the welcome view", async ({ page }, testInfo) => {
    const m = await goneHome(page);
    m.first("GET", /\/api\/users\/smoketest\//, GONE);
    await askForServers(page);
    await expect(page.locator("#account-gone")).toBeVisible();

    // This device holds an admin key: the first tap only asks.
    await page.locator("[data-testid=account-gone-remove]").click();
    const confirm = page.locator("[data-testid=account-gone-confirm]");
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("[data-testid=account-gone-confirm-text]")).toHaveText(
      "This also removes this browser's admin key. Without it you can no longer save your servers' data. Save it first, or remove anyway.",
    );
    await expect(confirm.locator("[data-testid=account-gone-confirm-save]")).toHaveText("Save my data first");
    await expect(confirm.locator("[data-testid=account-gone-confirm-anyway]")).toHaveText("Remove anyway");
    await shot(page, testInfo, "account-gone-confirm");

    // Save my data first opens the key backup and removes nothing.
    await confirm.locator("[data-testid=account-gone-confirm-save]").click();
    await expect(page.locator(".modal-overlay")).toContainText("ACCOUNT BACKUP");
    await page.locator("[data-cancel]").click();
    await expect(page.locator("#account-gone")).toBeVisible();
    expect(await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().umk)).toBe(true);
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem("flagship.profiles.v1") ?? "{}").profiles ?? [])).length).toBe(1);

    await page.locator("[data-testid=account-gone-remove]").click();
    await page.locator("[data-testid=account-gone-confirm-anyway]").click();
    await expect(page.locator("#account-gone")).toBeHidden();
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    await expect(page.locator("[data-testid=welcome-create]")).toBeVisible();
    await expect(page.locator("header")).not.toHaveAttribute("inert", "");
    await shot(page, testInfo, "account-gone-removed");

    // Nothing of the account is left: the stored key is gone and the profile row too.
    const left = await page.evaluate(() => ({
      profiles: JSON.parse(localStorage.getItem("flagship.profiles.v1") ?? "{}").profiles ?? [],
    }));
    expect(left.profiles).toEqual([]);
    await page.reload();
    await page.waitForTimeout(1500);
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#view-unlock")).toBeHidden();
    await expect(page.locator("#account-gone")).toBeHidden();
  });

  test("gym account-gone Create a new account removes the old one and opens the create flow", async ({ page }) => {
    const m = await goneHome(page);
    m.first("GET", /\/api\/users\/smoketest\//, GONE);
    await askForServers(page);
    await expect(page.locator("#account-gone")).toBeVisible();

    await page.locator("[data-testid=account-gone-create]").click();
    await expect(page.locator("[data-testid=account-gone-confirm]")).toBeVisible();
    await page.locator("[data-testid=account-gone-confirm-anyway]").click();
    await expect(page.locator("#account-gone")).toBeHidden();
    await expect(page.locator(".modal-title")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".modal-input")).toBeVisible();
    const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("flagship.profiles.v1") ?? "{}").profiles ?? []);
    expect(profiles).toEqual([]);
  });

  test("gym account-gone a device that holds no admin key or server key removes at once", async ({ page }) => {
    const m = await goneHome(page);
    await page.evaluate(async () => {
      (await import("/lib/state.js")).getSession().adminRootSeed = null;
      const store = await import("/lib/profilesStore.js");
      for (const id of store.listPodTokenIds()) store.removeSessionTokenFor(id);
    });
    m.first("GET", /\/api\/users\/smoketest\//, GONE);
    await askForServers(page);
    await expect(page.locator("#account-gone")).toBeVisible();
    await page.locator("[data-testid=account-gone-remove]").click();
    await expect(page.locator("[data-testid=account-gone-confirm]")).toBeHidden();
    await expect(page.locator("#account-gone")).toBeHidden();
    await expect(page.locator("[data-testid=welcome-create]")).toBeVisible();
  });
});
