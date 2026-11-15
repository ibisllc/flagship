/**
 * Restore a backup into a running server (docs/restore-into-server.md §7) with no backend. The mock box
 * answers /api/screens/server-restore-merge* with the real box's shapes; the stage, plan and undo orders are
 * checked the way an admin-pinned box checks them (gymKit `sensitive`): admin root only, the IRK refused.
 * Same preview as the iOS mock box: one app of each kind (same app, new, runs elsewhere, a name clash).
 */

import { test, expect, type Page } from "@playwright/test";
import { HOME, OFFICE, livePod, mock, reachHome, sensitive, serverDetail, shot, signer, type Call, type Keys, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const SAVED = "/api/screens/server-archive/backups";
const MERGE = "/api/screens/server-restore-merge";
const STAGE_CANON = ["/lib/restoreMerge.js", "serverRestoreStageBytes"] as [string, string];
const PLAN_CANON = ["/lib/restoreMerge.js", "serverRestoreMergeBytes"] as [string, string];
const UNDO_CANON = ["/lib/restoreMerge.js", "appRestoreUndoBytes"] as [string, string];
const RESTORE_ID = "0123456789abcdef0123456789abcdef";
const at = (path: string) => (u: URL) => u.host === HOME && u.pathname === path;
const G = { guardCode: "tree:" + "a".repeat(64), guardSchema: "b".repeat(64), guardGen: 0 };

const APPS = [
  {
    archivedServiceId: "smoketest--notes", name: "notes", targetServiceId: "smoketest--notes", verdict: "same", code: "backup-older", codeByVersion: false, schema: "backup-older",
    backup: { version: "1.2.0", bytes: 4_000_000, hasDatabase: true, hasFiles: true }, box: { version: "1.4.0", bytes: 6_000_000, installedAt: 1_790_000_000_000 },
    alsoOn: [], addressMoves: false, allowed: ["keep", "replace", "replace-data", "copy"], disallowed: { install: "already-on-server", skip: "already-on-server" },
    recommended: "keep", copyServiceId: "smoketest--notes-restored", guards: G,
  },
  {
    archivedServiceId: "smoketest--todo", name: "todo", targetServiceId: "smoketest--todo", verdict: "new", code: "unknown", codeByVersion: false, schema: null,
    backup: { version: "1.0.0", bytes: 1_000_000, hasDatabase: true, hasFiles: false }, box: null, alsoOn: [], addressMoves: false,
    allowed: ["install", "skip", "copy"], disallowed: { keep: "not-on-server" }, recommended: "install", copyServiceId: "smoketest--todo-restored", guards: null,
  },
  {
    archivedServiceId: "smoketest--chess", name: "chess", targetServiceId: "smoketest--chess", verdict: "runs-elsewhere", code: "unknown", codeByVersion: false, schema: null,
    backup: { version: "2.0.0", bytes: 2_000_000 }, box: null, alsoOn: ["office"], addressMoves: true,
    allowed: ["install", "skip", "copy"], disallowed: { keep: "not-on-server" }, recommended: "skip", copyServiceId: "smoketest--chess-restored", guards: null,
  },
  {
    archivedServiceId: "sam--blog", name: "blog", targetServiceId: "smoketest--blog", verdict: "clash", code: "diverged", codeByVersion: false, schema: "diverged",
    backup: { version: "0.3.0", bytes: 500_000 }, box: { version: "1.0.0", bytes: 800_000, installedAt: 1_790_000_000_000 }, alsoOn: [], addressMoves: false,
    allowed: ["keep", "copy"], disallowed: { replace: "different-app", "replace-data": "different-app" }, recommended: "copy", copyServiceId: "smoketest--blog-restored", guards: null,
  },
];

interface Fixture {
  archiveId: string;
  backupText: string;
  data: number[];
  bytes: number;
  sha256: string;
}

/** A real backup sealed for this browser's account (its account slot opens it). */
async function makeBackup(page: Page): Promise<Fixture> {
  return page.evaluate(async (HOME) => {
    const f = await import("/lib/serverBackupFormat.js");
    const ks = await import("/keystore.js");
    const { getSession } = await import("/lib/state.js");
    const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const archiveId = hex(rnd(16));
    const contentKey = rnd(32);
    const head = new TextEncoder().encode(f.BACKUP_DATA_MAGIC);
    const data = new Uint8Array(head.length + 3000);
    data.set(head);
    data.set(rnd(3000), head.length);
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
    const slots = [await f.wrapAccountSlot(archiveId, contentKey, await ks.deriveServerArchiveKeyFromSeed(getSession().umk, archiveId), rnd(12))];
    const body = {
      createdAt: Date.now() - 86_400_000,
      server: { name: "home", domain: HOME, bootUnlockMode: "auto", diskEncryption: "luks" },
      apps: [{ serviceId: "smoketest--notes", name: "notes" }],
      left: [],
      includes: [],
      excludes: [],
      data: { fileName: "home.flagship-data", bytes: data.length, sha256, frameBytes: 1024 },
    };
    const sealed = await f.sealBackupFile(archiveId, contentKey, slots, body, rnd(12));
    return { archiveId, backupText: f.serializeBackupFile(sealed), data: Array.from(data), bytes: data.length, sha256 };
  }, HOME);
}

function bundle(fx: Fixture): Buffer {
  const meta = Buffer.from(fx.backupText);
  const head = Buffer.alloc(16);
  head.write("FLGSHBK1", 0, "latin1");
  head.writeBigUInt64BE(BigInt(meta.length), 8);
  return Buffer.concat([head, meta, Buffer.from(fx.data)]);
}

function savedEntry(fx: Fixture) {
  return {
    archiveId: fx.archiveId, createdAt: Date.now() - 86_400_000, trigger: "schedule", bytes: fx.bytes, backupBytes: fx.backupText.length,
    bundleBytes: fx.bytes + fx.backupText.length + 16, bundleFileName: "home.flagship", bundleSha256: "ab".repeat(32), sha256: fx.sha256,
    backupFileName: "home.flagship-backup", dataFileName: "home.flagship-data", apps: [{ serviceId: "smoketest--notes", name: "notes" }], left: [],
  };
}

/** The server page, its Backups section, and the box's restore-merge lane. */
function box(page: Page, m: Mock, keys: Keys, fx: Fixture) {
  const s = {
    stage: null as null | Record<string, any>,
    preview: null as null | Record<string, any>,
    run: null as null | Record<string, any>,
    undo: [] as Array<Record<string, any>>,
    stages: [] as Call[],
    commits: [] as string[],
    plans: [] as Call[],
    undos: [] as Call[],
    cancels: 0,
    chunks: [] as number[],
  };
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
  m.get(at("/api/screens/server-detail"), serverDetail(HOME));
  m.get(at("/api/screens/backup-policy"), {
    policy: { policy: "phone", phoneReserveBytes: 32 * 1024 ** 3, issuedAt: 1 },
    cap: { limitBytes: 32 * 1024 ** 3, usedBytes: 3 * 1024 ** 3, measuredAt: Date.now(), overLimit: false, diskBytes: 120 * 1024 ** 3, reservedForPeersBytes: null, apps: [] },
    peer: null,
  });
  m.get(at(SAVED), () => ({
    json: { schedule: { frequency: "daily", minuteOfDayUtc: 480, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4 }, scheduleActive: true, nextRunAt: null, lastRun: null, running: null, keysLeft: 300, keysWanted: 0, usedBytes: 0, backups: [savedEntry(fx)] },
  }));
  m.get(at(`${SAVED}/${fx.archiveId}/backup-file`), () => ({ json: JSON.parse(fx.backupText) }));
  m.get(at(MERGE), () => ({ json: { stage: s.stage, preview: s.preview, run: s.run, undo: s.undo } }));
  m.post(
    at(`${MERGE}/stage`),
    sensitive(page, keys, STAGE_CANON, (b) => ({ arg: b.order, sig: b.signatureHex }), (call) => {
      s.stages.push(call);
      const o = call.body.order;
      const ready = o.source === "saved";
      s.stage = { restoreId: RESTORE_ID, archiveId: o.archiveId, source: o.source, bytes: o.bytes, received: ready ? o.bytes : 0, state: ready ? "ready" : "receiving" };
      return { status: 202, json: { restoreId: RESTORE_ID, received: s.stage.received } };
    }),
  );
  m.post((u) => u.host === HOME && u.pathname === `${MERGE}/chunk`, (call) => {
    const off = Number(call.url.searchParams.get("offset"));
    if (!s.stage || off !== s.stage.received) return { status: 409, json: { error: "chunk out of order", code: "offset", received: s.stage?.received ?? 0 } };
    s.chunks.push(off);
    s.stage.received += call.raw?.length ?? 0;
    if (s.stage.received === s.stage.bytes) s.stage.state = "ready";
    return { json: { received: s.stage.received, ready: s.stage.state === "ready" } };
  });
  m.post(at(`${MERGE}/commit`), (call) => {
    if (s.stage?.state !== "ready") return { status: 409, json: { error: "Send the whole backup file first.", code: "not-ready" } };
    s.commits.push(call.body.key);
    s.stage.state = "previewed";
    s.preview = { restoreId: RESTORE_ID, backup: { createdAt: Date.UTC(2026, 10, 3, 10), sourceServer: HOME }, apps: APPS };
    return { json: { ok: true } };
  });
  m.post(
    at(`${MERGE}/plan`),
    sensitive(page, keys, PLAN_CANON, (b) => ({ arg: b.order, sig: b.signatureHex }), (call) => {
      s.plans.push(call);
      const lines = call.body.lines as Array<Record<string, any>>;
      s.run = {
        restoreId: RESTORE_ID,
        state: "done",
        apps: lines.map((l) => ({ archivedServiceId: l.archivedServiceId, action: l.action, targetServiceId: l.targetServiceId ?? APPS.find((a) => a.archivedServiceId === l.archivedServiceId)!.targetServiceId, step: l.action === "keep" ? "kept" : l.action === "skip" ? "skipped" : "done" })),
      };
      const now = Date.UTC(2026, 10, 14, 10, 2);
      s.undo = lines
        .filter((l) => l.action === "replace" || l.action === "replace-data")
        .map((l) => { const a = APPS.find((x) => x.archivedServiceId === l.archivedServiceId)!; return { serviceId: a.targetServiceId, name: a.name, restoreId: RESTORE_ID, keptAt: now, expiresAt: now + 7 * 86_400_000 }; });
      s.stage = null;
      s.preview = null;
      return { status: 202, json: { ok: true } };
    }),
  );
  m.post(at(`${MERGE}/cancel`), () => {
    s.cancels++;
    s.stage = null;
    s.preview = null;
    return { json: { ok: true } };
  });
  m.post(
    at(`${MERGE}/undo`),
    sensitive(page, keys, UNDO_CANON, (b) => ({ arg: b.order, sig: b.signatureHex }), (call) => {
      s.undos.push(call);
      s.undo = s.undo.filter((p) => !(p.serviceId === call.body.order.serviceId && p.restoreId === call.body.order.restoreId));
      return { json: { ok: true } };
    }),
  );
  return s;
}

async function openServer(page: Page): Promise<void> {
  await page.evaluate(async (fqdn) => (await import("/views/server-detail.js")).enterServerDetail(fqdn), HOME);
  await expect(page.locator("#backups-card")).toBeVisible({ timeout: 15_000 });
  await page.locator("#backups-card").scrollIntoViewIfNeeded();
}

const dialog = (page: Page) => page.locator('dialog[aria-label="Restore apps from a backup"]');

test.describe("gym webapp restore into a server", () => {
  test("gym restore-merge an admin restores a saved backup into the server with the accepted defaults, a replace, and Undo", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page);
    const s = box(page, m, keys, fx);
    await openServer(page);

    await page.locator(`[data-bk-restore="${fx.archiveId}"]`).click();
    const dlg = dialog(page);
    // The stage order is signed with the admin root and names the saved backup's data file.
    await expect.poll(() => s.stages.length, { timeout: 15_000 }).toBe(1);
    const st = s.stages[0]!.body as { order: Record<string, unknown>; signatureHex: string };
    expect(st.order).toMatchObject({ serverDomain: HOME, archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256, source: "saved" });
    expect(await signer(page, keys, STAGE_CANON, st.order, st.signatureHex)).toBe("admin");
    expect(s.chunks).toEqual([]);
    expect(s.commits).toHaveLength(1);

    // The three groups, with the defaults the owner accepted.
    await expect(dlg.locator("[data-rm-group]")).toHaveText(["New on this server", "Already on this server", "A different app with the same name"], { timeout: 15_000 });
    const row = (id: string) => dlg.locator(`[data-rm-app="${id}"]`);
    await expect(row("smoketest--notes").locator("[data-rm-chosen]")).toHaveText("Keep this server's");
    await expect(row("smoketest--notes").locator("[data-rm-compare]")).toHaveText("The backup is older: 1.2.0 vs 1.4.0");
    await expect(row("smoketest--todo").locator("[data-rm-chosen]")).toHaveText("Restore it");
    await expect(row("smoketest--chess").locator("[data-rm-chosen]")).toHaveText("Leave it out");
    await expect(row("smoketest--chess").locator("[data-rm-compare]")).toHaveText("Runs on office (its data is likely newer)");
    await expect(row("sam--blog").locator("[data-rm-chosen]")).toHaveText("Add as a separate app");
    await expect(dlg.locator("[data-rm-restore]")).toBeEnabled();
    await shot(page, testInfo, "restore-merge-choose");

    // A clash can't be replaced: the option is greyed with the box's reason.
    await row("sam--blog").locator("summary").click();
    await expect(row("sam--blog").locator('[data-rm-option="replace"] input')).toBeDisabled();
    await expect(row("sam--blog").locator('[data-rm-option="replace"]')).toContainText("It is a different app with the same name.");
    await expect(row("sam--blog").locator("[data-rm-copy-name]")).toHaveValue("blog-restored");

    // notes: restore the backup's version (its notes say what that means).
    await row("smoketest--notes").locator("summary").click();
    await row("smoketest--notes").locator('[data-rm-option="replace"] input').check();
    await expect(row("smoketest--notes").locator("[data-rm-chosen]")).toHaveText("Restore the backup's version");
    await expect(row("smoketest--notes")).toContainText("This server's copy is kept for 7 days, so you can undo. Who can use it: unchanged.");
    await expect(row("smoketest--notes").locator("[data-rm-note]")).toHaveText(["Jobs saved in the backup may run again.", "Files the app keeps are read as the backup left them."]);

    // Restore: the signed plan carries exactly these lines, guards on the replace only.
    await dlg.locator("[data-rm-restore]").click();
    await expect.poll(() => s.plans.length, { timeout: 15_000 }).toBe(1);
    const plan = s.plans[0]!.body as { order: Record<string, any>; signatureHex: string; lines: Array<Record<string, unknown>> };
    expect(await signer(page, keys, PLAN_CANON, plan.order, plan.signatureHex)).toBe("admin");
    expect(plan.order).toMatchObject({ serverDomain: HOME, restoreId: RESTORE_ID, archiveId: fx.archiveId, sha256: fx.sha256 });
    const planSha = await page.evaluate(async (lines) => (await import("/lib/restoreMerge.js")).restoreMergePlanSha256(lines), plan.lines);
    expect(plan.order.planSha256).toBe(planSha);
    expect(plan.lines).toEqual([
      { archivedServiceId: "smoketest--notes", action: "replace", sameApp: false, ...G },
      { archivedServiceId: "smoketest--todo", action: "install", sameApp: false },
      { archivedServiceId: "smoketest--chess", action: "skip", sameApp: false },
      { archivedServiceId: "sam--blog", action: "copy", sameApp: false, targetServiceId: "smoketest--blog-restored" },
    ]);

    // The result, then the earlier copy with Undo.
    await expect(dlg.locator('[data-rm-run-app="smoketest--notes"]')).toContainText("Restored");
    await expect(dlg.locator('[data-rm-run-app="smoketest--chess"]')).toContainText("Left out");
    await expect(dlg.locator('[data-rm-undo-row="smoketest--notes"]')).toContainText("Kept until");
    await shot(page, testInfo, "restore-merge-result");
    await dlg.locator(`[data-rm-undo="${RESTORE_ID}/smoketest--notes"]`).click();
    await expect(page.locator(".modal-message")).toContainText("Changes to notes since");
    await page.locator("[data-modal-ok]").click();
    await expect.poll(() => s.undos.length).toBe(1);
    const u = s.undos[0]!.body as { order: Record<string, unknown>; signatureHex: string };
    expect(u.order).toMatchObject({ serverDomain: HOME, restoreId: RESTORE_ID, serviceId: "smoketest--notes", action: "undo" });
    expect(await signer(page, keys, UNDO_CANON, u.order, u.signatureHex)).toBe("admin");
    await expect(dlg.locator("[data-rm-undo-list]")).toHaveCount(0);
    await dlg.locator("[data-rm-close]").click();
    expect(s.cancels).toBe(0);
  });

  test("gym restore-merge a backup file is sent to the box, Restore stays off for keep and skip only, and closing drops the staging", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page);
    const s = box(page, m, keys, fx);
    await openServer(page);

    await page.locator("#bk-restore-file-input").setInputFiles([{ name: "home.flagship", mimeType: "application/octet-stream", buffer: bundle(fx) }]);
    const dlg = dialog(page);
    await expect(dlg.locator("[data-rm-group]").first()).toBeVisible({ timeout: 15_000 });
    expect((s.stages[0]!.body as { order: { source: string } }).order.source).toBe("upload");
    expect(s.chunks).toEqual([0]);
    expect(s.commits).toHaveLength(1);

    // Every app on keep or skip: nothing to send.
    for (const [id, action] of [["smoketest--todo", "skip"], ["sam--blog", "keep"]] as const) {
      await dlg.locator(`[data-rm-app="${id}"] summary`).click();
      await dlg.locator(`[data-rm-app="${id}"] [data-rm-option="${action}"] input`).check();
    }
    await expect(dlg.locator("[data-rm-restore]")).toBeDisabled();
    await expect(dlg.locator("[data-rm-hint]")).toHaveText("Choose at least one app to restore.");
    await shot(page, testInfo, "restore-merge-nothing-chosen");

    await dlg.locator("[data-rm-close]").click();
    await expect.poll(() => s.cancels).toBe(1);
    expect(s.plans).toEqual([]);
  });

  test("gym restore-merge a quantum-safe server refuses the webapp's classical order and the page points to the phone", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page);
    const s = box(page, m, keys, fx);
    // The box is strict: an admin-signed order without the hybrid half is refused as needs-hybrid.
    m.first("POST", at(`${MERGE}/stage`), (call: Call) => {
      s.stages.push(call);
      return { status: 403, json: { error: "This server is quantum-safe, so a restore needs a quantum-safe signature.", code: "needs-hybrid" } };
    });
    await openServer(page);
    await page.locator(`[data-bk-restore="${fx.archiveId}"]`).click();
    const dlg = dialog(page);
    await expect(dlg.locator("[data-rm-error]")).toHaveText(
      "This server needs a quantum-safe signature, which the webapp can't make. Restore it from the Flagship app on an admin phone.",
      { timeout: 15_000 },
    );
    expect(s.stages).toHaveLength(1);
    expect((s.stages[0]!.body as { pqSignature?: unknown }).pqSignature).toBeUndefined();
    await shot(page, testInfo, "restore-merge-needs-phone");
    await dlg.locator("[data-rm-close]").click();
    expect(s.cancels).toBe(0);
  });

  test("gym restore-merge a non-admin device sees why and sends no order", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    const fx = await makeBackup(page);
    const s = box(page, m, keys, fx);
    await openServer(page);
    await expect(page.locator(`[data-bk-restore="${fx.archiveId}"]`)).toBeDisabled();
    await expect(page.locator("#bk-restore-file")).toBeDisabled();
    await expect(page.locator("[data-restore-admin-only]")).toHaveText("Only an admin device of this account can restore a backup.");
    await shot(page, testInfo, "restore-merge-non-admin");
    expect(s.stages).toEqual([]);
    expect(m.calls.filter((c) => c.method !== "GET" && c.url.pathname.startsWith(MERGE))).toEqual([]);
  });
});
