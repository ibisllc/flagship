/**
 * Back up this server, Import a backup and Migrate
 * (docs/server-backup-and-clone.md, docs/server-migration.md) with no backend.
 *
 * Crypto is real: the backup's passcode and account slots are made in the
 * page (Argon2id + the UMK), the import fixtures are sealed with this
 * browser's own account key (or only a passcode, as from another account), and
 * every sensitive order (`flagship/archive-download/v1`,
 * `flagship/server-restore/v1`, `flagship/server-migration/v1`,
 * `flagship/server-migration-control/v1`, the freeze's decommission order) is
 * answered as `.com` / an admin-pinned box answers it (gymKit `sensitive`):
 * only the admin root verifies, the IRK is refused; a demo account keeps the IRK.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  HOME,
  MEDIA,
  OFFICE,
  STK,
  USER,
  homeCard,
  livePod,
  mock,
  reachHome,
  renderHome,
  sawToast,
  sensitive,
  serverDetail,
  shot,
  signer,
  toastMark,
  type Call,
  type Keys,
  type Mock,
} from "./gymKit.js";

const ARCHIVE = "/api/screens/server-archive";
const RESTORE = "/api/screens/server-restore";
const DOWNLOAD_CANON = ["/lib/serverArchive.js", "archiveDownloadCanonicalBytes"] as [string, string];
const RESTORE_CANON = ["/lib/serverBackupFormat.js", "serverRestoreCanonicalBytes"] as [string, string];
const MIGRATION_CANON = ["/lib/serverMigration.js", "canonicalMigrationOrderBytes"] as [string, string];
const CONTROL_CANON = ["/lib/serverMigration.js", "canonicalMigrationControlBytes"] as [string, string];
const DECOMMISSION_CANON = ["/lib/serverReplacement.js", "canonicalDecommissionBytes"] as [string, string];
const rckCanon = (r: { username: string; subdomain: string; rckPubKey: string; issuedAt: number }) =>
  `flagship/rck-register/v1|${r.username}|${r.subdomain}|${r.rckPubKey}|${r.issuedAt}`;

test.use({ viewport: { width: 430, height: 932 } });

const at = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;

/** Home → the server's card → its page. */
async function openFromHome(page: Page, fqdn: string): Promise<void> {
  await renderHome(page);
  await homeCard(page, fqdn).click();
  await expect(page.locator("#backup-start-btn")).toBeVisible({ timeout: 15_000 });
}

async function openServer(page: Page, fqdn: string): Promise<void> {
  await page.evaluate(async (fqdn) => {
    const { enterServerDetail } = await import("/views/server-detail.js");
    await enterServerDetail(fqdn);
  }, fqdn);
  await expect(page.locator("#backup-start-btn")).toBeVisible({ timeout: 15_000 });
}

// ───────────────────────────── the backup box ─────────────────────────────

interface ArchiveBox {
  started: Call[];
  approved: Call[];
  deleted: number;
  downloads: string[];
}

/**
 * The box's backup lane: `start` begins a backup that reports progress on its
 * first poll and is ready on the next; `link`, `approve`, the two downloads
 * (answered as attachments) and `DELETE`. `startRefusal` makes `start` refuse
 * with the box's own sentence.
 */
function archiveBox(page: Page, m: Mock, keys: Keys, { startRefusal = "" }: { startRefusal?: string } = {}): ArchiveBox {
  const box: ArchiveBox = { started: [], approved: [], deleted: 0, downloads: [] };
  let archive: Record<string, unknown> | null = null;
  let polls = 0;
  m.get(at(HOME, ARCHIVE), () => {
    if (archive?.state === "building" && ++polls > 1) {
      archive = {
        state: "ready",
        archiveId: archive.archiveId,
        backupFileName: "home-2026-10-16.flagship-backup",
        dataFileName: "home-2026-10-16.flagship-data",
        bundleFileName: "home-2026-10-16.flagship",
        bytes: 5 * 1024 * 1024,
        bundleBytes: 5 * 1024 * 1024,
        left: [{ serviceId: "smoketest--wiki", name: "wiki", reason: "no source" }],
      };
    }
    return { json: { archive } };
  });
  m.post(at(HOME, `${ARCHIVE}/start`), (call) => {
    if (startRefusal) return { status: 507, json: { error: startRefusal } };
    box.started.push(call);
    archive = { state: "building", archiveId: call.body.archiveId, progress: { done: 0, total: 2, app: "notes" } };
    return { json: { ok: true } };
  });
  m.post(at(HOME, `${ARCHIVE}/link`), {
    path: "/api/archive-download/tok-gym",
    bundleFileName: "home-2026-10-16.flagship",
    bundleBytes: 5 * 1024 * 1024,
    expiresAt: Date.now() + 86_400_000,
  });
  m.post(
    at(HOME, `${ARCHIVE}/approve`),
    sensitive(page, keys, DOWNLOAD_CANON, (b) => ({ arg: b.approval, sig: b.signature }), (call) => {
      box.approved.push(call);
      return { json: { ok: true } };
    }),
  );
  m.on("DELETE", at(HOME, ARCHIVE), () => {
    box.deleted++;
    archive = null;
    return { json: { ok: true } };
  });
  m.get((u) => u.host === HOME && u.pathname.startsWith("/api/archive-download/tok-gym/"), (call) => {
    box.downloads.push(`${call.url.pathname}?${call.url.searchParams.toString()}`);
    return { raw: "gym", contentType: "application/octet-stream", headers: { "content-disposition": 'attachment; filename="home-2026-10-16.flagship"' } };
  });
  return box;
}

function baseServer(m: Mock, pods = [livePod(HOME), livePod(OFFICE)]): void {
  m.get("/api/users/smoketest/pods", { pods });
  m.get(at(HOME, "/api/screens/server-detail"), serverDetail(HOME));
  m.get(at(OFFICE, "/api/screens/server-detail"), serverDetail(OFFICE));
}

// ───────────────────────────── import fixtures ─────────────────────────────

interface Fixture {
  archiveId: string;
  backupText: string;
  data: number[];
  dataName: string;
  bytes: number;
  sha256: string;
}

/**
 * A real backup's two files. `account: true` seals the key for this browser's
 * account; otherwise only a passcode slot opens it (another account's backup).
 */
async function makeBackup(page: Page, { account, passcode = "" }: { account: boolean; passcode?: string }): Promise<Fixture> {
  return page.evaluate(
    async ({ account, passcode, HOME }) => {
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
      const dataName = "home-2026-10-15.flagship-data";
      const slots = [];
      if (account) {
        slots.push(await f.wrapAccountSlot(archiveId, contentKey, await ks.deriveServerArchiveKeyFromSeed(getSession().umk, archiveId), rnd(12)));
      }
      if (passcode) slots.push(await f.wrapPasscodeSlot(archiveId, contentKey, passcode, rnd(16), rnd(12), { m: 64, t: 1, p: 1 }));
      const body = {
        createdAt: Date.now() - 86_400_000,
        server: { name: "home", domain: HOME, bootUnlockMode: "auto", diskEncryption: "luks" },
        apps: [
          { serviceId: "smoketest--notes", name: "notes" },
          { serviceId: "smoketest--blog", name: "blog" },
        ],
        left: [{ serviceId: "smoketest--wiki", name: "wiki", reason: "no source" }],
        includes: [],
        excludes: [],
        data: { fileName: dataName, bytes: data.length, sha256, frameBytes: 1024 },
      };
      const sealed = await f.sealBackupFile(archiveId, contentKey, slots, body, rnd(12));
      return { archiveId, backupText: f.serializeBackupFile(sealed), data: Array.from(data), dataName, bytes: data.length, sha256 };
    },
    { account, passcode, HOME },
  );
}

/** The one `.flagship` file: "FLGSHBK1", the backup file's length (u64 BE), the backup file, the data file. */
function bundle(fx: Fixture): Buffer {
  const meta = Buffer.from(fx.backupText);
  const head = Buffer.alloc(16);
  head.write("FLGSHBK1", 0, "latin1");
  head.writeBigUInt64BE(BigInt(meta.length), 8);
  return Buffer.concat([head, meta, Buffer.from(fx.data)]);
}

function files(fx: Fixture) {
  return [{ name: "home-2026-10-15.flagship", mimeType: "application/octet-stream", buffer: bundle(fx) }];
}

/** A server that waits for `archiveId`: the restore lane (start, chunk, commit, then done). */
function restoreBox(
  m: Mock,
  fqdn: string,
  archiveId: string,
  apps: Array<Record<string, unknown>> = [
    { name: "notes", state: "done" },
    { name: "blog", state: "skipped", reason: "already here" },
  ],
) {
  const box = { started: [] as Call[], chunks: [] as Call[], committed: [] as Call[] };
  let committed = false;
  m.get(at(fqdn, RESTORE), () =>
    committed ? { json: { waiting: null, restore: { state: "done", apps } } } : { json: { waiting: { archiveId }, restore: null } },
  );
  m.post(at(fqdn, `${RESTORE}/start`), (call) => {
    box.started.push(call);
    return { json: { received: 0 } };
  });
  m.post(at(fqdn, `${RESTORE}/chunk`), (call) => {
    box.chunks.push(call);
    return { json: { received: Number(call.headers["content-length"] ?? 0) || 99_999 } };
  });
  m.post(at(fqdn, `${RESTORE}/commit`), (call) => {
    box.committed.push(call);
    committed = true;
    return { json: { ok: true } };
  });
  return box;
}

// ───────────────────────────── migration ─────────────────────────────

/** `.com`'s migration lane for HOME. `phase` drives what GET returns. */
function migrationCom(page: Page, m: Mock, keys: Keys, initial: Record<string, unknown> | null) {
  const s = { session: initial as Record<string, unknown> | null, posts: [] as string[] };
  const base = `/api/server/${HOME}/migration`;
  m.get((u) => u.pathname === base, () => (s.session ? { json: s.session } : { status: 404, json: { error: "no migration" } }));
  m.post(
    (u) => u.pathname === base,
    sensitive(page, keys, MIGRATION_CANON, (b) => ({ arg: b.order, sig: b.signature }), (call) => {
      s.posts.push("init");
      s.session = {
        phase: "initiated",
        initiatedAt: Date.now(),
        oldStkPubHex: call.body.order.oldStkPubHex,
        disposition: call.body.order.diskDisposition,
      };
      return { json: { ok: true } };
    }),
  );
  m.post(
    (u) => u.pathname === `${base}/confirm-ready`,
    sensitive(page, keys, CONTROL_CANON, (b) => ({ arg: b.control, sig: b.signature }), () => {
      s.posts.push("confirm-ready");
      s.session = { ...s.session, phase: "ready", readyAt: Date.now() };
      return { json: { ok: true } };
    }),
  );
  m.post(
    (u) => u.pathname === `${base}/freeze`,
    sensitive(page, keys, DECOMMISSION_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => {
      s.posts.push("freeze");
      s.session = { ...s.session, phase: "freezing", freezeAt: Date.now() };
      return { json: { ok: true } };
    }),
  );
  m.post(
    (u) => u.pathname === `${base}/abort`,
    sensitive(page, keys, CONTROL_CANON, (b) => ({ arg: b.control, sig: b.signature }), () => {
      s.posts.push("abort");
      s.session = { ...s.session, abortedAt: Date.now() };
      return { json: { ok: true } };
    }),
  );
  return s;
}

function session(phase: string, extra: Record<string, unknown> = {}) {
  const t = Date.now() - 3_600_000;
  return {
    phase,
    initiatedAt: t,
    attachedAt: t + 1000,
    preSeededAt: phase === "pre-seeded" || phase === "ready" ? t + 2000 : null,
    readyAt: phase === "ready" ? t + 3000 : null,
    oldStkPubHex: STK[HOME],
    disposition: "wipe-after-handoff",
    newServerDomain: "home2.smoketest.flagship.services",
    ...extra,
  };
}


// ───────────────────────────── tests ─────────────────────────────

test.describe("gym webapp archive", () => {
  test("gym archive backup from Home makes a sealed backup with the suggested passcode and downloads the one .flagship file", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    baseServer(m);
    const box = archiveBox(page, m, keys);
    await openFromHome(page, HOME);
    await page.locator("#backup-migrate-card").scrollIntoViewIfNeeded();
    await page.click("#backup-start-btn");

    const dlg = page.locator('dialog[aria-label="Back up this server"]');
    await expect(dlg.locator(".modal-title")).toHaveText("Back up this server");
    const go = dlg.locator("[data-bk-go]");
    await expect(go).toBeDisabled();
    const suggested = await dlg.locator("#bk-suggested").inputValue();
    expect(suggested).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);

    // Copy puts the suggested passcode on the clipboard.
    const mark = await toastMark(page);
    await dlg.locator("[data-bk-copy-pass]").click();
    await sawToast(page, "Passcode copied", 10_000, mark);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(suggested);

    // "I've saved the passcode" opens Make the backup.
    await dlg.locator("[data-bk-written]").check();
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "backup-passcode");
    await go.click();

    // The box gets the archive id, the content key, a passcode slot and this account's slot.
    await expect.poll(() => box.started.length, { timeout: 60_000 }).toBe(1);
    const start = box.started[0]!.body as { archiveId: string; key: string; slots: Array<{ kind: string }> };
    expect(start.archiveId).toMatch(/^[0-9a-f]{32}$/);
    expect(start.key).toMatch(/^[0-9a-f]{64}$/);
    expect(start.slots.map((s) => s.kind)).toEqual(["passcode", "account"]);
    const status = dlg.locator("[data-bk-status]");
    await expect(status).toContainText("Backup ready: home-2026-10-16.flagship (5.0 MB)", { timeout: 30_000 });
    // An app with nothing to rebuild it from is named.
    await expect(dlg.locator("[data-bk-error]")).toHaveText("Left out (no source to rebuild them from): wiki.");
    await expect(dlg.locator("[data-bk-hint]")).toContainText("asks the Flagship app on your phone to approve");
    await shot(page, testInfo, "backup-ready");

    // Copy download link: the box's link on its own address.
    const mark2 = await toastMark(page);
    await dlg.locator("[data-bk-copy]").click();
    await sawToast(page, "Download link copied", 10_000, mark2);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://${HOME}/api/archive-download/tok-gym`);

    // Download: an admin-root-signed approval for a fresh request, then the one file.
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await dlg.locator("[data-bk-save]").click();
    await expect.poll(() => box.approved.length).toBe(1);
    const approve = box.approved[0]!.body as { approval: { serverDomain: string; archiveId: string; requestId: string }; signature: string };
    expect(approve.approval.serverDomain).toBe(HOME);
    expect(approve.approval.archiveId).toBe(start.archiveId);
    expect(await signer(page, keys, DOWNLOAD_CANON, approve.approval, approve.signature)).toBe("admin");
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);
    expect(downloads).toEqual(["home-2026-10-16.flagship"]);
    expect(box.downloads).toEqual([`/api/archive-download/tok-gym/bundle?r=${approve.approval.requestId}`]);
    await sawToast(page, "Download started");

    // Delete from server: the box's copy goes, and the link with it.
    await dlg.locator("[data-bk-remove]").click();
    await expect(status).toHaveText("The server's copy is removed; the link no longer works.");
    expect(box.deleted).toBe(1);
    await expect(dlg.locator("[data-bk-save]")).toBeHidden();
    await expect(dlg.locator("[data-bk-copy]")).toBeHidden();
    await shot(page, testInfo, "backup-removed");

    await dlg.locator("[data-bk-close]").click();
    await expect(dlg).toHaveCount(0);
  });

  test("gym archive backup with my own passcode checks it and shows the box's refusal", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const box = archiveBox(page, m, keys, { startRefusal: "this server needs about 12 GB free to make the backup and has 3 GB" });
    await openServer(page, HOME);
    await page.click("#backup-start-btn");
    const dlg = page.locator('dialog[aria-label="Back up this server"]');
    const go = dlg.locator("[data-bk-go]");
    const rule = dlg.locator("[data-bk-pass-rule]");

    await dlg.locator("[data-bk-own]").click();
    await expect(dlg.locator("[data-bk-suggested]")).toBeHidden();
    await expect(dlg.locator("#bk-pass1")).toBeVisible();
    await dlg.locator("[data-bk-written]").check();
    await dlg.locator("#bk-pass1").fill("short");
    await expect(rule).toHaveText("Use at least 12 characters (or 20 if it's all one kind, like words).");
    await expect(go).toBeDisabled();
    await dlg.locator("#bk-pass1").fill("alllowercaseletters");
    await expect(rule).toHaveText("Mix at least three of: lowercase, uppercase, digits, symbols (or use 20 characters).");
    await dlg.locator("#bk-pass1").fill("Garden-Kite-42!");
    await dlg.locator("#bk-pass2").fill("Garden-Kite-43!");
    await expect(rule).toHaveText("The two don't match.");
    await expect(go).toBeDisabled();
    await dlg.locator("#bk-pass2").fill("Garden-Kite-42!");
    await expect(rule).toHaveText("Good.");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "backup-own-passcode");

    // Back to the suggested one and on again: still allowed (the box is saved).
    await dlg.locator("[data-bk-use-suggested]").click();
    await expect(dlg.locator("[data-bk-suggested]")).toBeVisible();
    await expect(dlg.locator("#bk-pass1")).toBeHidden();
    await expect(go).toBeEnabled();
    await dlg.locator("[data-bk-own]").click();
    await expect(go).toBeEnabled();
    await go.click();

    // The box refuses: its own sentence shows, not a generic error.
    await expect(dlg.locator("[data-bk-error]")).toHaveText("This server needs about 12 GB free to make the backup and has 3 GB.", { timeout: 60_000 });
    await expect(dlg.locator("[data-bk-status]")).toHaveText("The backup didn't finish.");
    expect(box.started).toHaveLength(0);
    await shot(page, testInfo, "backup-refused");
  });

  test("gym archive a backup already being made is followed when the dialog opens", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    archiveBox(page, m, keys);
    let polls = 0;
    m.first("GET", at(HOME, ARCHIVE), () => {
      polls++;
      return polls < 3
        ? { json: { archive: { state: "building", archiveId: "ab".repeat(16), progress: { done: 1, total: 3, app: "blog" } } } }
        : { json: { archive: { state: "failed", archiveId: "ab".repeat(16), reason: "the disk filled up." } } };
    });
    await openServer(page, HOME);
    await page.click("#backup-start-btn");
    const dlg = page.locator('dialog[aria-label="Back up this server"]');
    // No passcode step: it follows the running backup, then says why it failed.
    await expect(dlg.locator("[data-bk-pass]")).toBeHidden();
    await expect(dlg.locator("[data-bk-error]")).toHaveText("The backup failed: the disk filled up.", { timeout: 20_000 });
    await expect(dlg.locator("[data-bk-status]")).toHaveText("The backup didn't finish.");
    await shot(page, testInfo, "backup-followed-failed");
  });

  test("gym archive a non-admin device can't start a backup or a migration", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    await openServer(page, HOME);
    // Downloading a backup and migrating both sign under the admin root, which
    // this device lacks: both are off, with the page's one line why.
    const sentence = "Only an admin device can change this server. This device can see it.";
    await expect(page.locator("[data-server-admin-only]")).toHaveText(sentence, { timeout: 15_000 });
    for (const id of ["#backup-start-btn", "#migrate-start-btn"]) {
      await expect(page.locator(id)).toBeDisabled();
      await expect(page.locator(id)).toHaveAttribute("title", sentence);
    }
    await page.locator("#backup-migrate-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "backup-migrate-non-admin");
    // It may read the backups list (any owner device can download); it sends no order.
    expect(m.calls.filter((c) => c.method !== "GET" && /server-archive|backup-policy|\/migration/.test(c.url.pathname))).toEqual([]);
  });

  test("gym archive import a backup creates a server that waits for it and sends it", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [OFFICE] });
    const m = await mock(page);
    // "home" is taken (a revoked server still holds it), so the form starts empty.
    m.get("/api/users/smoketest/pods", { pods: [livePod(OFFICE), livePod(HOME, { revokedAt: Date.now() - 1000, liveness: "unreachable" })] });
    m.post("/api/auth-code/issue", { ok: true });
    m.post("/api/routing/register-rck", sensitive(page, keys, rckCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    const fx = await makeBackup(page, { account: true });
    const NEW = "attic.smoketest.flagship.services";
    const box = restoreBox(m, NEW, fx.archiveId);
    await renderHome(page);

    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or import a server"] [data-choice-import]').click();
    const dlg = page.locator('dialog[aria-label="Import a backup"]');
    await expect(dlg.locator("[data-imp-intro]")).toContainText("Pick the backup (its .flagship file)");
    await expect(dlg.locator("[data-imp-file]")).toHaveAttribute("accept", ".flagship,application/octet-stream");
    await expect(dlg.locator("[data-imp-file]")).not.toHaveAttribute("multiple", /.*/);

    // The one file: it opens with this account's key, its data part is checked, then the name step (home is taken).
    await dlg.locator("[data-imp-file]").setInputFiles(files(fx));
    await expect(dlg.locator("[data-imp-summary]")).toContainText(`From ${HOME}`);
    await expect(dlg.locator("[data-imp-summary]")).toContainText("notes, blog. Not in this backup: wiki.");
    await expect(dlg.locator("[data-imp-pass]")).toBeHidden();
    await expect(dlg.locator("[data-imp-name]")).toBeVisible({ timeout: 15_000 });
    await expect(dlg.locator("[data-imp-pick]")).toBeHidden();
    await expect(dlg.locator("[data-imp-files]")).toHaveText(/^home-2026-10-15\.flagship \(\d+ KB\)$/);
    const name = dlg.locator("#imp-server-name");
    await expect(name).toHaveValue("");
    await expect(dlg.locator("[data-imp-name-error]")).toHaveText('You already have a server called "home": pick another name.');
    await expect(dlg.locator("[data-imp-settings]")).toHaveText("Copied from the backup: unlocks on its own after the first start, disk encrypted.");
    const create = dlg.locator("[data-imp-create]");
    await expect(create).toBeDisabled();
    await name.fill("home");
    await expect(dlg.locator("[data-imp-name-error]")).toHaveText('You already have a server called "home".');
    await name.fill("Bad_Name");
    await expect(dlg.locator("[data-imp-name-error]")).toHaveText("Lowercase letters, digits and hyphens (not at the start or end), up to 63.");
    await name.fill("attic");
    await expect(dlg.locator("[data-imp-address]")).toHaveText(`Its address: ${NEW}`);
    await expect(create).toBeEnabled();
    await shot(page, testInfo, "import-name");

    // Create: the recipe is minted (RCK under the admin root), the restore
    // order rides the pairing order under the admin root, then the backup goes.
    const recipe = page.waitForEvent("download");
    await create.click();
    await recipe;
    await expect(dlg.locator("[data-imp-summary] a[href='https://flagshipserver.com/studio']")).toHaveText("Get Flagship Studio");
    await expect(dlg.locator("[data-imp-status]")).toHaveText("attic: Restored 1 app.", { timeout: 30_000 });
    await expect(dlg.locator("[data-imp-apps]")).toContainText("notes: restored");
    await expect(dlg.locator("[data-imp-apps]")).toContainText("blog: skipped (already here)");
    await sawToast(page, "Backup restored");
    const rck = m.last("/api/routing/register-rck")!;
    expect(await signer(page, keys, rckCanon, rck.body.request, rck.body.signature)).toBe("admin");
    const issued = m.last("/api/auth-code/issue")!;
    expect(issued.body.code.serverDomain).toBe(NEW);
    expect(issued.body.code.adminRootPubKey).toBe(keys.adminPubHex);
    expect(issued.body.adminSignature).toMatch(/^[0-9a-f]{128}$/);
    const pairing = await page.evaluate(async (fqdn) => (await import("/lib/pairingDeposit.js")).pendingPairingOrder(fqdn), NEW);
    const restore = JSON.parse(pairing as string).restore as { order: { serverDomain: string; archiveId: string; bytes: number; sha256: string }; signatureHex: string };
    expect(restore.order).toMatchObject({ serverDomain: NEW, archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256 });
    expect(await signer(page, keys, RESTORE_CANON, restore.order, restore.signatureHex)).toBe("admin");
    expect(box.started[0]!.body).toEqual({ archiveId: fx.archiveId, bytes: fx.bytes });
    expect(box.chunks).toHaveLength(1);
    expect(box.chunks[0]!.url.searchParams.get("offset")).toBe("0");
    expect((box.committed[0]!.body as { key: string }).key).toMatch(/^[0-9a-f]{64}$/);
    await shot(page, testInfo, "import-restored");

    await dlg.locator("[data-imp-close]").click();
    await expect(dlg).toHaveCount(0);
  });

  test("gym archive restore from other servers finds the lost server's record, creates a server and has it fetch the pieces", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [OFFICE] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(OFFICE), livePod(HOME, { revokedAt: Date.now() - 1000, liveness: "unreachable" })] });
    m.post("/api/auth-code/issue", { ok: true });
    m.post("/api/routing/register-rck", sensitive(page, keys, rckCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    const fx = await makeBackup(page, { account: true });
    const pbk = await page.evaluate(async (HOME) => (await import("/lib/peerBackup.js")).derivePbkHex((await import("/lib/state.js")).getSession().umk, HOME), HOME);
    // A running server of the account reads the lost server's record for this device.
    const rootCalls: Call[] = [];
    m.post(at(OFFICE, "/api/screens/peer-backup/root"), (call) => {
      rootCalls.push(call);
      return {
        json: {
          serverId: HOME, generation: 1, revision: 1, createdAt: Date.now() - 86_400_000, holders: 8, needed: 4,
          keepUntil: Date.now() + 40 * 86_400_000,
          archive: { archiveId: fx.archiveId, createdAt: Date.now() - 86_400_000, bytes: fx.bytes, sha256: fx.sha256, backupFile: fx.backupText },
        },
      };
    });
    const NEW = "attic.smoketest.flagship.services";
    const calls: Call[] = [];
    let pulled = 0;
    let committed = false;
    let pulling = false;
    m.get(at(NEW, RESTORE), () => {
      if (committed) return { json: { waiting: null, restore: { state: "done", apps: [{ name: "notes", state: "done" }] } } };
      if (!pulling) return { json: { waiting: { archiveId: fx.archiveId }, restore: null } };
      pulled += 1;
      return { json: { waiting: { archiveId: fx.archiveId }, restore: { state: pulled < 2 ? "uploading" : "ready", received: pulled < 2 ? 1000 : fx.bytes, bytes: fx.bytes } } };
    });
    m.post(at(NEW, `${RESTORE}/from-peers`), (call) => {
      calls.push(call);
      pulling = true;
      return { status: 202, json: { archiveId: fx.archiveId, received: 0 } };
    });
    m.post(at(NEW, `${RESTORE}/commit`), () => {
      committed = true;
      return { json: { ok: true } };
    });
    await renderHome(page);

    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or import a server"] [data-choice-peers]').click();
    const dlg = page.locator('dialog[aria-label="Restore from other servers"]');
    await expect(dlg.locator("[data-pr-lost]")).toHaveValue(HOME);
    await shot(page, testInfo, "peers-pick");
    await dlg.locator("[data-pr-find]").click();
    await expect(dlg.locator("[data-pr-summary]")).toContainText("8 servers hold its pieces; 4 bring it back.", { timeout: 15_000 });
    await expect(dlg.locator("[data-pr-summary]")).toContainText("Restore by");
    await expect(dlg.locator("[data-pr-summary]")).toContainText("Apps: notes, blog");
    expect(rootCalls[0]!.body).toEqual({ serverId: HOME, pbkHex: pbk });
    await dlg.locator("#pr-server-name").fill("attic");
    await expect(dlg.locator("[data-pr-address]")).toHaveText(`Its address: ${NEW}`);
    const recipe = page.waitForEvent("download");
    await dlg.locator("[data-pr-create]").click();
    await recipe;
    await expect(dlg.locator("[data-pr-status]")).toHaveText("attic: Restored 1 app.", { timeout: 30_000 });
    expect(calls[0]!.body).toEqual({ serverId: HOME, pbkHex: pbk });
    const pairing = await page.evaluate(async (fqdn) => (await import("/lib/pairingDeposit.js")).pendingPairingOrder(fqdn), NEW);
    const restore = JSON.parse(pairing as string).restore as { order: { archiveId: string; bytes: number; sha256: string }; signatureHex: string };
    expect(restore.order).toMatchObject({ archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256 });
    expect(await signer(page, keys, RESTORE_CANON, restore.order, restore.signatureHex)).toBe("admin");
    await sawToast(page, "Backup restored");
    await shot(page, testInfo, "peers-restored");
  });

  test("gym archive restore from other servers with no server running reads the sealed record from .com", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME, { revokedAt: Date.now() - 1000, liveness: "unreachable" })] });
    const fx = await makeBackup(page, { account: true });
    const sealed = await page.evaluate(async ({ HOME, backupText, archiveId, bytes, sha256 }) => {
      const pb = await import("/lib/peerBackup.js");
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const pbkHex = await pb.derivePbkHex(getSession().umk, HOME);
      const rootKey = await ks.hkdf32(ks.hexToBytes(pbkHex), "flagship/pb-root/v1");
      const key = await crypto.subtle.importKey("raw", rootKey, "AES-GCM", false, ["encrypt"]);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const root = {
        v: 1, serverId: HOME, generation: 1, revision: 1, createdAt: Date.now(), network: { k: 1, n: 1 },
        archive: { archiveId, createdAt: Date.now(), bytes, sha256, backupFile: backupText },
        stripes: [[{ expiresAt: Date.now() + 30 * 86_400_000 }]],
      };
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`flagship/pb-root/v1|${HOME}`) }, key, new TextEncoder().encode(JSON.stringify(root))));
      return { nonceHex: ks.bytesToHex(nonce), ciphertextHex: ks.bytesToHex(ct) };
    }, { HOME, backupText: fx.backupText, archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256 });
    m.get((u) => u.pathname === `/api/peer-backup/root/${HOME}`, () => ({ json: sealed }));
    await renderHome(page);
    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or import a server"] [data-choice-peers]').click();
    const dlg = page.locator('dialog[aria-label="Restore from other servers"]');
    await dlg.locator("[data-pr-find]").click();
    await expect(dlg.locator("[data-pr-summary]")).toContainText("1 server hold its pieces", { timeout: 15_000 });
    await expect(dlg.locator("[data-pr-name]")).toBeVisible();
    await shot(page, testInfo, "peers-from-com");
  });

  test("gym archive restore from other servers says so when the lost server has no peer backup", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [OFFICE] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(OFFICE), livePod(HOME, { revokedAt: Date.now() - 1000, liveness: "unreachable" })] });
    m.post(at(OFFICE, "/api/screens/peer-backup/root"), () => ({ status: 404, json: { error: "No peer backup of that server was found." } }));
    await renderHome(page);
    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or import a server"] [data-choice-peers]').click();
    const dlg = page.locator('dialog[aria-label="Restore from other servers"]');
    await dlg.locator("[data-pr-find]").click();
    await expect(dlg.locator("[data-pr-error]")).toContainText("No peer backup of that server was found", { timeout: 15_000 });
    await expect(dlg.locator("[data-pr-name]")).toBeHidden();
    await shot(page, testInfo, "peers-none");
  });

  test("gym archive import another account's backup needs its passcode", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    const fx = await makeBackup(page, { account: false, passcode: "Garden-Kite-42!" });
    await page.evaluate(async () => (await import("/views/import-backup.js")).openImportBackup());
    const dlg = page.locator('dialog[aria-label="Import a backup"]');

    // A file that isn't a backup is named.
    await dlg.locator("[data-imp-file]").setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello there, ".repeat(10)) }]);
    await expect(dlg.locator("[data-imp-error]")).toHaveText("This file isn't a Flagship backup.");
    // A backup cut short (a download that stopped) is refused before anything is sent.
    await dlg.locator("[data-imp-file]").setInputFiles([{ name: "home.flagship", mimeType: "application/octet-stream", buffer: bundle(fx).subarray(0, 16 + fx.backupText.length) }]);
    await expect(dlg.locator("[data-imp-error]")).toHaveText("This backup is cut short: it ends before its data.");

    await dlg.locator("[data-imp-file]").setInputFiles(files(fx));
    await expect(dlg.locator("[data-imp-pass]")).toBeVisible({ timeout: 10_000 });
    await expect(dlg.locator("[data-imp-pass] label")).toHaveText("This backup was made on another account. Enter its passcode to open it.");
    await dlg.locator("#imp-passcode").fill("Garden-Kite-43!");
    await dlg.locator("[data-imp-unlock]").click();
    await expect(dlg.locator("[data-imp-error]")).toHaveText("That passcode doesn't open this backup.");
    await shot(page, testInfo, "import-wrong-passcode");
    await dlg.locator("#imp-passcode").fill("Garden-Kite-42!");
    await dlg.locator("[data-imp-unlock]").click();
    await expect(dlg.locator("[data-imp-pass]")).toBeHidden({ timeout: 10_000 });
    await expect(dlg.locator("[data-imp-name]")).toBeVisible({ timeout: 15_000 });
    await expect(dlg.locator("[data-imp-summary]")).toContainText(`From ${HOME}`);
    await shot(page, testInfo, "import-opened-with-passcode");
  });

  test("gym archive a server waiting for its backup gets it from its Home card", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page, { account: true });
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE, { awaitingBackup: { archiveId: fx.archiveId } })] });
    const box = restoreBox(m, OFFICE, fx.archiveId);
    await renderHome(page);
    const send = page.locator(`#servers-list .js-send-backup[data-fqdn="${OFFICE}"]`);
    await expect(send).toHaveText("Send the backup", { timeout: 10_000 });
    await expect(page.locator(`#servers-list .js-delete-server[data-fqdn="${OFFICE}"]`)).toBeVisible();
    await shot(page, testInfo, "home-awaiting-backup");
    await send.click();

    const dlg = page.locator('dialog[aria-label="Import a backup"]');
    await expect(dlg.locator("[data-imp-intro]")).toHaveText("office is waiting for its backup. Pick the backup's .flagship file and this page sends it.");
    await dlg.locator("[data-imp-file]").setInputFiles(files(fx));
    const sendExisting = dlg.locator("[data-imp-send-existing]");
    await expect(sendExisting).toHaveText("Send it to office (waiting for this backup)", { timeout: 15_000 });
    await expect(dlg.locator("[data-imp-new-instead]")).toBeVisible();
    await shot(page, testInfo, "import-send-existing");
    await sendExisting.click();
    await expect(dlg.locator("[data-imp-status]")).toHaveText("office: Restored 1 app.", { timeout: 30_000 });
    expect(box.started).toHaveLength(1);
    expect(box.committed).toHaveLength(1);
  });

  test("gym archive a restore where one app fails names it with the box's reason and ends", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page, { account: true });
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE, { awaitingBackup: { archiveId: fx.archiveId } })] });
    restoreBox(m, OFFICE, fx.archiveId, [
      { name: "notes", state: "done" },
      { name: "blog", state: "failed", reason: "its image didn't build: npm ERR! missing script: start" },
    ]);
    await renderHome(page);
    await page.locator(`#servers-list .js-send-backup[data-fqdn="${OFFICE}"]`).click();
    const dlg = page.locator('dialog[aria-label="Import a backup"]');
    await dlg.locator("[data-imp-file]").setInputFiles(files(fx));
    await dlg.locator("[data-imp-send-existing]").click();
    await expect(dlg.locator("[data-imp-status]")).toHaveText("office: Restored 1 app. 1 couldn't be restored; the server works with the rest.", { timeout: 30_000 });
    await expect(dlg.locator("[data-imp-apps]")).toContainText("notes: restored");
    await expect(dlg.locator("[data-imp-apps]")).toContainText("Couldn't restore blog: its image didn't build: npm ERR! missing script: start.");
    await shot(page, testInfo, "import-one-app-failed");
  });

  test("gym archive a waiting server's backup can go to a new server instead", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    const fx = await makeBackup(page, { account: true });
    m.get("/api/users/smoketest/pods", { pods: [livePod(OFFICE), livePod(MEDIA, { awaitingBackup: { archiveId: fx.archiveId } })] });
    await page.evaluate(async () => (await import("/views/import-backup.js")).openImportBackup());
    const dlg = page.locator('dialog[aria-label="Import a backup"]');
    await dlg.locator("[data-imp-file]").setInputFiles(files(fx));
    await expect(dlg.locator("[data-imp-send-existing]")).toHaveText("Send it to media (waiting for this backup)", { timeout: 15_000 });
    await dlg.locator("[data-imp-new-instead]").click();
    await expect(dlg.locator("[data-imp-waiting-choice]")).toBeHidden();
    // home is free on this account, so the saved name is offered.
    await expect(dlg.locator("#imp-server-name")).toHaveValue("home");
    await expect(dlg.locator("[data-imp-create]")).toBeEnabled();
    await shot(page, testInfo, "import-new-instead");
  });

  test("gym archive a non-admin device can't import a backup", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE, { awaitingBackup: { archiveId: "ef".repeat(16) } })] });
    await renderHome(page);
    await expect(page.locator("#home-add-server")).toHaveCount(0);
    await page.locator(`#servers-list .js-send-backup[data-fqdn="${OFFICE}"]`).click();
    await expect(page.locator(".modal-title")).toHaveText("Admin devices only");
    await expect(page.locator(".modal-message, .modal-card p").first()).toContainText("Only an admin device of this account can add servers.");
    await expect(page.locator('dialog[aria-label="Import a backup"]')).toHaveCount(0);
    await shot(page, testInfo, "import-non-admin");
  });

  test("gym archive migrate starts under the admin root with no peer backup needed", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const com = migrationCom(page, m, keys, null);
    await openServer(page, HOME);
    await page.click("#migrate-start-btn");
    const dlg = page.locator('dialog[aria-label="Migrate to a new server"]');
    const action = dlg.locator("[data-mig-action]");

    // No peer-backup gate any more: the move carries the server's own backup.
    await expect(dlg.locator("[data-mig-backup]")).toContainText("backs it up and sends the backup straight to the new server", { timeout: 15_000 });
    await expect(dlg.locator("[data-mig-gate]")).toBeHidden();
    await expect(action).toBeEnabled();
    await shot(page, testInfo, "migrate-start");
    await action.click();
    await sawToast(page, "Migration started — now add the new box");
    const init = m.last(`/api/server/${HOME}/migration`)!;
    expect(init.body.order).toMatchObject({ serverDomain: HOME, oldStkPubHex: STK[HOME], diskDisposition: "wipe-after-handoff" });
    expect(await signer(page, keys, MIGRATION_CANON, init.body.order, init.body.signature)).toBe("admin");
    expect(init.body.auth.username).toBe(USER);
    expect(com.posts).toEqual(["init"]);
    // The timeline replaces the start step; abort is offered.
    await expect(dlg.locator("[data-mig-wait]")).toHaveText(
      "Waiting for the new box to come online. Apply the recipe on the new machine / VM; it will attach itself here.",
    );
    await expect(dlg.locator("[data-mig-steps]")).toContainText("Migration authorized");
    await expect(dlg.locator("[data-mig-abort]")).toBeVisible();
    await shot(page, testInfo, "migrate-started");
    const hold = await page.evaluate(async () => (await import("/lib/serverMigration.js")).activeMigrationHolds());
    expect(hold).toEqual([HOME]);
  });

  test("gym archive migrate moves the data: estimate, pause and back up, the new box pulls and restores", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const NEW = "home2.smoketest.flagship.services";
    migrationCom(page, m, keys, session("provisioned"));
    const fx = await makeBackup(page, { account: true });
    const SAVED = `${ARCHIVE}/backups`;
    const old = { runs: [] as Call[], approved: [] as Call[], polls: 0 };
    // The old box: estimate, speed-check link, keys in its pool, the move's backup, its file and link.
    m.get(at(HOME, `${SAVED}/estimate`), { archiveBytes: 2 * 1024 ** 3, apps: 2 });
    m.post(at(HOME, `${ARCHIVE}/probe-link`), { path: `/api/archive-probe/${"cd".repeat(32)}`, bytes: 8 * 1024 * 1024 });
    m.get(at(HOME, SAVED), () => {
      const done = old.runs.length > 0 && ++old.polls > 1;
      return {
        json: {
          keysLeft: 300,
          keysWanted: 0,
          running: old.runs.length > 0 && !done ? { archiveId: fx.archiveId, progress: { done: 0, total: 2, app: "notes" } } : null,
          lastRun: null,
          backups: done ? [{ archiveId: fx.archiveId, createdAt: Date.now(), bytes: fx.bytes, backupBytes: fx.backupText.length, sha256: fx.sha256, apps: [], left: [] }] : [],
        },
      };
    });
    m.post(at(HOME, `${SAVED}/run`), (call) => {
      old.runs.push(call);
      return { status: 202, json: { archiveId: fx.archiveId } };
    });
    m.get(at(HOME, `${SAVED}/${fx.archiveId}/backup-file`), () => ({ raw: fx.backupText, contentType: "application/json" }));
    m.post(at(HOME, `${SAVED}/${fx.archiveId}/link`), { path: `/api/archive-download/${"ab".repeat(32)}`, bundleFileName: "home.flagship", bundleBytes: fx.bytes + 16, expiresAt: null });
    m.post(
      at(HOME, `${ARCHIVE}/approve`),
      sensitive(page, keys, DOWNLOAD_CANON, (b) => ({ arg: b.approval, sig: b.signature }), (call) => {
        old.approved.push(call);
        return { json: { ok: true } };
      }),
    );
    // The new box: the speed check, the late restore order, the pull, then the restore.
    const nb = { orders: [] as Call[], pulls: [] as Call[], committed: false, polls: 0 };
    m.post(at(NEW, `${RESTORE}/probe`), { bytes: 8 * 1024 * 1024, ms: 400, bytesPerSecond: 20 * 1024 * 1024 });
    m.post(
      at(NEW, `${RESTORE}/order`),
      sensitive(page, keys, RESTORE_CANON, (b) => ({ arg: b.order, sig: b.signatureHex }), (call) => {
        nb.orders.push(call);
        return { json: { waiting: { archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256 }, restore: null } };
      }),
    );
    m.post(at(NEW, `${RESTORE}/pull`), (call) => {
      nb.pulls.push(call);
      return { status: 202, json: { received: 0 } };
    });
    m.get(at(NEW, RESTORE), () => {
      if (nb.committed) return { json: { waiting: null, restore: { state: "done", apps: [{ name: "notes", state: "done" }, { name: "blog", state: "failed", reason: "its image didn't build" }] } } };
      const ready = ++nb.polls > 1;
      return { json: { waiting: { archiveId: fx.archiveId }, restore: { state: ready ? "ready" : "uploading", bytes: fx.bytes, received: ready ? fx.bytes : fx.bytes / 2, pulling: !ready } } };
    });
    m.post(at(NEW, `${RESTORE}/commit`), () => {
      nb.committed = true;
      return { json: { ok: true } };
    });
    // This device created the new box, so it holds a session for it.
    await page.evaluate(async (fqdn) => (await import("/lib/api.js")).setSessionTokenForPod(fqdn, "tok-new"), NEW);

    await openServer(page, HOME);
    await page.click("#migrate-start-btn");
    const dlg = page.locator('dialog[aria-label="Migrate to a new server"]');
    await expect(dlg.locator("[data-mig-wait]")).toHaveText("New box attached. Move the data when you're ready: this server's apps pause until the new one takes over.", { timeout: 15_000 });
    // The estimate: size, the measured link speed, the downtime.
    await expect(dlg.locator("[data-mig-estimate]")).toContainText("About 2.0 GB to move at 20 MB/s between the servers.", { timeout: 15_000 });
    await expect(dlg.locator("[data-mig-estimate]")).toContainText("Your apps pause for about 4 minutes");
    await shot(page, testInfo, "migrate-estimate");
    await dlg.locator("[data-mig-move-btn]").click();
    await expect(dlg.locator("[data-mig-move-step]")).toHaveText("Restored 1 app. 1 couldn't be restored; the server works with the rest.", { timeout: 30_000 });
    await expect(dlg.locator("[data-mig-move-apps]")).toContainText("Couldn't restore blog: its image didn't build.");
    // The old box paused and backed up for the move; the new one got a signed order, an approved link, then the key.
    expect(old.runs[0]!.body).toEqual({ purpose: "migrate" });
    const order = nb.orders[0]!.body as { order: { serverDomain: string; archiveId: string; bytes: number; sha256: string }; signatureHex: string };
    expect(order.order).toMatchObject({ serverDomain: NEW, archiveId: fx.archiveId, bytes: fx.bytes, sha256: fx.sha256 });
    expect(await signer(page, keys, RESTORE_CANON, order.order, order.signatureHex)).toBe("admin");
    const a = old.approved[0]!.body as { approval: { archiveId: string; requestId: string }; signature: string };
    expect(a.approval.archiveId).toBe(fx.archiveId);
    expect(nb.pulls[0]!.body).toEqual({ url: `https://${HOME}/api/archive-download/${"ab".repeat(32)}`, requestId: a.approval.requestId });
    expect(m.last(`${RESTORE}/commit`)!.body.key).toMatch(/^[0-9a-f]{64}$/);
    await shot(page, testInfo, "migrate-moved");
  });

  test("gym archive migrate hands off to the new box, then a ready one freezes", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const com = migrationCom(page, m, keys, session("pre-seeded"));
    await openServer(page, HOME);
    await page.click("#migrate-start-btn");
    const dlg = page.locator('dialog[aria-label="Migrate to a new server"]');
    const action = dlg.locator("[data-mig-action]");
    await expect(action).toHaveText("Hand off to the new box now", { timeout: 15_000 });
    await expect(dlg.locator("[data-mig-wait]")).toContainText("Data restored. Confirm the hand-off");
    await shot(page, testInfo, "migrate-pre-seeded");
    await action.click();
    await sawToast(page, "Handing off — the old server is freezing");
    await expect.poll(() => com.posts).toEqual(["confirm-ready", "freeze"]);
    const confirm = m.last("/migration/confirm-ready")!;
    expect(confirm.body.control).toMatchObject({ serverDomain: HOME, action: "confirm-ready" });
    expect(await signer(page, keys, CONTROL_CANON, confirm.body.control, confirm.body.signature)).toBe("admin");
    const freeze = m.last("/migration/freeze")!;
    expect(freeze.body.order).toMatchObject({ retiredStkPubHex: STK[HOME], diskDisposition: "wipe-after-handoff" });
    expect(await signer(page, keys, DECOMMISSION_CANON, freeze.body.order, freeze.body.signature)).toBe("admin");
    await expect(dlg.locator("[data-mig-wait]")).toHaveText("The old server is handing off…");
    await expect(action).toBeHidden();
    await dlg.locator("[data-mig-cancel]").click();

    // A session left at `ready` (the freeze half failed): only the freeze is sent.
    com.session = session("ready");
    com.posts.length = 0;
    await page.click("#migrate-start-btn");
    await expect(action).toHaveText("Freeze old server and hand off", { timeout: 15_000 });
    // The same toast showed for the first hand-off: wait on the request itself.
    await action.click();
    await expect.poll(() => com.posts).toEqual(["freeze"]);
    await shot(page, testInfo, "migrate-frozen");
  });

  test("gym archive migrate abort keeps the old server and the dialog says Done", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const com = migrationCom(page, m, keys, session("provisioned"));
    let resumed = 0;
    m.post(at(HOME, `${ARCHIVE}/backups/resume`), () => {
      resumed++;
      return { json: { migratePause: null } };
    });
    await page.evaluate(async (fqdn) => (await import("/lib/serverMigration.js")).setMigrationHold(fqdn), HOME);
    await openServer(page, HOME);
    await page.click("#migrate-start-btn");
    const dlg = page.locator('dialog[aria-label="Migrate to a new server"]');
    const abort = dlg.locator("[data-mig-abort]");
    await expect(abort).toHaveText("Abort migration — old server stays active with all data", { timeout: 15_000 });
    await expect(dlg.locator("[data-mig-action]")).toBeHidden();
    await abort.click();
    await sawToast(page, "Migration aborted — your old server stays active");
    expect(com.posts).toEqual(["abort"]);
    // The old server's apps run again.
    await expect.poll(() => resumed).toBe(1);
    const sent = m.last("/migration/abort")!;
    expect(sent.body.control.action).toBe("abort");
    expect(await signer(page, keys, CONTROL_CANON, sent.body.control, sent.body.signature)).toBe("admin");
    await expect(dlg.locator("[data-mig-wait]")).toHaveText("Migration aborted — your old server stays active with all its data.");
    await expect(dlg.locator("[data-mig-cancel]")).toHaveText("Done");
    await expect(dlg.locator("[data-mig-abort-row]")).toBeHidden();
    const holds = await page.evaluate(async () => (await import("/lib/serverMigration.js")).activeMigrationHolds());
    expect(holds).toEqual([]);
    await shot(page, testInfo, "migrate-aborted");
    await dlg.locator("[data-mig-cancel]").click();
    await expect(dlg).toHaveCount(0);
  });

  test("gym archive a demo account migrates with the IRK", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "demo", servers: [HOME] });
    const m = await mock(page);
    baseServer(m, [livePod(HOME)]);
    const com = migrationCom(page, m, keys, null);
    await openServer(page, HOME);
    await page.click("#migrate-start-btn");
    const dlg = page.locator('dialog[aria-label="Migrate to a new server"]');
    await dlg.locator("[data-mig-action]").click();
    await sawToast(page, "Migration started — now add the new box");
    const sent = m.last(`/api/server/${HOME}/migration`)!;
    expect(await signer(page, keys, MIGRATION_CANON, sent.body.order, sent.body.signature)).toBe("irk");
    expect(com.posts).toEqual(["init"]);
    await shot(page, testInfo, "migrate-demo");
  });

  test("gym archive pending server page cancels the order and goes back", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.get("/api/order/SER-GYM-1/status", { phase: "installing" });
    m.post(
      "/api/server/release",
      sensitive(page, keys, (r: { username: string; serverDomain: string; issuedAt: number }) => `flagship/release-server-name/v1|${r.username}|${r.serverDomain}|${r.issuedAt}`, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })),
    );
    const order = { serial: "SER-GYM-1", name: "garage", fqdn: "garage.smoketest.flagship.services", username: USER };
    await page.evaluate(async (order) => {
      (await import("/lib/profilesStore.js")).set("pendingOrders", JSON.stringify([order]));
      (await import("/views/pending-server.js")).enterPendingServer(order);
    }, order);
    await expect(page.locator("#pending-server-name")).toHaveText("garage");
    await expect(page.locator("#pending-server-fqdn")).toHaveText(order.fqdn);
    // The kept serial follows the order's own status: its phase and the checklist.
    await expect(page.locator("#pending-server-note")).toHaveText("Installing", { timeout: 10_000 });
    await expect(page.locator("#pending-server-progress .demo-step-active")).toContainText("Installing");
    await shot(page, testInfo, "pending-server");

    // ← Back returns Home and keeps the order.
    await page.click("#pending-server-back");
    await expect(page.locator("#view-home")).toBeVisible();

    // Cancel order: the browser's confirm, then the name release under the admin
    // root (which also voids the recipe's auth code on .com), and the order is gone.
    await page.evaluate(async (order) => (await import("/views/pending-server.js")).enterPendingServer(order), order);
    let confirmText = "";
    page.once("dialog", (d) => {
      confirmText = d.message();
      void d.accept();
    });
    await page.click("#pending-server-cancel");
    await sawToast(page, `Deleted — "${order.fqdn}" is free again`);
    expect(confirmText).toContain(`Delete "${order.fqdn}"? This frees the name for reuse`);
    const release = m.last("/api/server/release")!;
    expect(release.body.request.serverDomain).toBe(order.fqdn);
    expect(
      await signer(page, keys, (r: { username: string; serverDomain: string; issuedAt: number }) => `flagship/release-server-name/v1|${r.username}|${r.serverDomain}|${r.issuedAt}`, release.body.request, release.body.signature),
    ).toBe("admin");
    const left = await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("pendingOrders"));
    expect(JSON.parse(left as string)).toEqual([]);
    await expect(page.locator("#view-home")).toBeVisible();
  });
});

