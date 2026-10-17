/**
 * The server page's Backups section and the create form's backup policy
 * (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled backups")
 * with no backend. The mock box answers /api/screens/backup-policy and
 * /api/screens/server-archive/backups* with the real box's shapes and
 * sentences; every signed message (flagship/server-archive-keys/v1,
 * flagship/backup-policy/v1, flagship/archive-download/v1) is checked the way
 * an admin-pinned box checks it (gymKit `sensitive`): admin root only.
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, OFFICE, livePod, mock, reachHome, sawToast, sensitive, serverDetail, shot, signer, type Call, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 }, timezoneId: "America/Chicago" });

const SAVED = "/api/screens/server-archive/backups";
const POLICY = "/api/screens/backup-policy";
const GB = 1024 ** 3;
const KEYS_CANON = ["/lib/savedBackups.js", "archiveKeysCanonicalBytes"] as [string, string];
const POLICY_CANON = ["/lib/backupPolicy.js", "backupPolicyCanonicalBytes"] as [string, string];
const DOWNLOAD_CANON = ["/lib/serverArchive.js", "archiveDownloadCanonicalBytes"] as [string, string];
const NO_KEYS = "an admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device";
const at = (path: string) => (u: URL) => u.host === HOME && u.pathname === path;

interface SavedEntry {
  archiveId: string;
  createdAt: number;
  trigger: "schedule" | "now";
  bytes: number;
  backupBytes: number;
  bundleBytes: number;
  bundleFileName: string;
  bundleSha256: string;
  sha256: string;
  backupFileName: string;
  dataFileName: string;
  apps: Array<{ serviceId: string; name: string }>;
  left: Array<{ serviceId: string; name: string; reason: string }>;
}

function entry(id: string, createdAt: number, trigger: "schedule" | "now" = "schedule"): SavedEntry {
  return {
    archiveId: id,
    createdAt,
    trigger,
    bytes: 1200 * 1024 * 1024,
    backupBytes: 2048,
    bundleBytes: 1200 * 1024 * 1024 + 2064,
    bundleFileName: "home-2026-10-16-0800.flagship",
    bundleSha256: "ab".repeat(32),
    sha256: "cd".repeat(32),
    backupFileName: "home-2026-10-16-0800.flagship-backup",
    dataFileName: "home-2026-10-16-0800.flagship-data",
    apps: [{ serviceId: "smoketest--notes", name: "notes" }],
    left: [],
  };
}

/** The box's backups and policy lanes, with the real box's shapes and sentences. */
function backupsBox(page: Page, m: Mock, keys: Keys, init: { keysLeft?: number; backups?: SavedEntry[]; lastRun?: unknown; policy?: Record<string, unknown>; usedBytes?: number; peer?: unknown } = {}) {
  const s = {
    keysLeft: init.keysLeft ?? 0,
    backups: init.backups ?? ([] as SavedEntry[]),
    lastRun: init.lastRun ?? null,
    running: null as null | Record<string, unknown>,
    schedule: { frequency: "daily", minuteOfDayUtc: 480, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4 },
    policy: init.policy ?? { policy: "phone", phoneReserveBytes: 32 * GB, issuedAt: 1 },
    usedBytes: init.usedBytes ?? 3.2 * GB,
    deposits: [] as Call[],
    policyPosts: [] as Call[],
    schedulePuts: [] as Call[],
    deleted: [] as string[],
    approved: [] as Call[],
    downloads: [] as string[],
    runs: 0,
    polls: 0,
  };
  const view = () => ({
    schedule: s.schedule,
    scheduleActive: s.policy.policy !== "none",
    nextRunAt: s.keysLeft > 0 && s.policy.policy !== "none" ? Date.UTC(2026, 9, 17, 8) : null,
    lastRun: s.lastRun,
    running: s.running,
    keysLeft: s.keysLeft,
    keysWanted: s.keysLeft < 30 ? 400 : 0,
    ...(s.keysLeft === 0 && s.schedule.frequency !== "off" ? { waitingReason: NO_KEYS } : {}),
    usedBytes: s.backups.reduce((n, b) => n + b.bundleBytes, 0),
    backups: s.backups,
  });
  const limitOf = (p: Record<string, unknown>) => (p.policy === "phone" ? (p.phoneReserveBytes as number) : p.policy === "peer" ? 40 * GB : null);
  const policyView = () => {
    const limit = limitOf(s.policy);
    const over = limit !== null && s.usedBytes >= limit;
    return {
      policy: s.policy,
      cap: {
        limitBytes: limit,
        usedBytes: s.usedBytes,
        measuredAt: Date.now(),
        overLimit: over,
        diskBytes: 120 * GB,
        reservedForPeersBytes: s.policy.policy === "peer" ? 80 * GB : null,
        apps: [],
        ...(over ? { overReason: `This server holds ${(s.usedBytes / GB).toFixed(1)} GB of app data, over its backup limit of ${(limit! / GB).toFixed(1)} GB (the space your device keeps for its backup). Remove apps or data, or change the backup policy on the server page.` } : {}),
      },
      peer: s.policy.policy === "peer" ? init.peer ?? null : null,
    };
  };
  m.get(at(SAVED), () => {
    if (s.running && ++s.polls > 1) {
      s.backups = [entry("77".repeat(16), Date.now(), "now"), ...s.backups];
      s.running = null;
      s.lastRun = { at: Date.now(), ok: true, trigger: "now", archiveId: "77".repeat(16) };
    }
    return { json: view() };
  });
  m.get(at(POLICY), () => ({ json: policyView() }));
  m.post(
    at(`${SAVED}/keys`),
    sensitive(page, keys, KEYS_CANON, (b) => ({ arg: b.deposit, sig: b.signature }), (call) => {
      s.deposits.push(call);
      s.keysLeft += call.body.keys.length;
      return { json: view() };
    }),
  );
  m.post(at(`${SAVED}/run`), () => {
    if (s.keysLeft === 0) return { status: 409, json: { error: NO_KEYS, code: "no-keys" } };
    s.runs++;
    s.keysLeft--;
    s.running = { archiveId: "77".repeat(16), trigger: "now", startedAt: Date.now(), progress: { done: 0, total: 1, app: "notes" } };
    return { status: 202, json: { archiveId: "77".repeat(16) } };
  });
  m.on("PUT", at(`${SAVED}/schedule`), (call) => {
    s.schedulePuts.push(call);
    s.schedule = call.body;
    return { json: view() };
  });
  m.post(
    at(POLICY),
    sensitive(page, keys, POLICY_CANON, (b) => ({ arg: b.order, sig: b.signatureHex }), (call) => {
      s.policyPosts.push(call);
      const limit = limitOf(call.body.order);
      if (limit !== null && s.usedBytes > limit) {
        return {
          status: 409,
          json: {
            error: `This server holds ${(s.usedBytes / GB).toFixed(1)} GB of app data, more than the ${(limit / GB).toFixed(1)} GB your device would keep. Reserve at least ${(s.usedBytes / GB).toFixed(1)} GB on that device, or remove apps or data first.`,
            code: "over-backup-limit",
          },
        };
      }
      s.policy = call.body.order;
      return { json: policyView() };
    }),
  );
  m.on("DELETE", (u) => u.host === HOME && u.pathname.startsWith(`${SAVED}/`), (call) => {
    const id = call.url.pathname.split("/").pop()!;
    s.deleted.push(id);
    s.backups = s.backups.filter((b) => b.archiveId !== id);
    return { json: view() };
  });
  m.post((u) => u.host === HOME && /\/backups\/[0-9a-f]{32}\/link$/.test(u.pathname), (call) => {
    const id = call.url.pathname.split("/")[5]!;
    const b = s.backups.find((x) => x.archiveId === id)!;
    return { json: { path: "/api/archive-download/tok-saved", bundleFileName: b.bundleFileName, bundleBytes: b.bundleBytes, bundleSha256: b.bundleSha256, expiresAt: null } };
  });
  m.post(
    at("/api/screens/server-archive/approve"),
    sensitive(page, keys, DOWNLOAD_CANON, (b) => ({ arg: b.approval, sig: b.signature }), (call) => {
      s.approved.push(call);
      return { json: { ok: true } };
    }),
  );
  m.get((u) => u.host === HOME && u.pathname.startsWith("/api/archive-download/tok-saved/"), (call) => {
    s.downloads.push(`${call.url.pathname}?${call.url.searchParams.toString()}`);
    return { raw: "gym", contentType: "application/octet-stream", headers: { "content-disposition": 'attachment; filename="home-2026-10-16-0800.flagship"' } };
  });
  return s;
}

function baseServer(m: Mock): void {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
  m.get((u) => u.host === HOME && u.pathname === "/api/screens/server-detail", serverDetail(HOME));
}

async function openServer(page: Page): Promise<void> {
  await page.evaluate(async (fqdn) => (await import("/views/server-detail.js")).enterServerDetail(fqdn), HOME);
  await expect(page.locator("#backups-card")).toBeVisible({ timeout: 15_000 });
  await page.locator("#backups-card").scrollIntoViewIfNeeded();
}

test.describe("gym webapp backups", () => {
  test("gym backups an admin device approves backups once, backs up now, downloads one file and deletes", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    baseServer(m);
    const box = backupsBox(page, m, keys, { backups: [entry("55".repeat(16), Date.UTC(2026, 9, 15, 8))] });
    await openServer(page);

    // The policy, its limit and the usage against it.
    await expect(page.locator("#bk-policy-value")).toHaveText("On my devices · up to 32 GB");
    await expect(page.locator("#bk-usage-line")).toHaveText("Apps use 3.2 GB of 32 GB");
    await expect(page.locator("#bk-usage-bar")).toBeVisible();

    // The pool was empty: the admin device deposits a signed batch without asking (the webapp is unlocked).
    await expect.poll(() => box.deposits.length, { timeout: 15_000 }).toBe(1);
    const d = box.deposits[0]!.body as { deposit: { serverDomain: string; count: number }; signature: string; keys: unknown[] };
    expect(d.deposit).toMatchObject({ serverDomain: HOME, count: 400 });
    expect(d.keys).toHaveLength(400);
    expect(await signer(page, keys, KEYS_CANON, d.deposit, d.signature)).toBe("admin");
    await expect(page.locator("#bk-next")).toContainText("Next backup:");
    await expect(page.locator("#bk-schedule-line")).toHaveText(/^Daily at 3:00\sAM · keeps 7 daily and 4 weekly$/);
    await expect(page.locator("#bk-status")).toContainText("Last backup:");
    await shot(page, testInfo, "backups-section");

    // Back up now: progress, then the new backup on top of the list.
    await page.click("#bk-run-now");
    await expect(page.locator("#bk-list li")).toHaveCount(2, { timeout: 20_000 });
    expect(box.runs).toBe(1);
    await expect(page.locator("#bk-list li").first()).toContainText("Back up now · 1 app");

    // Download: an admin-root-signed approval, then ONE .flagship file.
    const downloads: string[] = [];
    page.on("download", (dl) => downloads.push(dl.suggestedFilename()));
    await page.locator('[data-bk-download="' + "55".repeat(16) + '"]').click();
    await expect.poll(() => box.approved.length).toBe(1);
    const a = box.approved[0]!.body as { approval: { archiveId: string; requestId: string }; signature: string };
    expect(a.approval.archiveId).toBe("55".repeat(16));
    expect(await signer(page, keys, DOWNLOAD_CANON, a.approval, a.signature)).toBe("admin");
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);
    expect(downloads).toEqual(["home-2026-10-16-0800.flagship"]);
    expect(box.downloads).toEqual([`/api/archive-download/tok-saved/bundle?r=${a.approval.requestId}`]);
    await expect(page.locator("#backups-card")).toContainText("Each backup is one .flagship file.");
    await expect(page.locator("#backups-card")).not.toContainText("two files");

    // Delete, after the confirm.
    await page.locator('[data-bk-delete="' + "55".repeat(16) + '"]').click();
    await page.locator("[data-modal-ok]").click();
    await expect(page.locator("#bk-list li")).toHaveCount(1);
    expect(box.deleted).toEqual(["55".repeat(16)]);
    await shot(page, testInfo, "backups-after-delete");
  });

  test("gym backups a non-admin device sees the box's reason and sends no order", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m);
    const box = backupsBox(page, m, keys, { backups: [entry("55".repeat(16), Date.UTC(2026, 9, 15, 8))] });
    await openServer(page);
    await expect(page.locator("#bk-next")).toHaveText(
      "An admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device.",
    );
    for (const id of ["#bk-run-now", "#bk-schedule-change", "#bk-policy-change"]) await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator(`[data-bk-delete="${"55".repeat(16)}"]`)).toBeDisabled();
    await expect(page.locator(`[data-bk-download="${"55".repeat(16)}"]`)).toBeEnabled();
    await expect(page.locator("[data-backups-admin-only]")).toHaveText("Only an admin device can change this server. This device can see it.");
    await shot(page, testInfo, "backups-non-admin");
    expect(box.deposits).toEqual([]);
    expect(m.calls.filter((c) => c.method !== "GET" && /backups|backup-policy/.test(c.url.pathname))).toEqual([]);
  });

  test("gym backups a failed run, an over-limit server and a refused policy show the box's own sentences", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m);
    const box = backupsBox(page, m, keys, {
      keysLeft: 300,
      usedBytes: 6 * GB,
      policy: { policy: "phone", phoneReserveBytes: 5 * GB, issuedAt: 1 },
      lastRun: { at: Date.now() - 3_600_000, ok: false, trigger: "schedule", reason: "this server needs about 7.0 GB free to make this backup and has 6.0 GB. Free some space (or remove apps you don't need) and try again" },
      peer: { state: "at-risk", reason: "two servers holding pieces went away", healthyBricks: 3, totalBricks: 5, holders: 4, hostingBytes: 2 * GB },
    });
    await openServer(page);
    await expect(page.locator("#bk-failed")).toHaveText(
      "The last backup failed: this server needs about 7.0 GB free to make this backup and has 6.0 GB. Free some space (or remove apps you don't need) and try again.",
    );
    await expect(page.locator("#bk-over")).toContainText("over its backup limit of 5.0 GB");
    await shot(page, testInfo, "backups-failed-over-limit");

    // A reserve smaller than the data is refused in the box's words.
    await page.click("#bk-policy-change");
    await page.check('input[name="bk-policy"][value="phone"]');
    await page.fill("#bk-reserve-gb", "4");
    await page.click("#bk-policy-save");
    await expect(page.locator("#bk-policy-error")).toHaveText("This server holds 6.0 GB of app data, more than the 4.0 GB your device would keep. Reserve at least 6.0 GB on that device, or remove apps or data first.");
    // Peer-distributed: signed under the admin root, and the peer engine's status shows.
    await page.check('input[name="bk-policy"][value="peer"]');
    await expect(page.locator("#bk-reserve-row")).toBeHidden();
    await page.click("#bk-policy-save");
    await expect(page.locator("#bk-policy-value")).toHaveText("Peer-distributed backups · up to 40 GB");
    await expect(page.locator("#bk-usage-line")).toHaveText("Apps use 6.0 GB of 40 GB (a third of this server's disk)");
    await expect(page.locator("#bk-peer")).toContainText("At risk: two servers holding pieces went away.");
    await expect(page.locator("#bk-peer")).toContainText("3 of 5 pieces safe on 4 servers");
    const post = box.policyPosts.at(-1)!.body as { order: { policy: string; phoneReserveBytes: number; serverDomain: string }; signatureHex: string };
    expect(post.order).toMatchObject({ policy: "peer", phoneReserveBytes: 0, serverDomain: HOME });
    expect(await signer(page, keys, POLICY_CANON, post.order, post.signatureHex)).toBe("admin");
    await sawToast(page, "Backup policy: Peer-distributed backups");
    await shot(page, testInfo, "backups-peer-policy");
  });

  test("gym backups the schedule is set in local time and sent in UTC", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m);
    const box = backupsBox(page, m, keys, { keysLeft: 300 });
    await openServer(page);
    await page.click("#bk-schedule-change");
    await page.selectOption("#bk-frequency", "weekly");
    await expect(page.locator("#bk-weekday-row")).toBeVisible();
    await page.selectOption("#bk-weekday", "3");
    await page.fill("#bk-time", "21:30");
    await page.fill("#bk-keep-daily", "3");
    await page.fill("#bk-keep-weekly", "8");
    await page.click("#bk-schedule-save");
    await expect.poll(() => box.schedulePuts.length).toBe(1);
    // Wednesday 21:30 in Chicago (CDT, UTC-5) is Thursday 02:30 UTC.
    expect(box.schedulePuts[0]!.body).toEqual({ frequency: "weekly", minuteOfDayUtc: 150, weekdayUtc: 4, keepDaily: 3, keepWeekly: 8 });
    await expect(page.locator("#bk-schedule-line")).toHaveText(/^Weekly on Wednesday at 9:30\sPM · keeps 3 daily and 8 weekly$/);
    await shot(page, testInfo, "backups-schedule");
  });

  test("gym backups the create form's policy is signed beside the pairing order", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.post("/api/auth-code/issue", { ok: true });
    const rckCanon = (r: { username: string; subdomain: string; rckPubKey: string; issuedAt: number }) =>
      `flagship/rck-register/v1|${r.username}|${r.subdomain}|${r.rckPubKey}|${r.issuedAt}`;
    m.post("/api/routing/register-rck", sensitive(page, keys, rckCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    await page.evaluate(async () => (await import("/views/home.js")).renderHome());
    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or import a server"] [data-choice-add]').click();
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    // The three choices say what each one does; phone-side is the default with its reserve.
    await expect(page.locator('input[name="cs-backup-policy"][value="phone-only"]')).toBeChecked();
    await expect(page.locator("#cs-backup-policy")).toContainText("so its data can't grow larger than that device's free space.");
    await expect(page.locator("#cs-backup-policy")).toContainText("Your apps can use up to a third of this server's disk");
    await expect(page.locator("#cs-backup-policy")).toContainText("If this server's disk fails, its apps and data are gone.");
    await expect(page.locator("#cs-reserve-row")).toBeVisible();
    await page.fill("#cs-reserve-gb", "24");
    await page.fill("#cs-server-name", "attic");
    await shot(page, testInfo, "create-backup-policy");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#cs-download-recipe")]);
    void dl;
    const NEW = "attic.smoketest.flagship.services";
    const pairing = await page.evaluate(async (fqdn) => (await import("/lib/pairingDeposit.js")).pendingPairingOrder(fqdn), NEW);
    const bp = JSON.parse(pairing as string).backupPolicy as { order: { serverDomain: string; policy: string; phoneReserveBytes: number; issuedAt: number }; signatureHex: string };
    expect(bp.order).toMatchObject({ serverDomain: NEW, policy: "phone", phoneReserveBytes: 24 * GB });
    expect(await signer(page, keys, POLICY_CANON, bp.order, bp.signatureHex)).toBe("admin");

    // Peer: no reserve.
    await page.click("#cs-new");
    await page.check('input[name="cs-backup-policy"][value="peer"]');
    await expect(page.locator("#cs-reserve-row")).toBeHidden();
    await page.fill("#cs-server-name", "loft");
    await Promise.all([page.waitForEvent("download"), page.click("#cs-download-recipe")]);
    const p2 = await page.evaluate(async (fqdn) => (await import("/lib/pairingDeposit.js")).pendingPairingOrder(fqdn), "loft.smoketest.flagship.services");
    expect(JSON.parse(p2 as string).backupPolicy.order).toMatchObject({ policy: "peer", phoneReserveBytes: 0 });
  });
});
