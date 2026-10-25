/**
 * The server page's Container stack (packages/server-daemon/src/archV2Switch.ts) with no backend: an
 * admin device signs flagship/arch-v2-switch/v1 once (gymKit `sensitive`: only the admin root verifies),
 * dry-runs it to show the box's plan, sends the same order with Move now and follows the move to its
 * trial; a plan without room says why and Move now stays off; a device without the admin root has no card.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, livePod, mock, reachHome, sawToast, sensitive, serverDetail, shot, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const isPath = (path: string) => (u: URL) => u.hostname === HOME && u.pathname === path;
const canon = (o: any) => ["flagship/arch-v2-switch/v1", String(o.serverDomain).toLowerCase(), o.target, o.nonce, o.issuedAt].join("|");

function stackBox(m: Mock, page: Page, keys: Keys, blocked = false) {
  const status: any = {
    stack: "classic",
    engine: "docker",
    switch: null,
    plan: {
      from: "classic",
      target: "arch-v2",
      steps: [
        "Install Podman and the new stack's programs from this server's release",
        "Move 4 app image(s) and 3 volume(s) from Docker to Podman (Docker's copy is kept)",
        "Restart on the new stack, then check every app comes back within 20 minutes",
      ],
      images: 4,
      volumes: 3,
      needBytes: 6 * 2 ** 30,
      freeBytes: (blocked ? 3 : 41) * 2 ** 30,
      blockers: blocked ? [{ code: "no-podman-room", error: "Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB." }] : [],
    },
  };
  let reads = 0;
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  m.get(isPath("/api/screens/server-detail"), serverDetail(HOME));
  m.get(isPath("/api/stack"), () => {
    if (status.switch?.state === "installing" && ++reads >= 2) {
      status.switch = { ...status.switch, state: "trial", trialUntil: Date.now() + 86_400_000 };
      status.stack = "arch-v2";
      status.engine = "podman";
    }
    return { json: status };
  });
  m.post(
    isPath("/api/stack/switch"),
    sensitive(page, keys, canon, (b) => ({ arg: b.order, sig: b.signature }), (c) => {
      if (c.body.dryRun) return { json: { ok: true, dryRun: true, plan: status.plan } };
      if (status.plan.blockers.length) return { status: 409, json: { error: status.plan.blockers[0].error, code: status.plan.blockers[0].code } };
      status.switch = { state: "installing", target: c.body.order.target, startedAt: Date.now() };
      reads = 0;
      return { status: 202, json: { ok: true, state: "restarting", plan: status.plan } };
    }),
  );
  return status;
}

async function openServer(page: Page): Promise<void> {
  await page.evaluate(async (fqdn) => (await import("/views/server-detail.js")).enterServerDetail(fqdn), HOME);
  await expect(page.locator("#local-ai-entry")).toBeVisible({ timeout: 15_000 });
}

test.describe("gym webapp Container stack", () => {
  test("gym stack an admin device dry-runs the move, sends the same signed order and follows it to its trial", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    stackBox(m, page, keys);
    await openServer(page);
    const card = page.locator("#stack-card");
    await expect(card.locator("[data-stack-current]")).toHaveText("This server runs the classic stack (Docker).", { timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await card.locator("#stack-move").click();
    const dry = await m.waitFor("/api/stack/switch");
    expect(dry.body.dryRun).toBe(true);
    await expect(page.locator("#stack-card [data-stack-step]")).toHaveCount(3);
    await expect(page.locator("#stack-card [data-stack-room]")).toContainText("Needs about");
    await shot(page, testInfo, "stack-plan");
    await page.locator("#stack-card #stack-move-now").click();
    const real = await m.waitFor("/api/stack/switch", "POST", 2);
    expect(real.body.dryRun).toBeUndefined();
    expect(real.body.order).toEqual(dry.body.order);
    await sawToast(page, "The server is restarting for the move.");
    await expect(page.locator("#stack-card [data-stack-record]")).toContainText("On trial until", { timeout: 30_000 });
    await expect(page.locator("#stack-card [data-stack-current]")).toHaveText("This server runs the new stack (Podman and the Rust services).");
    await shot(page, testInfo, "stack-trial");
  });

  test("gym stack a plan without room says why and Move now stays off", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    stackBox(m, page, keys, true);
    await openServer(page);
    await page.locator("#stack-card #stack-move").click();
    await expect(page.locator("#stack-card [data-stack-blocker]")).toHaveText("Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.", { timeout: 10_000 });
    await expect(page.locator("#stack-card #stack-move-now")).toBeDisabled();
    expect(m.sent("/api/stack/switch")).toHaveLength(1);
    await shot(page, testInfo, "stack-blocked");
  });

  test("gym stack a device without the admin root has no Container stack card", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    stackBox(m, page, keys);
    await openServer(page);
    await expect(page.locator("#stack-card")).toHaveCount(0);
    expect(m.sent("/api/stack", "GET")).toHaveLength(0);
    await shot(page, testInfo, "stack-admin-only");
  });
});
