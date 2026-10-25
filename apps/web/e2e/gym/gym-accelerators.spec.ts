/**
 * The server page's GPUs (packages/server-daemon/src/gpu/http.ts) with no backend: each GPU with its
 * model, memory and state, the app holding it, the apps waiting; Stop asks first, Cancel sends
 * nothing, Stop posts the allocation and the next app waiting gets the GPU; a box with no GPU (or
 * without the GPU screen) shows no card. Apps asking to use a GPU: Approve signs flagship/gpu-approval/v1
 * under the admin root (gymKit `sensitive`), Decline sends nothing, Withdraw signs
 * flagship/gpu-approval-withdraw/v1; a device without the admin root sees them read-only.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, livePod, mock, reachHome, sawToast, sensitive, serverDetail, shot, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const isPath = (path: string) => (u: URL) => u.hostname === HOME && u.pathname === path;

/** The box's GPUs, stateful: Stop frees the device and hands it to the first app waiting. */
function gpuBox(m: Mock, view: Record<string, any> | null) {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  m.get(isPath("/api/screens/server-detail"), serverDetail(HOME));
  if (view) m.get(isPath("/api/screens/accelerators"), () => ({ json: view }));
  m.post(isPath("/api/screens/accelerators/stop"), (c) => {
    const d = view!.devices.find((x: any) => x.holders.some((h: any) => h.allocationId === c.body?.allocationId));
    if (!d) return { status: 404, json: { error: "That GPU job is not running." } };
    const next = view!.queue.shift();
    d.holders = next ? [{ appId: next.appId, allocationId: `app-${next.appId}-q1`, state: "reserved" }] : [];
    d.state = d.holders.length ? "in-use" : "free";
    return { json: { ok: true, settle: "released" } };
  });
}

function fixture(): Record<string, any> {
  return {
    available: true,
    reason: null,
    admissionPaused: null,
    catalog: { status: "current", serial: 1 },
    devices: [
      { id: "0", model: "NVIDIA GeForce RTX 4090", vendor: "nvidia", memoryMiB: 24564, state: "in-use", holders: [{ appId: "smoketest--plants", allocationId: "app-smoketest--plants-k1", state: "running" }] },
      { id: "1", model: "NVIDIA RTX A2000", vendor: "nvidia", memoryMiB: 6138, state: "free", holders: [] },
      { id: "2", model: "AMD Radeon PRO W7600", vendor: "amd", memoryMiB: 8176, state: "quarantined", holders: [] },
    ],
    queue: [{ appId: "smoketest--wiki", waiting: 1 }],
  };
}

const sorted = (xs: string[]) => [...new Set(xs)].sort().join(",");
const approvalCanon = (b: any) =>
  ["flagship/gpu-approval/v1", b.server, b.appId, b.installationId, b.generation, b.backend, b.maxCount, sorted(b.caps), sorted(b.policies), b.isolation, b.secrecy ? "1" : "0", b.trustDomain ?? "", b.ownerConsent ?? "", b.issuedAt].join("|");
const withdrawCanon = (b: any) => ["flagship/gpu-approval-withdraw/v1", HOME, b.appId, b.installationId, b.generation, b.issuedAt].join("|");

function request(appId: string, installationId: string, generation: number, extra: Record<string, unknown> = {}) {
  return { server: HOME, appId, installationId, generation, backend: "nvidia-cuda", maxCount: 1, caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true, trustDomain: null, ownerConsent: null, ...extra };
}

/** The box's approval routes, answered as an admin-pinned box does. */
function approvalsBox(m: Mock, page: Page, keys: Keys, view: Record<string, any>) {
  view.pendingApprovals = [
    request("smoketest--render", "inst-7f3a", 3),
    request("smoketest--train", "inst-9", 12, { backend: "amd-rocm", maxCount: 4, caps: ["compute", "graphics"], isolation: "vm-passthrough" }),
    request("smoketest--stream", "inst-5", 2, { caps: ["video-encode"], policies: ["cooperative"], secrecy: false }),
  ];
  view.approvals = [{ ...request("smoketest--photos", "inst-01", 1), issuedAt: 1 }];
  m.post(
    isPath("/api/screens/accelerators/approvals"),
    sensitive(page, keys, approvalCanon, (b) => ({ arg: b, sig: b.signature }), (c) => {
      const b = c.body;
      if (b.policies.includes("cooperative") && (!b.trustDomain || !b.ownerConsent)) {
        return { status: 400, json: { error: "Sharing a GPU between apps needs your consent and a trust domain.", code: "needs-trust-domain" } };
      }
      view.pendingApprovals = view.pendingApprovals.filter((r: any) => r.appId !== b.appId);
      const { signature: _s, ...approval } = b;
      view.approvals.push(approval);
      return { json: { ok: true, approval } };
    }),
  );
  m.post(
    isPath("/api/screens/accelerators/approvals/withdraw"),
    sensitive(page, keys, withdrawCanon, (b) => ({ arg: b, sig: b.signature }), (c) => {
      const before = view.approvals.length;
      view.approvals = view.approvals.filter((r: any) => r.appId !== c.body.appId);
      if (view.approvals.length === before) return { status: 404, json: { error: "This app has no GPU approval to withdraw.", code: "not-approved" } };
      return { json: { ok: true, approval: null } };
    }),
  );
}

async function openServer(page: Page): Promise<void> {
  await page.evaluate(async (fqdn) => (await import("/views/server-detail.js")).enterServerDetail(fqdn), HOME);
  await expect(page.locator("#local-ai-entry")).toBeVisible({ timeout: 15_000 });
}

test.describe("gym webapp GPUs", () => {
  test("gym gpus the server page lists each GPU, the app holding it and the apps waiting", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    gpuBox(m, { ...fixture(), admissionPaused: "maintenance" });
    await openServer(page);
    const card = page.locator("#accelerators-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('[data-acc-device="0"] [data-acc-name]')).toHaveText("GPU 0: NVIDIA GeForce RTX 4090");
    await expect(card.locator('[data-acc-device="0"] [data-acc-state]')).toContainText("In use");
    await expect(card.locator('[data-acc-device="0"] [data-acc-holder-line]')).toHaveText("Used by Plants");
    await expect(card.locator('[data-acc-device="1"] [data-acc-state]')).toContainText("Free");
    await expect(card.locator('[data-acc-device="1"] [data-acc-holder]')).toHaveCount(0);
    await expect(card.locator('[data-acc-device="2"] [data-acc-state]')).toContainText("Set aside after a fault");
    await expect(card.locator('[data-acc-waiting="smoketest--wiki"]')).toHaveText("Wiki is waiting");
    await expect(card.locator("[data-acc-paused]")).toHaveText("New GPU work is paused on this server. Apps that already have a GPU keep it.");
    await expect(card.locator("[data-acc-stop]")).toHaveCount(1);
    await shot(page, testInfo, "gpus-card");
  });

  test("gym gpus Stop asks first, Cancel sends nothing, Stop frees the GPU for the app waiting", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    gpuBox(m, fixture());
    await openServer(page);
    const card = page.locator("#accelerators-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await card.locator('[data-acc-stop="app-smoketest--plants-k1"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Stop Plants using the GPU?");
    await page.locator("[data-modal-cancel]").click();
    expect(m.sent("/api/screens/accelerators/stop")).toHaveLength(0);
    await card.locator('[data-acc-stop="app-smoketest--plants-k1"]').click();
    await shot(page, testInfo, "gpus-stop-ask");
    await page.locator("[data-modal-ok]").click();
    const call = await m.waitFor("/api/screens/accelerators/stop");
    expect(call.body).toEqual({ allocationId: "app-smoketest--plants-k1" });
    await sawToast(page, "Plants no longer has the GPU.");
    const after = page.locator("#accelerators-card");
    await expect(after.locator("[data-acc-notice]")).toHaveText("Plants no longer has the GPU.", { timeout: 10_000 });
    await expect(after.locator('[data-acc-device="0"] [data-acc-holder-line]')).toHaveText("Starting for Wiki");
    await expect(after.locator("[data-acc-queue]")).toHaveCount(0);
    await shot(page, testInfo, "gpus-stopped");
  });

  test("gym gpus an app's GPU request is approved with the admin root, another declined without sending, an approval withdrawn", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    const view = fixture();
    gpuBox(m, view);
    approvalsBox(m, page, keys, view);
    await openServer(page);
    const card = page.locator("#accelerators-card");
    await expect(card.locator('[data-acc-pending="smoketest--render"] [data-acc-ask]')).toHaveText(
      "Render asks to use the GPU: 1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps",
      { timeout: 15_000 },
    );
    await card.locator('[data-acc-pending="smoketest--render"]').scrollIntoViewIfNeeded();
    await shot(page, testInfo, "gpu-approval-pending");
    await card.locator('[data-acc-approve="smoketest--render|inst-7f3a|3"]').click();
    const call = await m.waitFor("/api/screens/accelerators/approvals");
    expect(call.body).toMatchObject({ server: HOME, appId: "smoketest--render", installationId: "inst-7f3a", generation: 3, trustDomain: null, ownerConsent: null });
    await sawToast(page, "Render can use the GPU.");
    await expect(page.locator('#accelerators-card [data-acc-granted="smoketest--render"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('#accelerators-card [data-acc-decline="smoketest--train|inst-9|12"]').click();
    await expect(page.locator("#accelerators-card [data-acc-notice]")).toHaveText("Train won't get a GPU.");
    await expect(page.locator('#accelerators-card [data-acc-pending="smoketest--train"]')).toHaveCount(0);

    await page.locator('#accelerators-card [data-acc-approve="smoketest--stream|inst-5|2"]').click();
    await m.waitFor("/api/screens/accelerators/approvals", "POST", 2);
    expect(m.last("/api/screens/accelerators/approvals")!.body).toMatchObject({ appId: "smoketest--stream", trustDomain: "owner-apps" });
    await expect(page.locator('#accelerators-card [data-acc-granted="smoketest--stream"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('#accelerators-card [data-acc-withdraw="smoketest--photos|inst-01|1"]').click();
    const w = await m.waitFor("/api/screens/accelerators/approvals/withdraw");
    expect(Object.keys(w.body).sort()).toEqual(["appId", "generation", "installationId", "issuedAt", "signature"]);
    await expect(page.locator("#accelerators-card [data-acc-notice]")).toHaveText("Photos can no longer use the GPU.", { timeout: 10_000 });
    await expect(page.locator('#accelerators-card [data-acc-granted="smoketest--photos"]')).toHaveCount(0);
    expect(m.sent("/api/screens/accelerators/approvals/withdraw")).toHaveLength(1);
    await shot(page, testInfo, "gpu-approval-answered");
  });

  test("gym gpus a non-admin device sees GPU requests read-only", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    const view = fixture();
    gpuBox(m, view);
    approvalsBox(m, page, keys, view);
    await openServer(page);
    const card = page.locator("#accelerators-card");
    await expect(card.locator("[data-acc-admin-only]")).toHaveText("Only an admin device can approve GPU use. This device can see it.", { timeout: 15_000 });
    await expect(card.locator("[data-acc-approve]")).toHaveCount(0);
    await expect(card.locator("[data-acc-withdraw]")).toHaveCount(0);
    await card.locator("[data-acc-approvals]").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "gpu-approval-read-only");
  });

  test("gym gpus a box with no GPU shows no card", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    gpuBox(m, { available: false, reason: "no-gpu-service", admissionPaused: null, catalog: { status: "unknown", serial: null }, devices: [], queue: [] });
    await openServer(page);
    await expect.poll(() => m.sent("/api/screens/accelerators", "GET").length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator("#accelerators-card")).toHaveCount(0);
    await shot(page, testInfo, "gpus-none");
  });

  test("gym gpus an older box without the GPU screen shows no card", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    gpuBox(m, null);
    await openServer(page);
    await expect.poll(() => m.sent("/api/screens/accelerators", "GET").length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator("#accelerators-card")).toHaveCount(0);
    await expect(page.locator("#accelerators-slot")).toBeEmpty();
    await shot(page, testInfo, "gpus-older-box");
  });
});
