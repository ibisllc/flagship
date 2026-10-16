/**
 * The Activity tab with no backend: each server's own log
 * (`/api/screens/activity`: updates, migration, backups, imports, app changes,
 * shares) merged with the account events from `.com`, newest first; the
 * per-server chips; the post-recovery report card; "See all account history"
 * and its Load more; the install tracker entry. Mirrors iOS/Android
 * ActivityScreen (parity/features.json: activity-feed).
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, OFFICE, livePod, mock, reachHome, shot, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const NOW = Date.now();
const H = 3_600_000;

const box = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;

function stubFeed(m: Mock): void {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
  m.get(box(HOME, "/api/screens/activity"), {
    entries: [
      { ts: NOW - 1 * H, kind: "server.backup.created", ok: true, detail: "2 apps, 41 MB" },
      { ts: NOW - 2 * H, kind: "server.update.applied", ok: true, detail: "7ac1b50a → 52d0b375" },
      { ts: NOW - 3 * H, kind: "server.restore.finished", ok: true },
      { ts: NOW - 5 * H, kind: "server.migration.taken-over", ok: true },
      { ts: NOW - 6 * H, kind: "share.granted", ok: true, actor: { kind: "owner" }, detail: "kim, can manage" },
      { ts: NOW - 7 * H, kind: "server.backup.failed", ok: false, detail: "disk full" },
      // An owner write the box logs generically: not worth a row.
      { ts: NOW - 30 * 60_000, action: "post /api/screens/front-page", ok: true },
    ],
  });
  m.get(box(OFFICE, "/api/screens/activity"), {
    entries: [{ ts: NOW - 30 * 60_000, kind: "app.installed", ok: true, detail: "notes" }],
  });
  m.get(box(HOME, "/api/screens/post-recovery/status"), {
    report: { status: "done", totalRewritten: 3, reattachedCount: 2 },
  });
  m.get(/\/api\/users\/smoketest\/audit/, (call) => {
    const limit = Number(call.url.searchParams.get("limit") ?? "20");
    // 40 account events in all, newest first; the inline feed asks for 20.
    const events = Array.from({ length: Math.min(limit, 40) }, (_, i) => ({
      seq: 40 - i,
      eventKind: i === 0 ? "totp-enrolled" : "device-added",
      detail: "",
      devicePrefix: "abcd",
      postedAt: NOW - 4 * H - i * 60_000,
    }));
    return { json: { events } };
  });
}

/** Feed card titles, top to bottom. */
async function titles(page: Page): Promise<string[]> {
  return page.locator("#activity-feed > .card .row .value").evaluateAll((els) =>
    els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
}

test.describe("gym webapp activity", () => {
  test("gym activity merges every server's log with account events, newest first", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    stubFeed(m);
    await page.click('[data-tab-target="activity"]');
    await expect(page.locator("#view-activity")).toBeVisible();
    const feed = page.locator("#activity-feed");
    await expect(feed).toContainText("Backup ready", { timeout: 15_000 });

    // The current server's log, newest first, with the account events in
    // between by time; the generic owner-write line is left out.
    const shown = await titles(page);
    const at = (t: string) => shown.findIndex((s) => s.includes(t));
    expect(at("Backup ready")).toBeGreaterThanOrEqual(0);
    expect(at("Backup ready")).toBeLessThan(at("Server updated"));
    expect(at("Server updated")).toBeLessThan(at("Import finished"));
    expect(at("Import finished")).toBeLessThan(at("Turned on authenticator codes"));
    expect(at("Turned on authenticator codes")).toBeLessThan(at("Took over from the old server"));
    expect(at("Took over from the old server")).toBeLessThan(at("Shared this server"));
    expect(at("Shared this server")).toBeLessThan(at("Backup failed"));
    expect(shown.some((s) => /front page/i.test(s))).toBe(false);
    // A failed entry gets the warning card.
    await expect(feed.locator(".card.warning")).toContainText("Backup failed");
    await expect(feed.locator(".card.warning")).toContainText("disk full");
    await expect(feed).toContainText("7ac1b50a → 52d0b375");
    await shot(page, testInfo, "activity-merged");

    // The post-recovery report card.
    await expect(feed).toContainText("Post-recovery report");
    await expect(feed).toContainText("3 rewrites · 2 apps reattached");
  });

  test("gym activity server chips scope the log to one server or show all of them", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    stubFeed(m);
    await page.click('[data-tab-target="activity"]');
    const feed = page.locator("#activity-feed");
    const chips = feed.locator("[data-pod-switch]");
    await expect(chips).toHaveCount(3, { timeout: 15_000 });
    await expect(chips.first()).toHaveText("All servers");
    // The current server (home) is selected: only its log.
    await expect(feed.locator('[data-pod-switch][aria-pressed="true"]')).toContainText("home");
    await expect(feed).toContainText("Backup ready");
    await expect(feed).not.toContainText("App installed");

    // office: its log only.
    await feed.locator(`[data-pod-switch="https://${OFFICE}"]`).click();
    await expect(feed).toContainText("App installed", { timeout: 10_000 });
    await expect(feed).not.toContainText("Backup ready");
    await expect(feed.locator('[data-pod-switch][aria-pressed="true"]')).toContainText("office");
    await shot(page, testInfo, "activity-office");

    // All servers: both logs, each row naming its server.
    await feed.locator('[data-pod-switch=""]').click();
    await expect(feed).toContainText("App installed", { timeout: 10_000 });
    await expect(feed).toContainText("Backup ready");
    const installed = feed.locator(".card", { hasText: "App installed" });
    await expect(installed.locator("p.note").first()).toHaveText("office");
    const backup = feed.locator(".card", { hasText: "Backup ready" });
    await expect(backup.locator("p.note").first()).toHaveText("home");
    await shot(page, testInfo, "activity-all-servers");
  });

  test("gym activity See all account history pages through the account events and comes back", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    stubFeed(m);
    await page.click('[data-tab-target="activity"]');
    await page.locator("#activity-see-all-audit").click();
    await expect(page.locator("#view-account-audit")).toBeVisible();
    const cards = page.locator("#account-audit-content [data-audit-seq]");
    await expect(cards).toHaveCount(30, { timeout: 10_000 });
    await expect(cards.first()).toHaveAttribute("data-audit-seq", "40");
    await expect(cards.first()).toContainText("Turned on authenticator codes");
    await shot(page, testInfo, "account-history");

    // Load more asks for a bigger window; the server has 40 in all, so the
    // button goes once everything is shown.
    await page.locator("#account-audit-load-more").click();
    await expect(cards).toHaveCount(40, { timeout: 10_000 });
    await expect(page.locator("#account-audit-load-more")).toHaveCount(0);
    expect(m.sent(/\/audit\?.*limit=50/, "GET").length).toBeGreaterThan(0);

    // Refresh reads it again.
    const before = m.sent("/api/users/smoketest/audit", "GET").length;
    await page.locator("#account-audit-refresh").click();
    await expect.poll(() => m.sent("/api/users/smoketest/audit", "GET").length).toBeGreaterThan(before);
    await expect(cards).toHaveCount(30, { timeout: 10_000 });

    await page.locator("#account-audit-back").click();
    await expect(page.locator("#view-activity")).toBeVisible();
  });

  test("gym activity View report opens the post-recovery report and the install tracker opens", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    stubFeed(m);
    await page.click('[data-tab-target="activity"]');
    await page.locator("#activity-feed-open-recovery").click();
    await expect(page.locator("#view-post-recovery")).toBeVisible();
    // The report loads (it used to open without asking the box).
    await m.waitFor("/api/screens/post-recovery/status", "GET");
    await shot(page, testInfo, "activity-recovery-report");
    // Back returns to Activity, where it was opened.
    await page.locator("#post-recovery-back").click();
    await expect(page.locator("#view-activity")).toBeVisible();

    await page.click('[data-tab-target="activity"]');
    await page.locator("#activity-open-install-progress").click();
    await expect(page.locator("#view-install-progress")).toBeVisible();
    await shot(page, testInfo, "activity-install-tracker");
  });
});
