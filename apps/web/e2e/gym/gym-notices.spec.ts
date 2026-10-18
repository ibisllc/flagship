/**
 * Security notices on the webapp with no backend (docs/security-notices.md,
 * parity/features.json: security-notices): the maintenance banner, the
 * "Update required" lock (full screen, the page behind it inert, every menu
 * and dialog closed, nothing sent to a server, the key backup and Sign out
 * still there), and the fail-open rules, including a forged lock from `.com`
 * that the baked pin refuses.
 *
 * `.com` is one recorded router (gymKit `mock`). The page's own poller trusts
 * only the baked pin, so a notice counts here only where the spec hands the
 * page the test authority's pin (noticeKit); where it must NOT count, it
 * doesn't.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, livePod, mock, reachHome, shot, type Mock } from "./gymKit.js";
import { DAY, authority, lockBody, maintenanceBody } from "./noticeKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const path = (p: string) => (u: URL) => u.pathname === p;

async function home(page: Page): Promise<Mock> {
  await reachHome(page, { kind: "admin", servers: [HOME] });
  const m = await mock(page);
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  return m;
}

/** Fetch `/api/notices` the way the poller does, trusting `pin` (null: the baked pin). */
async function refresh(page: Page, pin: string | null, client?: { platform: string; build: number; protocol: number }): Promise<unknown> {
  return page.evaluate(
    async ({ pin, client }) => {
      const sn = await import("/lib/securityNotice.js");
      return sn.refreshSecurityNotice({ ...(pin ? { pin } : {}), ...(client ? { client } : {}) });
    },
    { pin, client: client ?? null },
  );
}

test.describe("gym webapp security notices", () => {
  test("gym notice a maintenance notice shows a dismissible banner with the date", async ({ page }, testInfo) => {
    const m = await home(page);
    const a = authority(0x21);
    m.get(path("/api/notices"), a.doc(maintenanceBody()));
    await refresh(page, a.pin);
    const banner = page.locator("#notice-banner");
    await expect(banner).toBeVisible();
    await expect(banner.locator("[data-testid=notice-banner-text]")).toContainText("We will update on ");
    await expect(banner.locator("[data-testid=notice-banner-text]")).toContainText("flagshipserver.com may be briefly unavailable.");
    await expect(banner.locator("[data-testid=notice-banner-text]")).not.toContainText("{date}");
    await expect(page.locator("#update-lock")).toBeHidden();
    await shot(page, testInfo, "notice-banner");

    // The request carried nothing about the caller.
    const call = m.calls.find((c) => c.url.pathname === "/api/notices")!;
    expect(call.method).toBe("GET");
    expect(call.url.search).toBe("");
    expect(call.headers["cookie"]).toBeUndefined();
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["x-flagship-session"]).toBeUndefined();

    await banner.locator("[data-testid=notice-banner-dismiss]").click();
    await expect(banner).toBeHidden();
    await expect(page.locator("#view-home")).toBeVisible();
  });

  test("gym notice a verified update-required notice locks the app until it is updated", async ({ page }, testInfo) => {
    const m = await home(page);
    const a = authority(0x22);
    m.get(path("/api/notices"), a.doc(lockBody()));

    // A menu is open when the lock arrives: it must not survive.
    await page.evaluate(async () => (await import("/views/home.js")).renderHome());
    await page.click("#home-add-server");
    await expect(page.locator('dialog[aria-label="Add or restore a server"]')).toBeVisible();

    await refresh(page, a.pin);
    const lock = page.locator("#update-lock");
    await expect(lock).toBeVisible();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(lock.locator("#update-lock-title")).toHaveText("Update required");
    await expect(lock.locator("[data-testid=update-lock-body]")).toHaveText("You must update Flagship. Older versions have stopped working.");
    await expect(lock.locator("[data-testid=update-lock-why]")).toHaveText("Why: A signing flaw lets an attacker act as you.");
    await expect(lock).toContainText("Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.");
    await expect(lock).toContainText("Advisory FSA-2026-001");
    await expect(lock).toContainText("Signed by the Flagship maintainers");
    await expect(lock.locator("[data-testid=update-lock-update]")).toHaveText("Reload to update");
    await expect(lock.locator("[data-testid=update-lock-backup]")).toHaveText("Back up my account key");
    await expect(lock.locator("[data-testid=update-lock-signout]")).toHaveText("Sign out");
    await shot(page, testInfo, "update-lock");

    // The page behind it is inert.
    const inert = await page.evaluate(() => ["header", "main", "nav"].map((s) => document.querySelector(s)?.hasAttribute("inert")));
    expect(inert).toEqual([true, true, true]);

    // Nothing leaves the page but reads from .com and the shell.
    const before = m.calls.length;
    const results = await page.evaluate(async () => {
      const tryFetch = async (url: string, init?: RequestInit) => {
        try {
          await fetch(url, init);
          return "sent";
        } catch (e) {
          return (e as { updateRequired?: boolean }).updateRequired ? "refused" : "failed";
        }
      };
      return {
        order: await tryFetch("https://home.smoketest.flagship.services/api/screens/orders", { method: "POST", body: "{}" }),
        boxRead: await tryFetch("https://home.smoketest.flagship.services/api/screens/pods"),
        comWrite: await tryFetch("https://flagshipserver.com/api/accounts/smoketest/server-order", { method: "POST", body: "{}" }),
        comRead: await tryFetch("https://flagshipserver.com/api/users/smoketest/pods"),
      };
    });
    expect(results).toEqual({ order: "refused", boxRead: "refused", comWrite: "refused", comRead: "sent" });
    expect(m.calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);

    // The key backup stays reachable, above the lock.
    await lock.locator("[data-testid=update-lock-backup]").click();
    await expect(page.locator(".modal-overlay")).toContainText("ACCOUNT BACKUP");
    await page.locator("[data-cancel]").click();
    await expect(lock).toBeVisible();
  });

  test("gym notice the lock lifts when the build is updated or the notice ends, and an older notice cannot bring it back", async ({ page }, testInfo) => {
    const m = await home(page);
    const a = authority(0x23);
    const lock = page.locator("#update-lock");
    m.get(path("/api/notices"), a.doc(lockBody({ seq: 7 })));
    await refresh(page, a.pin);
    await expect(lock).toBeVisible();

    // The webapp was updated past the minimum: unlocked, the app usable again.
    await page.evaluate(async (pin) => {
      const sn = await import("/lib/securityNotice.js");
      await sn.evaluateSecurityNotice({ pin, client: { platform: "web", build: 100_000, protocol: 1 } });
    }, a.pin);
    await expect(lock).toBeHidden();
    await expect(page.locator("header")).not.toHaveAttribute("inert", "");

    // Locked again on the real build; then past validUntil it ends by itself.
    await page.evaluate(async (pin) => (await import("/lib/securityNotice.js")).evaluateSecurityNotice({ pin }), a.pin);
    await expect(lock).toBeVisible();
    await page.evaluate(async (pin) => {
      const sn = await import("/lib/securityNotice.js");
      await sn.evaluateSecurityNotice({ pin, now: Date.now() + 11 * 24 * 3600_000 });
    }, a.pin);
    await expect(lock).toBeHidden();

    // A signed all clear supersedes the lock; replaying the lock afterwards is refused.
    await page.evaluate(async (pin) => (await import("/lib/securityNotice.js")).evaluateSecurityNotice({ pin }), a.pin);
    await expect(lock).toBeVisible();
    const clear = a.doc(lockBody({ seq: 8, kind: "none", lockFrom: 0, platforms: {}, advisoryId: "", reason: "", message: "" }));
    m.first("GET", path("/api/notices"), clear);
    await refresh(page, a.pin);
    await expect(lock).toBeHidden();
    m.first("GET", path("/api/notices"), a.doc(lockBody({ seq: 7 })));
    const replay = (await refresh(page, a.pin)) as { refused: string };
    expect(replay.refused).toBe("stale");
    await expect(lock).toBeHidden();
    await shot(page, testInfo, "notice-lock-lifted");
  });

  test("gym notice fails open: a lock the baked pin cannot vouch for, an unreachable endpoint and junk lock nothing", async ({ page }, testInfo) => {
    const m = await home(page);
    const forger = authority(0x24);
    // A compromised .com serves a lock signed by its own chain; the page trusts only the baked pin.
    m.get(path("/api/notices"), forger.doc(lockBody()));
    const forged = (await refresh(page, null)) as { refused: string };
    expect(forged.refused).toBe("unauthorized-signer");
    await expect(page.locator("#update-lock")).toBeHidden();
    await expect(page.locator("#view-home")).toBeVisible();
    await shot(page, testInfo, "notice-forged-ignored");

    for (const answer of [
      { status: 500, json: { error: "boom" } },
      { status: 200, json: { version: 1, notice: "x", mandates: [] } },
      { status: 200, json: { version: 9 } },
    ]) {
      m.first("GET", path("/api/notices"), () => answer);
      await refresh(page, forger.pin);
      await expect(page.locator("#update-lock")).toBeHidden();
    }
    // A lock whose window is longer than 30 days is not even a notice.
    const tooLong = forger.doc(lockBody());
    (tooLong.notice as { validUntil: number }).validUntil = Date.now() + 40 * DAY;
    m.first("GET", path("/api/notices"), tooLong);
    await refresh(page, forger.pin);
    await expect(page.locator("#update-lock")).toBeHidden();
    await expect(page.locator("#notice-banner")).toBeHidden();
  });

  test("gym notice an update-required notice nags until its lock date, then locks", async ({ page }, testInfo) => {
    const m = await home(page);
    const a = authority(0x25);
    m.get(path("/api/notices"), a.doc(lockBody({ lockFrom: Date.now() + 2 * DAY, eventAt: Date.now() + 2 * DAY, message: "You must update Flagship by {date}. Older versions will stop working." })));
    await refresh(page, a.pin);
    const banner = page.locator("#notice-banner");
    await expect(banner).toBeVisible();
    await expect(banner.locator("[data-testid=notice-banner-text]")).toContainText("You must update Flagship by ");
    await expect(banner.locator("[data-testid=notice-banner-update]")).toHaveText("Reload to update");
    await expect(page.locator("#update-lock")).toBeHidden();
    await shot(page, testInfo, "notice-grace-nag");
    await page.evaluate(async (pin) => {
      const sn = await import("/lib/securityNotice.js");
      await sn.evaluateSecurityNotice({ pin, now: Date.now() + 2 * 24 * 3600_000 + 5000 });
    }, a.pin);
    await expect(page.locator("#update-lock")).toBeVisible();
    await expect(banner).toBeHidden();
  });
});
