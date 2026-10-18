/**
 * The remaining account, device and tool screens with no backend: account
 * security's Print and admin-key rotation, Trusted devices' managed names and
 * account name, Add a device's New code, Recovery (re-attach progress, removing
 * cloud recovery, a wrapped key exported and imported, a backup file restored
 * into a takeover), Profiles with none, Companion requests and their badge, a
 * saved key's default model, Privacy/About links, Peer-backup, the take-over
 * dialog, Pod pair's Unpair, the Remote page link, Process URL, an invite link
 * on a browser with no account, the browser viewer, Send order (debug) and the
 * create-server recipe.
 *
 * Crypto is real: each signed request is re-verified over the webapp's own
 * canonical bytes, and sensitive ones must carry the admin root (gymKit
 * `sensitive` / `signer`). `.com` and the boxes are the gymKit router.
 */

import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  ACCOUNT_ID,
  CONTROL,
  DEVICE_ID,
  HOME,
  PASSPHRASE,
  USER,
  createAccount,
  livePod,
  mock,
  reachHome,
  sawToast,
  sensitive,
  shot,
  signer,
  toastMark,
  verifies,
  type Keys,
  type Mock,
} from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const SERVICE_ID = "smoketest--notes";

async function openSettings(page: Page): Promise<void> {
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
}

/** Remote/QR relays never reach a network. */
async function noSockets(page: Page): Promise<void> {
  await page.routeWebSocket(/.*/, () => {});
}

/** Press a link that opens a new tab; answer that tab locally (nothing
 *  reaches a network) and return where it went. */
async function popupUrl(page: Page, click: () => Promise<void>): Promise<string> {
  await page.context().route((u) => !u.href.startsWith("http://127.0.0.1"), (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>gym</p>" }));
  const [popup] = await Promise.all([page.context().waitForEvent("page"), click()]);
  await popup.waitForURL(/^https?:/).catch(() => {});
  const url = popup.url();
  await popup.close().catch(() => {});
  return url;
}

/** A 1×1 JPEG frame for the browser viewer's stream. */
const FRAME_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function basePods(m: Mock): void {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
}

/** `.com`'s qr-pipe relay (apps/com/src/buildRelay.ts), shared by every page
 *  routed to it: a browser-role socket waits, a phone-role socket's hello and
 *  deliver are forwarded to it. */
function relayHub() {
  const sessions = new Map<string, { browser?: WebSocketRoute; phone?: WebSocketRoute }>();
  return (ws: WebSocketRoute) => {
    const u = new URL(ws.url());
    const sid = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const s = sessions.get(sid) ?? {};
    sessions.set(sid, s);
    const say = (to: WebSocketRoute | undefined, msg: unknown) => to?.send(JSON.stringify(msg));
    if (u.searchParams.get("role") === "browser") {
      s.browser = ws;
      ws.onMessage(() => {});
      say(ws, { kind: "accepted" });
      return;
    }
    s.phone = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.kind === "hello") {
        if (!s.browser) return say(ws, { kind: "peer-missing" });
        say(s.browser, { kind: "peer-hello", phonePk: msg.phonePk });
        say(ws, { kind: "ack" });
      } else if (msg.kind === "deliver") {
        say(s.browser, { kind: "peer-deliver", ciphertext: msg.ciphertext, nonce: msg.nonce });
        say(ws, { kind: "delivered" });
      }
    });
  };
}

// ───────────────────────────── account security ─────────────────────────────

const rotationCanon = (r: { username: string; oldAdminRootPub: string; newAdminRootPub: string; issuedAt: number }) =>
  `flagship/admin-root-rotation/v1|${r.username}|${r.oldAdminRootPub}|${r.newAdminRootPub}|${r.issuedAt}`;

test.describe("gym webapp misc", () => {
  test("gym misc account security prints the recovery codes and rotates the admin key under the old root", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed++;
      };
    });
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get((u) => u.pathname === "/api/users/smoketest", { accountType: "single", totpEnrolledAt: null });
    m.post("/totp/enroll-begin", { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Flagship:smoketest?secret=JBSWY3DPEHPK3PXP", qrPngBase64: "", issuer: "Flagship" });
    m.post("/totp/enroll-confirm", { accountType: "multi", totpEnrolledAt: Date.now(), recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] });
    m.post("/api/users/smoketest/admin-root-rotation", (call) => ({ json: { ok: true, adminRootPubHex: call.body.rotation.newAdminRootPub } }));
    await openSettings(page);
    await page.click("#settings-tab-account-security");
    const content = page.locator("#account-security-content");

    // Print: only on the recovery-codes step, and it prints the page.
    await page.click("#account-security-enable");
    await page.fill("#account-security-sample-code", "123456", { timeout: 10_000 });
    await page.click("#account-security-verify");
    await expect(content.locator("[data-account-security-recovery-codes] li")).toHaveCount(2, { timeout: 10_000 });
    await page.click("#account-security-print");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await shot(page, testInfo, "security-print");
    await page.check("#account-security-saved");
    await page.click("#account-security-done");

    // Rotate: the warning can be declined, then a wrong phrase cancels.
    const rotate = page.locator("#account-security-rotate-admin");
    await expect(content.locator('[data-account-security-rotate="available"]')).toBeVisible();
    await rotate.click();
    await expect(page.locator(".modal-title")).toHaveText("Rotate admin key?");
    await page.click("[data-modal-cancel]");
    await rotate.click();
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Type ROTATE to confirm");
    await page.fill(".modal-input", "rotate it");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Rotation cancelled — phrase didn't match.");
    expect(m.sent("admin-root-rotation")).toHaveLength(0);

    // ROTATE: the OLD root signs OLD→NEW, and the session signs with the new root after.
    await rotate.click();
    await page.click("[data-modal-ok]");
    await page.fill(".modal-input", "ROTATE");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Admin key rotated — your other admin devices are no longer admins.");
    const post = m.last("admin-root-rotation")!;
    const rot = post.body.rotation;
    expect(rot.username).toBe(USER);
    expect(rot.oldAdminRootPub).toBe(keys.adminPubHex);
    expect(rot.newAdminRootPub).toMatch(/^[0-9a-f]{64}$/);
    expect(rot.newAdminRootPub).not.toBe(keys.adminPubHex);
    expect(await verifies(page, rotationCanon, rot, post.body.signatureHex, keys.adminPubHex!)).toBe(true);
    const sessionPub = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      return ks.adminRootPubHex((await import("/lib/state.js")).getSession().adminRootSeed);
    });
    expect(sessionPub).toBe(rot.newAdminRootPub);
    await shot(page, testInfo, "security-rotated");
  });

  test("gym misc a non-admin device can't rotate the admin key", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get((u) => u.pathname === "/api/users/smoketest", { accountType: "single", totpEnrolledAt: null });
    await openSettings(page);
    await page.click("#settings-tab-account-security");
    const card = page.locator('[data-account-security-rotate="unavailable"]');
    await expect(card).toContainText("This device isn't an admin device, so it can't rotate the admin key.", { timeout: 10_000 });
    await expect(page.locator("#account-security-rotate-admin")).toHaveCount(0);
    await shot(page, testInfo, "security-rotate-non-admin");
  });

  // ───────────────────────────── trusted devices ─────────────────────────────

  test("gym misc trusted devices: an admin sets, locks and removes a managed name and renames the account", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    // The directory keeps what the admin root signs: a managed name and the account name.
    let managed: Record<string, unknown> | null = null;
    let accountProfile: Record<string, unknown> | null = null;
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, () => ({
      json: {
        accountId: ACCOUNT_ID,
        ...(accountProfile ? { accountProfile } : {}),
        devices: [
          { deviceId: DEVICE_ID, platformClass: "web", createdAt: Date.now() - 3_600_000 },
          { deviceId: PHONE, platformClass: "ios", supportCode: "K7Q2-9XPM", createdAt: Date.now() - 86_400_000 },
        ],
        selfProfiles: [],
        managedProfiles: managed ? [managed] : [],
        grants: [],
      },
    }));
    m.on("PUT", `/api/accounts/${ACCOUNT_ID}/devices/${PHONE}/managed-profile`, (call) => {
      managed = call.body.profile;
      return { json: { ok: true } };
    });
    m.on("DELETE", `/api/accounts/${ACCOUNT_ID}/devices/${PHONE}/managed-profile`, () => {
      managed = null;
      return { json: { ok: true } };
    });
    m.on("PUT", `/api/accounts/${ACCOUNT_ID}/profile`, (call) => {
      accountProfile = call.body.profile;
      return { json: { ok: true } };
    });
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    const phone = page.locator(`#trusted-devices-list [data-device-id="${PHONE}"]`);
    await expect(phone).toContainText("iPhone / iPad · Device K7Q2-9XPM", { timeout: 10_000 });

    // Set managed name: the administrator confirm can be declined.
    await phone.locator(`[data-managed-name="${PHONE}"]`).click();
    await expect(page.locator(".modal-title")).toHaveText("Administrator change");
    await page.click("[data-modal-cancel]");
    await phone.locator(`[data-managed-name="${PHONE}"]`).click();
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Managed device name");
    await page.fill(".modal-input", "Kitchen iPad");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Lock this name?");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Managed name updated");
    const put = m.last(`/devices/${PHONE}/managed-profile`, "PUT")!;
    const { signatureHex, ...unsigned } = put.body.profile;
    expect(unsigned.locked).toBe(true);
    expect(unsigned.signerPubHex).toBe(keys.adminPubHex);
    expect(await signer(page, keys, ["/lib/accountMetadata.js", "canonicalDeviceManagedProfile"], unsigned, signatureHex)).toBe("admin");
    // The name is ciphertext on the wire, the row reads it back decrypted.
    expect(JSON.stringify(put.body)).not.toContain("Kitchen iPad");
    await expect(phone).toContainText("Kitchen iPad", { timeout: 10_000 });
    await expect(phone).toContainText("Managed · locked");
    await shot(page, testInfo, "devices-managed-locked");

    // Remove managed name, after its confirm.
    await phone.locator(`[data-managed-remove="${PHONE}"]`).click();
    await expect(page.locator(".modal-title")).toHaveText("Remove managed name?");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Managed name removed");
    expect(m.sent(`/devices/${PHONE}/managed-profile`, "DELETE")).toHaveLength(1);
    expect(m.last(`/devices/${PHONE}/managed-profile`, "DELETE")!.body.expectedRevision).toBe(1);
    await expect(phone).not.toContainText("Kitchen iPad", { timeout: 10_000 });

    // Edit account name: a blank name is refused, then it's signed under the admin root.
    await page.click("#edit-account-display-name");
    await expect(page.locator(".modal-title")).toHaveText("Edit account name");
    await page.fill(".modal-input", " ");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("Enter an account name");
    await page.fill(".modal-input", "The Smiths");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Account name updated");
    const acct = m.last(`/api/accounts/${ACCOUNT_ID}/profile`, "PUT")!;
    const { signatureHex: acctSig, ...acctUnsigned } = acct.body.profile;
    expect(await signer(page, keys, ["/lib/accountMetadata.js", "canonicalAccountProfile"], acctUnsigned, acctSig)).toBe("admin");
    await expect(page.locator("#trusted-devices-list")).toContainText("The Smiths", { timeout: 10_000 });
    await shot(page, testInfo, "devices-account-renamed");
  });

  test("gym misc trusted devices on a non-admin device has no managed names or account name", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, {
      accountId: ACCOUNT_ID,
      devices: [
        { deviceId: DEVICE_ID, platformClass: "web", createdAt: Date.now() - 3_600_000 },
        { deviceId: PHONE, platformClass: "ios", supportCode: "K7Q2-9XPM", createdAt: Date.now() - 86_400_000 },
      ],
      selfProfiles: [],
      managedProfiles: [],
      grants: [],
    });
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    await expect(page.locator(`[data-device-id="${PHONE}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-managed-name]")).toHaveCount(0);
    await expect(page.locator("#edit-account-display-name")).toHaveCount(0);
    await expect(page.locator(`[data-self-rename="${DEVICE_ID}"]`)).toBeVisible();
    await shot(page, testInfo, "devices-non-admin");
  });

  test("gym misc a non-admin device can't add a device", async ({ page }, testInfo) => {
    await noSockets(page);
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, { accountId: ACCOUNT_ID, devices: [], selfProfiles: [], managedProfiles: [], grants: [] });
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    await expect(page.locator("#trusted-devices-add")).toBeDisabled({ timeout: 10_000 });
    await expect(page.locator("#trusted-devices-add-note")).toHaveText("Only an admin device of this account can add devices.");
    await shot(page, testInfo, "add-device-non-admin");
  });

  test("gym misc add a device's New code starts a fresh pairing link", async ({ page }, testInfo) => {
    await noSockets(page);
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, { accountId: ACCOUNT_ID, devices: [], selfProfiles: [], managedProfiles: [], grants: [] });
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    await page.click("#trusted-devices-add");
    const link = page.locator("#add-device-link");
    await expect(link).toHaveValue(/\/join/, { timeout: 15_000 });
    const first = await link.inputValue();
    await page.click("#add-device-restart");
    await expect.poll(() => link.inputValue(), { timeout: 15_000 }).not.toBe(first);
    expect(await link.inputValue()).toMatch(/\/join/);
    await shot(page, testInfo, "add-device-new-code");
    await page.click("#add-device-back");
    await expect(page.locator("#view-trusted-devices")).toBeVisible();
  });

  // ───────────────────────────── recovery ─────────────────────────────

  test("gym misc recovery: re-attach progress, removing cloud recovery, and a wrapped key exported and imported back", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    let enrolled = true;
    m.get("/api/recovery/by-username/smoketest", () =>
      enrolled ? { json: { credentialId: "c1".repeat(16), wrappedUmkHash: "ab".repeat(32) } } : { status: 404, json: { error: "not found" } });
    m.on("DELETE", "/api/recovery/by-username/smoketest", () => {
      enrolled = false;
      return { json: { ok: true } };
    });
    m.get("/api/screens/post-recovery/status", {
      report: { state: { lastSeen: { at: Date.now() - 60_000, objectedAt: null }, lastSwapTo: null }, apps: [] },
    });
    await openSettings(page);
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#recovery-cloud-pill")).toHaveText("on", { timeout: 10_000 });

    // Re-attach progress opens the report.
    await page.click("#recovery-open-reattach");
    await expect(page.locator("#view-post-recovery")).toBeVisible();
    await page.click("#post-recovery-back");
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    await page.click("#settings-tab-recovery");

    // Remove cloud recovery: Cancel keeps it; Remove deletes it, IRK-signed over the stored record.
    await page.click("#recovery-cloud-remove");
    await expect(page.locator(".modal-title")).toHaveText("Remove cloud recovery for smoketest?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/api/recovery/by-username/smoketest", "DELETE")).toHaveLength(0);
    await page.click("#recovery-cloud-remove");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Cloud recovery removed");
    const del = m.last("/api/recovery/by-username/smoketest", "DELETE")!;
    const req = del.body.request;
    const uploadCanon = (r: { username: string; credentialId: string; wrappedUmkHash: string; issuedAt: number }) =>
      `flagship/upload-recovery-record/v1|${r.username}|${r.credentialId}|${r.wrappedUmkHash}|${r.issuedAt}`;
    expect(await verifies(page, uploadCanon, req, del.body.signature, keys.irkPubHex)).toBe(true);
    await expect(page.locator("#recovery-cloud-pill")).toHaveText("off", { timeout: 10_000 });
    await expect(page.locator("#recovery-cloud-remove")).toBeHidden();
    await shot(page, testInfo, "recovery-cloud-removed");

    // The wrapped key: export it, then import that file back.
    await page.locator("summary", { hasText: "Advanced: legacy wrapped-UMK export" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#recovery-export")]);
    expect(download.suggestedFilename()).toMatch(/^flagship-wrapped-umk-\d+\.json$/);
    const file = readFileSync((await download.path())!);
    // The passphrase-wrapped key, never the key itself.
    const wrapped = JSON.parse(file.toString("utf8"));
    expect(Object.keys(wrapped).length).toBeGreaterThan(0);
    const umkHex = await page.evaluate(async () => (await import("/keystore.js")).bytesToHex((await import("/lib/state.js")).getSession().umk));
    expect(file.toString("utf8")).not.toContain(umkHex);
    await page.setInputFiles("#recovery-import-input", { name: "wrapped.json", mimeType: "application/json", buffer: file });
    await sawToast(page, "Imported — refresh, then unlock with your passphrase");
    await shot(page, testInfo, "recovery-wrapped-imported");
  });

  test("gym misc a backup file brings this browser into the account and starts the takeover's grace", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post("/api/users/smoketest/re-pair", (call) => ({
      json: { ok: true, accountType: "single", completesAt: Date.now() + 3 * 86_400_000, initiatedAt: Date.now(), oldIrkPub: call.body.request.oldIrkPub },
    }));
    // The account's key in a backup file with its own passphrase (the KDF is the real one).
    const fileText: string = await page.evaluate(async () => {
      const kf = await import("/lib/keyfile.js");
      const { getSession } = await import("/lib/state.js");
      return kf.wrapUmkToKeyfile(getSession().umk, "backup-file-pass-123", { username: "smoketest" }, { m: 1024, t: 1, p: 1 });
    });
    await openSettings(page);
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#view-recovery")).toBeVisible();
    await page.setInputFiles("#recovery-keyfile-input", { name: "smoketest.flagshipkey", mimeType: "application/json", buffer: Buffer.from(fileText) });
    await expect(page.locator(".modal-title")).toHaveText("Open backup file");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("Passphrase required");
    await page.fill(".modal-input", "backup-file-pass-123");
    await page.click("[data-modal-ok]");
    await expect(page.locator(".modal-title")).toHaveText("Lock this browser");
    await page.fill(".modal-input", "short");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("Use at least 8 characters");
    await page.fill(".modal-input", "new-device-passphrase");
    await page.click("[data-modal-ok]");

    // The import is a takeover: the re-pair is initiated with the rotated key,
    // proved with the registered one, and the grace sheet counts down.
    await sawToast(page, "Bringing this device into smoketest", 30_000);
    const rp = m.last("/api/users/smoketest/re-pair")!;
    expect(rp.body.request.oldIrkPub).toBe(keys.irkPubHex);
    expect(rp.body.request.newIrkPub).not.toBe(keys.irkPubHex);
    const rpCanon = (r: { username: string; newIrkPub: string; oldIrkPub: string; issuedAt: number }) =>
      `flagship/re-pair-initiate/v1|${r.username}|${r.newIrkPub}|${r.oldIrkPub}|${r.issuedAt}`;
    expect(await verifies(page, rpCanon, rp.body.request, rp.body.signature, rp.body.request.newIrkPub)).toBe(true);
    expect(await verifies(page, rpCanon, rp.body.request, rp.body.oldIrkSignature, keys.irkPubHex)).toBe(true);
    await expect(page.locator("[data-grace-line]")).toContainText("This device takes over in 2d 23h", { timeout: 10_000 });
    await expect(page.locator("[data-grace-finish]")).toBeDisabled();
    await shot(page, testInfo, "keyfile-grace");
  });

  test("gym misc a backup file's takeover finishes once its grace has passed", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post("/api/users/smoketest/re-pair", { ok: true, accountType: "single", completesAt: Date.now() + 1500, initiatedAt: Date.now() });
    m.post("/api/users/smoketest/re-pair/complete", { ok: true, outcome: "completed" });
    const fileText: string = await page.evaluate(async () => {
      const kf = await import("/lib/keyfile.js");
      const { getSession } = await import("/lib/state.js");
      return kf.wrapUmkToKeyfile(getSession().umk, "backup-file-pass-123", { username: "smoketest" }, { m: 1024, t: 1, p: 1 });
    });
    await openSettings(page);
    await page.click("#settings-tab-recovery");
    await page.setInputFiles("#recovery-keyfile-input", { name: "k.flagshipkey", mimeType: "application/json", buffer: Buffer.from(fileText) });
    await page.fill(".modal-input", "backup-file-pass-123");
    await page.click("[data-modal-ok]");
    await page.fill(".modal-input", "new-device-passphrase");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-grace-finish]")).toBeEnabled({ timeout: 15_000 });
    await shot(page, testInfo, "keyfile-grace-ready");
    await page.click("[data-grace-finish]");

    // The completion names the rotated key the initiate installed, signed by it.
    const done = await m.waitFor("/re-pair/complete");
    const rp = m.last("/api/users/smoketest/re-pair")!;
    expect(done.body.request.newIrkPub).toBe(rp.body.request.newIrkPub);
    const completeCanon = (r: { username: string; newIrkPub: string; issuedAt: number }) =>
      `flagship/re-pair-complete/v1|${r.username}|${r.newIrkPub}|${r.issuedAt}`;
    expect(await verifies(page, completeCanon, done.body.request, done.body.signature, rp.body.request.newIrkPub)).toBe(true);
    // The sheet closes and this device signs with the rotated key from now on.
    await expect(page.locator("[data-grace-finish]")).toHaveCount(0, { timeout: 10_000 });
    expect(await page.evaluate(async () => (await import("/keystore.js")).currentIrkVersion())).toBeGreaterThan(1);
  });

  // ───────────────────────────── profiles + settings rows ─────────────────────────────

  test("gym misc profiles with none offers Set one up, which opens the account cover", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    await page.evaluate(async () => {
      const profiles = await import("/lib/profiles.js");
      for (const p of profiles.loadProfiles().profiles) profiles.removeProfile(p.cloudName);
    });
    await page.evaluate(async () => {
      const { enterProfiles } = await import("/views/profiles.js");
      await enterProfiles();
    });
    await expect(page.locator("#view-profiles")).toContainText("No profiles yet", { timeout: 10_000 });
    await shot(page, testInfo, "profiles-none");
    await page.click("#profiles-set-up");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
  });

  test("gym misc companion requests: the Settings badge counts them, Deny and Approve resolve them", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    const now = Date.now();
    let pending = [
      { requestId: "r1", companionTokenPrefix: "ab12", kind: "release-server", intent: { username: USER, serverDomain: "media.smoketest.flagship.services" }, queuedAt: now - 60_000, expiresAt: now + 600_000 },
      { requestId: "r2", companionTokenPrefix: "cd34", kind: "release-server", intent: { username: USER, serverDomain: "attic.smoketest.flagship.services" }, queuedAt: now - 30_000, expiresAt: now + 600_000 },
    ];
    m.get("/api/screens/companion/pending-writes", () => ({ json: { pending } }));
    m.post("/api/screens/companion/resolve-pending", (call) => {
      pending = pending.filter((p) => p.requestId !== call.body.requestId);
      return { json: { ok: true } };
    });
    const relCanon = (r: { username: string; serverDomain: string; issuedAt: number }) => `flagship/release-server-name/v1|${r.username}|${r.serverDomain}|${r.issuedAt}`;
    m.post("/api/server/release", sensitive(page, keys, relCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true, released: true } })));
    await openSettings(page);
    const badge = page.locator("#companion-requests-badge");
    await expect(badge).toHaveText("2", { timeout: 10_000 });
    await expect(badge).toBeVisible();
    await shot(page, testInfo, "settings-companion-badge");
    await page.click("#settings-tab-companion-requests");
    const list = page.locator("#companion-requests-content");
    await expect(list.locator('[data-row="r1"]')).toContainText("Release the name: media.smoketest.flagship.services", { timeout: 10_000 });

    // Deny resolves without signing anything.
    await list.locator('[data-action="deny"][data-id="r2"]').click();
    await expect.poll(() => m.sent("/companion/resolve-pending").map((c) => c.body)).toContainEqual({ requestId: "r2", outcome: "denied" });
    expect(m.sent("/api/server/release")).toHaveLength(0);

    // Approve signs the release under the admin root, then resolves it.
    await list.locator('[data-action="approve"][data-id="r1"]').click();
    await expect.poll(() => m.sent("/companion/resolve-pending").map((c) => c.body)).toContainEqual({ requestId: "r1", outcome: "approved" });
    const rel = m.last("/api/server/release")!;
    expect(rel.body.request.serverDomain).toBe("media.smoketest.flagship.services");
    expect(await signer(page, keys, relCanon, rel.body.request, rel.body.signature)).toBe("admin");
    await expect(list).toContainText("No pending requests", { timeout: 10_000 });
    await page.click("#companion-requests-back");
    await expect(badge).toBeHidden({ timeout: 10_000 });
  });
  // ───────────────────────────── settings, links, tools ─────────────────────────────

  test("gym misc a saved key's default model is picked from its menu in AI keys", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post((u) => u.host === HOME && u.pathname === "/api/screens/ai/models", {
      kind: "own",
      listed: true,
      defaultModel: "gpt-5",
      models: [
        { id: "gpt-5", label: "GPT-5", contextTokens: 400_000 },
        { id: "gpt-5-mini", label: "GPT-5 mini", contextTokens: 128_000 },
      ],
    });
    const id: string = await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      const { addProvider, loadProviders } = await import("/providers.js");
      await addProvider(getSession().umk, { provider: "openai", label: "Work key", apiKey: "sk-gym-" + "x".repeat(40), relay: true });
      const list = await loadProviders(getSession().umk);
      return list.entries.find((e: { label: string }) => e.label === "Work key").id;
    });
    await page.click('[data-tab-target="settings"]');
    await page.click("#settings-tab-providers");
    const host = page.locator(`[data-default-model-for="${id}"]`);
    await expect(host.locator(".mm-trigger")).toBeVisible({ timeout: 10_000 });
    await host.locator(".mm-trigger").click();
    // The list comes from the current server, for this key only.
    const ask = await m.waitFor("/api/screens/ai/models");
    expect(ask.body.credential.provider).toBe("openai");
    await expect(host.locator("[data-mm-model]")).toHaveCount(2, { timeout: 10_000 });
    await shot(page, testInfo, "default-model-menu");
    await host.locator('[data-mm-model="gpt-5-mini"]').click();
    await expect(host.locator(".mm-trigger-text")).toContainText("GPT-5 mini");
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const { getSession } = await import("/lib/state.js");
          const { loadProviders } = await import("/providers.js");
          return (await loadProviders(getSession().umk)).entries.find((e: { id: string }) => e.id === id)?.defaultModel ?? null;
        }, id),
      )
      .toBe("gpt-5-mini");
  });

  test("gym misc Privacy and About open their links in a new tab", async ({ page }) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    await openSettings(page);
    await page.click("#settings-tab-privacy");
    const disclosure = page.locator("#view-privacy a.pill");
    await expect(disclosure).toHaveAttribute("target", "_blank");
    expect(await popupUrl(page, () => disclosure.click())).toBe("https://flagshipserver.com/security#disclosure");
    await page.click("#privacy-back");
    await page.click("#settings-tab-about");
    const home = page.locator('#view-about a[href="https://flagshipserver.com/"]');
    const report = page.locator('#view-about a[href$="#report"]');
    await expect(home).toHaveAttribute("target", "_blank");
    await expect(report).toHaveAttribute("rel", /noopener/);
    expect(await popupUrl(page, () => home.click())).toBe("https://flagshipserver.com/");
    expect(await popupUrl(page, () => report.click())).toBe("https://flagshipserver.com/security#report");
    await expect(page.locator("#view-about")).toBeVisible();
  });

  test("gym misc peer-backup shows the v2 status from its Settings row, holders as Server n", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    const status = (extra: Record<string, unknown>) => ({
      v: 2, policy: "peer", state: "protected", lastPlacedAt: Date.now() - 3_600_000, healthyBricks: 8, totalBricks: 8, holders: 2,
      archiveId: "ab".repeat(16), archiveCreatedAt: Date.now() - 7_200_000, hostingBytes: 0, provenBytes: 0, poolBytes: 0, keepUntil: null,
      holderList: [
        { label: "Server 1", state: "ok", lastProofAt: Date.now() - 600_000, bricks: 4 },
        { label: "Server 2", state: "failing", lastProofAt: null, bricks: 4 },
      ],
      hosting: { poolBytes: 8 * 1024 ** 3, realBytes: 2 * 1024 ** 3, fillerBytes: 5 * 1024 ** 3, provenBytes: 7 * 1024 ** 3, leases: 2, bricks: 6, reliability: 90, leaving: false },
      ...extra,
    });
    let body = status({});
    m.get("/api/screens/peer-backup/status", () => ({ json: body }));
    await openSettings(page);
    await page.click("#settings-tab-peer-backup");
    const content = page.locator("#peer-backup-content");
    await expect(content).toContainText("Protected", { timeout: 10_000 });
    await expect(content).toContainText("8 of 8");
    await expect(content.locator("[data-pb-holder]")).toHaveCount(2);
    await expect(content).toContainText("Server 2");
    await expect(content).toContainText("Not answering · no proof yet · 4 pieces");
    await expect(content).toContainText("Reliability score: 90 of 100");
    await expect(page.locator("#peer-backup-toggle")).toHaveCount(0);
    await shot(page, testInfo, "peer-backup-v2");
    body = status({ state: "at-risk", reason: "two servers holding pieces went away", healthyBricks: 3, keepUntil: Date.now() + 5 * 86_400_000 });
    await page.click("#peer-backup-refresh");
    await expect(content).toContainText("At risk", { timeout: 10_000 });
    await expect(content).toContainText("two servers holding pieces went away");
    await expect(content).toContainText("Restore by");
    await expect(content).toContainText("3 of 8");
    // A server that still runs the pre-v2 peer backup says so.
    body = { participating: true, peersBackingYouUp: [], shards: [], stats: {} } as unknown as ReturnType<typeof status>;
    await page.click("#peer-backup-refresh");
    await expect(content).toContainText("older peer backup", { timeout: 10_000 });
  });

  test("gym misc the take-over dialog's Cancel closes it, and Scan is offered only with a camera API", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [] });
    await page.evaluate(async () => (await import("/views/home.js")).renderHome());
    await page.click("#home-take-over");
    const dlg = page.locator('dialog[aria-label="Take over a box"]');
    await expect(dlg.locator("[data-claim-input]")).toBeVisible({ timeout: 10_000 });
    const hasCamera = await page.evaluate(() => "BarcodeDetector" in window);
    if (hasCamera) {
      // No camera in the gym: the scan says why instead of hanging.
      await dlg.locator("[data-claim-scan]").click();
      await expect(dlg.locator("[data-claim-error]")).toBeVisible({ timeout: 40_000 });
    } else {
      await expect(dlg.locator("[data-claim-scan]")).toHaveCount(0);
    }
    await shot(page, testInfo, "take-over-dialog");
    await dlg.locator("[data-claim-cancel]").click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator("#view-home")).toBeVisible();
    expect(m.sent("transfer")).toHaveLength(0);
  });

  test("gym misc pod pair forgets the server only after Unpair is confirmed", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    await page.locator("#view-home summary", { hasText: "Advanced" }).first().click();
    await page.click("#open-pod-pair");
    const status = page.locator("#pod-pair-status");
    await expect(status).toContainText(`Paired to https://${HOME}`, { timeout: 10_000 });
    await page.click("#pod-pair-unpair");
    await expect(page.locator(".modal-title")).toHaveText("Forget this server?");
    await page.click("[data-modal-cancel]");
    await expect(status).toContainText(`Paired to https://${HOME}`);
    await page.click("#pod-pair-unpair");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Unpaired");
    await expect(status).toContainText("Not paired with any server yet");
    expect(await page.evaluate(async () => (await import("/lib/api.js")).getPodBaseUrl())).toBe("");
    await shot(page, testInfo, "pod-unpaired");
  });

  test("gym misc Remote opens the remote page in a new tab", async ({ page }) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get("/api/screens/companion/list", { companions: [] });
    await openSettings(page);
    await page.click("#settings-tab-companion-dock");
    const link = page.locator("#view-companion-dock a", { hasText: "Open the remote page" });
    await expect(link).toHaveAttribute("href", "https://remote.flagshipserver.com/", { timeout: 10_000 });
    expect(await popupUrl(page, () => link.click())).toBe("https://remote.flagshipserver.com/");
  });

  test("gym misc Process URL signs a browser in to an app with this device's key", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post((u) => u.host === HOME && u.pathname === "/api/service-access/knock/authorize", (call) => ({
      json: { authorized: true, secretId: "5e".repeat(32), serviceRef: call.body.authorization.serviceRef, browserAgent: "Firefox on a laptop", startedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
    }));
    const PAGE = "pg" + "7".repeat(30);
    const link = `${CONTROL}/access#server=${HOME}&svc=notes&ref=${SERVICE_ID}&page=${PAGE}`;
    await openSettings(page);
    await page.click("#settings-tab-process-url");
    // Not an access link: refused in place.
    await page.fill("#aa-link", "https://example.com/nope");
    await page.click("#aa-process");
    await expect(page.locator("#access-authorize-content")).toContainText("That doesn't look like a Flagship access link.");
    await page.fill("#aa-link", link);
    await page.click("#aa-process");
    await expect(page.locator("#access-authorize-content .card-title")).toHaveText("Open notes on home?");
    await shot(page, testInfo, "process-url-confirm");
    await page.click("#aa-authorize");
    await expect(page.locator("#access-authorize-content .card-title")).toHaveText("Signed in", { timeout: 10_000 });

    // Signed with this account device's key, over the box's canonical bytes.
    const post = m.last("/api/service-access/knock/authorize")!;
    const a = post.body.authorization;
    expect(a).toMatchObject({ serverId: HOME, serviceRef: SERVICE_ID, pageId: PAGE });
    const devicePub = await page.evaluate(
      async ({ accountId, deviceId }) => {
        const ks = await import("/keystore.js");
        const { getSession } = await import("/lib/state.js");
        return ks.bytesToHex((await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, accountId, deviceId)).publicKey);
      },
      { accountId: ACCOUNT_ID, deviceId: DEVICE_ID },
    );
    expect(a.visitorAID).toBe(devicePub);
    const knockCanon = (k: { serverId: string; serviceRef: string; pageId: string; visitorAID: string; issuedAt: number }) =>
      `flagship/service-knock/v1|${k.serverId}|${k.serviceRef}|${k.pageId}|${k.visitorAID}|${k.issuedAt}`;
    expect(await verifies(page, knockCanon, a, post.body.sig, devicePub)).toBe(true);
    await expect(page.locator("#aa-open")).toHaveAttribute("href", `https://notes.${HOME}`);
    await shot(page, testInfo, "process-url-signed-in");

    // Manage secured sessions lists the new one.
    await page.click("#aa-sessions");
    await expect(page.locator("#view-secured-sessions")).toBeVisible();
    await expect(page.locator("#view-secured-sessions")).toContainText("notes", { timeout: 10_000 });

    // A locked device is asked to unlock first.
    await page.evaluate(async (raw) => {
      (await import("/lib/state.js")).lockSession();
      await (await import("/views/access-authorize.js")).enterAccessAuthorize(raw);
    }, link);
    await expect(page.locator("#access-authorize-content")).toContainText("Unlock this device to continue.");
    await page.click("#aa-unlock");
    await expect(page.locator("#view-unlock")).toBeVisible();
  });

  test("gym misc Process URL's Open goes to the app", async ({ page }) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post((u) => u.host === HOME && u.pathname === "/api/service-access/knock/authorize", { authorized: true, secretId: "6f".repeat(32) });
    m.get((u) => u.host === `notes.${HOME}`, () => ({ status: 200, raw: "<p>notes</p>", contentType: "text/html" }));
    await page.evaluate(
      async (raw) => (await import("/views/access-authorize.js")).enterAccessAuthorize(raw),
      `${CONTROL}/access#server=${HOME}&svc=notes&ref=${SERVICE_ID}&page=pg${"8".repeat(30)}`,
    );
    await page.click("#aa-authorize");
    await page.click("#aa-open", { timeout: 10_000 });
    await page.waitForURL(`https://notes.${HOME}/`);
  });

  test("gym misc an invite link on a browser with no account offers Set up an account", async ({ page }, testInfo) => {
    await mock(page);
    await page.goto(`/invite#server=${HOME}&k=${"ab".repeat(32)}&a=${"cd".repeat(32)}&i=${"ef".repeat(32)}&s=${SERVICE_ID}`);
    await expect(page.locator("#invite-redeem-content")).toContainText("You've been invited", { timeout: 15_000 });
    await shot(page, testInfo, "invite-no-account");
    await page.click("#ir-setup");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
  });

  test("gym misc an accepted invite's Open it goes to the app's server", async ({ page }) => {
    await createAccount(page);
    const m = await mock(page);
    m.post((u) => u.host === HOME && u.pathname === "/api/service-invites/redeem", { serviceRef: SERVICE_ID, boundAID: "00".repeat(32), firstBind: true });
    m.get((u) => u.host === HOME && !u.pathname.startsWith("/api/"), () => ({ status: 200, raw: "<p>home</p>", contentType: "text/html" }));
    await page.goto(`/invite#server=${HOME}&k=${"ab".repeat(32)}&a=${"cd".repeat(32)}&i=${"ef".repeat(32)}&s=${SERVICE_ID}`);
    await page.click("#ir-unlock", { timeout: 15_000 });
    await page.fill("#unlock-passphrase", PASSPHRASE);
    await page.click("#unlock-go");
    await page.click("#ir-accept", { timeout: 30_000 });
    await expect(page.locator("#invite-redeem-content")).toContainText("You're in", { timeout: 10_000 });
    await page.click("#ir-open");
    await page.waitForURL((u) => u.host === HOME);
  });

  test("gym misc the browser viewer lists an app's tabs, refreshes them and streams one", async ({ page }, testInfo) => {
    // The socket mock is set up when a page loads, so route it first.
    const inputs: string[] = [];
    await page.routeWebSocket(/\/api\/screens\/browser-tabs\/[^/]+\/stream/, (ws) => {
      ws.onMessage((msg) => inputs.push(String(msg)));
      ws.send(JSON.stringify({ kind: "frame", dataBase64: FRAME_JPEG }));
    });
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get(`/api/screens/app-detail/${SERVICE_ID}`, {
      app: { serviceId: SERVICE_ID, slug: "notes", creator: USER, status: "running", version: "1.0.0", url: `https://notes.${HOME}` },
      manifest: { name: "notes", browser: { start: "https://example.com/login" } },
      dataLayerInstances: [],
      members: [],
      browserTabs: [{ tabId: "t1" }],
      editable: false,
    });
    let tabs = [{ tabId: "t1", title: "Sign in", currentUrl: "https://example.com/login" }];
    m.get(`/api/screens/browser-tabs/list/${SERVICE_ID}`, () => ({ json: { tabs } }));
    await page.evaluate(async (id) => (await import("/views/service-detail.js")).enterServiceDetail(id), SERVICE_ID);
    await page.click("#sd-open-browser", { timeout: 10_000 });
    await expect(page.locator("#view-browser-viewer")).toBeVisible();
    await expect(page.locator("#bv-tabs")).toContainText("Sign in", { timeout: 10_000 });
    tabs = [...tabs, { tabId: "t2", title: "Dashboard", currentUrl: "https://example.com/home" }];
    await page.click("#bv-refresh");
    await expect(page.locator('#bv-tabs [data-action="open"]')).toHaveCount(2, { timeout: 10_000 });
    await page.locator('#bv-tabs [data-action="open"][data-tab-id="t1"]').click();
    await expect(page.locator("#bv-stream-status")).toHaveText("streaming tab t1", { timeout: 10_000 });
    await expect(page.locator("#bv-frame")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    // Input on the frame goes back down the stream.
    await page.locator("#bv-frame").click({ force: true });
    await expect.poll(() => inputs.some((i) => i.includes('"kind":"input"'))).toBe(true);
    await shot(page, testInfo, "browser-viewer-stream");
  });

  test("gym misc create server mints a recipe with its expiry and boot mode, approved under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.post("/api/auth-code/issue", { ok: true });
    const rckCanon = (r: { username: string; subdomain: string; rckPubKey: string; issuedAt: number }) =>
      `flagship/rck-register/v1|${r.username}|${r.subdomain}|${r.rckPubKey}|${r.issuedAt}`;
    m.post("/api/routing/register-rck", sensitive(page, keys, rckCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    await page.evaluate(async () => (await import("/views/home.js")).renderHome());
    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or restore a server"] [data-choice-add]').click();
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    await page.fill("#cs-server-name", "attic");
    await page.check('input[name="cs-backup-policy"][value="none"]');
    await page.fill("#cs-ttl-hours", "12");
    await page.check('input[name="cs-boot-unlock"][value="approve"]');
    await expect(page.locator('input[name="cs-boot-unlock"][value="auto"]')).not.toBeChecked();
    await expect(page.locator("#view-create-server a", { hasText: "Get Flagship Studio" })).toHaveAttribute("href", "https://flagshipserver.com/studio");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#cs-download-recipe")]);
    await expect(page.locator("#cs-status")).toHaveText("Recipe downloaded — open it in Flagship Studio.", { timeout: 15_000 });
    expect(download.suggestedFilename()).toMatch(/^flagship-recipe-attic\.smoketest\.flagship\.services-/);
    const recipe = JSON.parse(readFileSync((await download.path())!).toString("utf8"));
    expect(recipe.serverDomain).toBe("attic.smoketest.flagship.services");
    expect(recipe.bootUnlockMode).toBe("approve");
    expect(recipe.authCode.expiresAt - recipe.authCode.issuedAt).toBe(12 * 3_600_000);
    expect(recipe.authCode.adminRootPubKey).toBe(keys.adminPubHex);
    // Secret-free by default: no disk key, no pairing order.
    expect(recipe.swkHex).toBeUndefined();
    expect(recipe.pairingOrder).toBeUndefined();

    // The AuthCode: the IRK signs it (pinning the admin root), the admin root approves it.
    const issue = m.last("/api/auth-code/issue")!;
    const c = issue.body.code;
    const inner = `flagship/auth-code/v1|${c.version}|${c.serial}|${c.username}|${c.serverName}|${c.serverDomain}|${c.delegatedPubKey}|${c.userPubKey}|${c.issuedAt}|${c.expiresAt}|ar=${keys.adminPubHex}`;
    expect(await verifies(page, () => inner, c, issue.body.signature, keys.irkPubHex)).toBe(true);
    expect(await verifies(page, () => `flagship/auth-code-admin/v1|${inner}`, c, issue.body.adminSignature, keys.adminPubHex!)).toBe(true);
    expect(recipe.authCodeUserSignature).toBe(issue.body.signature);
    const rck = m.last("/api/routing/register-rck")!;
    expect(rck.body.request.subdomain).toBe("attic.smoketest.flagship.services");
    expect(await signer(page, keys, rckCanon, rck.body.request, rck.body.signature)).toBe("admin");
    await shot(page, testInfo, "create-server-recipe");

    // Follow its setup: the pending view, on the new order's own status channel.
    m.get(`/api/order/${recipe.authCode.serial}/status`, { phase: "booting" });
    await page.click("#cs-follow-setup");
    await expect(page.locator("#view-pending-server")).toBeVisible();
    await expect(page.locator("#pending-server-fqdn")).toHaveText("attic.smoketest.flagship.services");
    await expect(page.locator("#pending-server-note")).toHaveText("Booting up", { timeout: 10_000 });
  });
  test("gym misc a second browser joins the account through Add a device, opens it, and unlocks it after a reload", async ({ page, browser }, testInfo) => {
    test.setTimeout(150_000);
    // One relay for both browsers, playing `.com`'s qr-pipe (apps/com/src/buildRelay.ts).
    const hub = relayHub();
    await page.routeWebSocket(/\/qr-pipe\//, hub);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    basePods(m);
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, { accountId: ACCOUNT_ID, devices: [], selfProfiles: [], managedProfiles: [], grants: [] });
    await openSettings(page);
    await page.click("#settings-tab-trusted-devices");
    await page.click("#trusted-devices-add");
    const link = page.locator("#add-device-link");
    await expect(link).toHaveValue(/\/join\?sid=/, { timeout: 15_000 });
    const joinUrl = new URL(await link.inputValue());

    // The other browser: its own storage, no account yet.
    const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block", viewport: { width: 430, height: 932 } });
    const joiner = await other.newPage();
    try {
      await joiner.routeWebSocket(/\/qr-pipe\//, hub);
      const jm = await mock(joiner);
      jm.get("/api/users/smoketest/pubkey-cert", { binding: { pubKey: keys.irkPubHex } });
      jm.post("/api/users/smoketest/devices/admit", { ok: true, tokenId: "tok-gym", quarantineUntil: Date.now() + 14 * 86_400_000 });
      await joiner.goto(`${joinUrl.pathname}${joinUrl.search}`);
      await expect(joiner.locator("#view-join")).toBeVisible({ timeout: 15_000 });

      // First the passphrase that will lock the account in this browser.
      const JOIN_PASS = "joiner-chose-this";
      await expect(joiner.locator(".modal-title")).toHaveText("Lock this browser", { timeout: 10_000 });
      await joiner.fill(".modal-input", "short");
      await joiner.click("[data-modal-ok]");
      await expect(joiner.locator("[data-modal-error]")).toHaveText("Use at least 8 characters");
      await joiner.fill(".modal-input", JOIN_PASS);
      await joiner.click("[data-modal-ok]");
      await expect(joiner.locator(".modal-title")).toHaveText("Confirm passphrase");
      await joiner.fill(".modal-input", JOIN_PASS);
      await joiner.click("[data-modal-ok]");

      // Both screens show the same code before either side goes on.
      const adminSas = page.locator("#add-device-sas");
      const joinSas = joiner.locator("#join-sas");
      await expect(joinSas).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
      await expect(adminSas).not.toHaveText(/—/, { timeout: 15_000 });
      const code = (s: string) => s.replace(/\D/g, "");
      expect(code(await adminSas.innerText())).toBe(code(await joinSas.innerText()));
      await shot(page, testInfo, "join-admin-sas");
      await joiner.click("#join-confirm");
      await expect(page.locator("#add-device-confirm")).toBeEnabled({ timeout: 5_000 });
      await page.click("#add-device-confirm");

      // The joiner verifies the admit under the account's key, joins under review, and opens it.
      await expect(joiner.locator("#join-quarantine")).toContainText("Under review", { timeout: 30_000 });
      await expect(joiner.locator("#join-status")).toHaveText("joined.");
      await sawToast(page, "Device added (quarantined for review)", 30_000);
      const admit = jm.last("/devices/admit")!;
      // The admin's vouch: the account IRK signs this device's key.
      expect(admit.body.admit.username).toBe(USER);
      expect(await verifies(page, ["/lib/crossDevicePairing.js", "deviceAdmitCanonicalBytes"], admit.body.admit, admit.body.admitSig, keys.irkPubHex)).toBe(true);
      // What .com now requires (400 "missing device bootstrap" without it): a
      // member grant for the new device's key, signed by the account key, and
      // the device's own signed, encrypted name.
      const body = admit.body;
      expect(body.grant).toMatchObject({
        username: USER, deviceId: body.admit.deviceId, devicePubHex: body.admit.newDevicePubHex,
        signerRoot: "membership", scopes: ["browse", "install-service", "vibe-code", "view-directory"],
      });
      expect(await verifies(page, ["/lib/crossDevicePairing.js", "deviceGrantCanonicalBytes"], body.grant, body.grantSignature, keys.irkPubHex)).toBe(true);
      expect(body.profile).toMatchObject({ accountId: USER, deviceId: body.admit.deviceId, signerPubHex: body.admit.newDevicePubHex });
      expect(body.profile.ciphertextHex).toMatch(/^[0-9a-f]+$/);
      await shot(joiner, testInfo, "join-under-review");
      await joiner.click("#join-open");
      await expect(joiner.locator("#view-join")).toBeHidden({ timeout: 15_000 });
      const joined = await joiner.evaluate(async () => (await import("/lib/state.js")).getSession().username);
      expect(joined).toBe(USER);

      // A reload locks the app; the passphrase the joiner chose opens it again.
      const umkHex = await joiner.evaluate(async () => (await import("/keystore.js")).bytesToHex((await import("/lib/state.js")).getSession().umk));
      await joiner.goto("/index.html");
      await expect(joiner.locator("#view-unlock")).toBeVisible({ timeout: 15_000 });
      await joiner.fill("#unlock-passphrase", "not-the-passphrase");
      await joiner.click("#unlock-go");
      await expect(joiner.locator("#view-unlock")).toBeVisible();
      await joiner.fill("#unlock-passphrase", JOIN_PASS);
      await joiner.click("#unlock-go");
      await expect(joiner.locator("#view-unlock")).toBeHidden({ timeout: 15_000 });
      const reopened = await joiner.evaluate(async () => {
        const { getSession } = await import("/lib/state.js");
        const s = getSession();
        return { username: s.username, umkHex: (await import("/keystore.js")).bytesToHex(s.umk) };
      });
      expect(reopened).toEqual({ username: USER, umkHex });
      const deviceSigns = await joiner.evaluate(async ({ id, pub }) => {
        const ks = await import("/keystore.js");
        const { getSession } = await import("/lib/state.js");
        const msg = new Uint8Array([9, 8, 7]);
        const sig = await ks.signWithAccountDeviceKey(getSession().umk, "smoketest", id, msg);
        return ks.verifyWithEd25519Pub(ks.hexToBytes(pub), sig, msg);
      }, { id: admit.body.admit.deviceId, pub: admit.body.admit.newDevicePubHex });
      expect(deviceSigns).toBe(true);
      await shot(joiner, testInfo, "join-reload-unlocked");
    } finally {
      await other.close();
    }
  });
});
