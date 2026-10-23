/**
 * Store captures from the webapp (scripts/store-assets/capture.config.ts). Each slide's screen is the real webapp,
 * opened on the made-up world in store/demo-world.json (an account called river-otter, servers home and cabin, five
 * apps, three members), answered by the mock gym's router (apps/web/e2e/gym/gymKit.ts) so nothing reaches a network
 * and no real person, box or address appears. Only the UI language and the light/dark setting change between
 * captures. Slide 6 (the watch) has no webapp screen. Signatures the webapp checks (the start-up request) are real.
 */

import { test, expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mock, type Mock } from "../../apps/web/e2e/gym/gymKit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const world = JSON.parse(fs.readFileSync(path.join(ROOT, "store/demo-world.json"), "utf8"));
const locales = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/locales.json"), "utf8"));
const LANGS: string[] = process.env.STORE_LANGS?.split(",") ?? locales.locales.filter((l: { status: string }) => l.status === "ga").map((l: { code: string }) => l.code);
const ONLY = process.env.STORE_SLIDES?.split(",");
const ONLY_DEVICES = process.env.STORE_DEVICES?.split(",");

type Server = { name: string; fqdn: string; leader: boolean; uptimeHours: number };
type App = { slug: string; name: string; summary: string; server: string; access: string };
const USER: string = world.account;
const SERVERS: Server[] = world.servers;
const APPS: App[] = world.apps;
const CONTROL = "https://flagshipserver.com";
const fqdn = (name: string) => SERVERS.find((s) => s.name === name)!.fqdn;
const serviceId = (slug: string) => `${USER}--${slug}`;
const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const DEVICE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PHONE_DEVICE_ID = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const ADMIN_SEED_HEX = "5a".repeat(32);
const HOUR = 3_600_000;
/** Every capture happens at the same moment, so dates and times on screen are the same in every run. */
const NOW = Date.UTC(2026, 9, 21, 9, 0);
const GB = 1024 ** 3;

/** Each server's signing key (STK), real, so the start-up request below verifies the way it does live. */
const STK = Object.fromEntries(SERVERS.map((s) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  return [s.fqdn, { pubHex, privateKey }];
}));

/** The devices a capture is made on: CSS size x scale = the stand-in's pixel size (store/store.json captureSize). */
const DEVICES = {
  phone: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
  tablet: { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2 },
} as const;

/** Slides in the light/dark setting of their place in the strip (brief §3). */
const SLIDES: { id: string; scheme: "light" | "dark"; open: (page: Page, m: Mock) => Promise<void> }[] = [
  { id: "01", scheme: "light", open: openHome },
  { id: "02", scheme: "dark", open: openApproval },
  { id: "03", scheme: "light", open: openApps },
  { id: "04", scheme: "dark", open: openMembers },
  { id: "05", scheme: "light", open: openBackups },
];

// ───────────────────────────── the session ─────────────────────────────

const PASSPHRASE = "store-capture-passphrase-not-a-secret";

/** Create the account and unlock it. The gym's own helpers wait for English text; these wait on the page's
 *  structure only, so the same steps work in every language. */
async function createAndUnlock(page: Page): Promise<void> {
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.click("#bootstrap-create");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-input")).toHaveValue("", { timeout: 10_000 });
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 30_000 });
  await page.goto("/index.html?view=home");
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 15_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#toast")).toBeVisible({ timeout: 30_000 });
}

/** An admin device of river-otter, paired to both servers, signed in. */
async function signIn(page: Page): Promise<void> {
  await createAndUnlock(page);
  await page.evaluate(
    async ({ servers, USER, ACCOUNT_ID, DEVICE_ID, ADMIN_SEED_HEX, CONTROL }) => {
      const ks = await import("/keystore.js");
      const profiles = await import("/lib/profiles.js");
      const store = await import("/lib/profilesStore.js");
      const { getSession } = await import("/lib/state.js");
      const api = await import("/lib/api.js");
      await ks.adoptProfileKeys(USER);
      profiles.addProfile({ cloudName: USER, accountId: ACCOUNT_ID, deviceId: DEVICE_ID });
      store.ensureProfile(USER);
      store.setActiveCloudName(USER);
      store.set("username", USER);
      const s = getSession();
      s.username = USER;
      s.adminRootSeed = ks.hexToBytes(ADMIN_SEED_HEX);
      api.setPodBaseUrl(`https://${servers[0]}`);
      for (const b of servers) api.setSessionTokenForPod(b, `store-token-${b}`);
      api.setSessionToken(`store-token-${servers[0]}`);
      (await import("/lib/apex.js")).setApexOverride({ control: CONTROL });
    },
    { servers: SERVERS.map((s) => s.fqdn), USER, ACCOUNT_ID, DEVICE_ID, ADMIN_SEED_HEX, CONTROL },
  );
  // Toasts are moments, not screens ("Unlocked" from the sign-in above).
  await page.addStyleTag({ content: "#toast { display: none !important; }" });
}

// ───────────────────────────── the world ─────────────────────────────

const onHost = (host: string, p: string) => (u: URL) => u.host === host && u.pathname === p;
const appsOn = (server: string) => APPS.filter((a) => a.server === server);
const appRow = (a: App) => ({
  serviceId: serviceId(a.slug), slug: a.slug, displayLabel: a.name, name: a.name, creator: USER, summary: a.summary,
  status: "running", version: "1.0.0", url: `https://${a.slug}.${fqdn(a.server)}`, accessMode: a.access === "members" ? "restricted" : "open",
});

function startUpRequest(server: string) {
  const f = fqdn(server);
  const nonceHex = crypto.randomBytes(32).toString("hex");
  const issuedAt = NOW - world.unlockRequest.askedMinutesAgo * 60_000;
  const canonical = ["flagship/secret-request/v1", f, STK[f]!.pubHex, "unlock-key", nonceHex, issuedAt].join("|");
  const requestSignature = crypto.sign(null, Buffer.from(canonical), STK[f]!.privateKey).toString("hex");
  return { serverDomain: f, stkPub: STK[f]!.pubHex, purpose: "unlock-key", requestNonceHex: nonceHex, requestSignature, issuedAt };
}

function pods(waiting: ReturnType<typeof startUpRequest> | null) {
  const t0 = NOW - 6 * HOUR;
  return {
    pods: SERVERS.map((s) => ({
      serverDomain: s.fqdn, identityPubKey: STK[s.fqdn]!.pubHex, liveness: "live", lastReported: NOW - 20_000,
      registeredAt: NOW - 40 * 24 * HOUR, orderIssuedAt: t0, appsServed: appsOn(s.name).map((a) => serviceId(a.slug)),
      ...(waiting && waiting.serverDomain === s.fqdn
        ? { pendingRequests: [{ id: waiting.requestNonceHex, type: "unlock-key", issuedAt: waiting.issuedAt, expiresAt: waiting.issuedAt + 600_000 }] }
        : {}),
    })),
    serverOrder: { order: { user: USER, stks: SERVERS.map((s) => STK[s.fqdn]!.pubHex), issuedAt: t0, nonce: "ab".repeat(32) }, signature: "00".repeat(64) },
  };
}

function serverDetail(server: Server) {
  return {
    serverFqdn: server.fqdn, username: USER, daemonVersion: "0.2.0", currentCommit: "7ac1b50a".padEnd(40, "1"),
    uptimeMs: server.uptimeHours * HOUR, certNotAfter: NOW + 60 * 24 * HOUR, certSans: [server.fqdn],
    serviceCount: appsOn(server.name).length, pairedSessionCount: 2, recentInstallEvents: [],
  };
}

async function installWorld(page: Page, { waiting = false } = {}): Promise<Mock> {
  const m = await mock(page);
  const req = waiting ? startUpRequest(world.unlockRequest.server) : null;
  m.get(`/api/users/${USER}/pods`, pods(req));
  m.on("POST", "/api/secret-requests", { requests: req ? [req] : [] });
  m.get("/api/secret-requests", { requests: req ? [req] : [] });
  for (const s of SERVERS) {
    m.get(onHost(s.fqdn, "/api/screens/apps-list"), { apps: appsOn(s.name).map(appRow) });
    m.get(onHost(s.fqdn, "/api/screens/server-detail"), serverDetail(s));
    m.get(onHost(s.fqdn, "/api/leads"), { leads: s.leader ? APPS.map((a) => a.slug) : [] });
  }
  m.get((u) => /\/api\/users\/[^/]+\/apps\/[^/]+\/links$/.test(u.pathname), (c: { url: URL }) => {
    const id = decodeURIComponent(c.url.pathname.split("/")[5]!);
    const a = APPS.find((x) => serviceId(x.slug) === id);
    return { json: a ? { canonicalUrl: `https://${a.slug}.${fqdn(a.server)}` } : {} };
  });
  return m;
}

// ───────────────────────────── the slides ─────────────────────────────

async function openHome(page: Page): Promise<void> {
  await page.evaluate(async () => (await import("/views/home.js")).renderHome());
  await expect(page.locator(`#servers-list [data-open-fqdn="${fqdn("cabin")}"]`)).toBeVisible({ timeout: 10_000 });
}

async function openApproval(page: Page): Promise<void> {
  await page.evaluate(async () => (await import("/views/boot-approval.js")).enterBootApproval());
  await expect(page.locator("[data-approve-id]")).toBeVisible({ timeout: 10_000 });
  await scrollToTop(page, "#activity-approvals");
}

async function openApps(page: Page): Promise<void> {
  // "All servers": every box's apps in one list
  await page.evaluate(async () => (await import("/lib/api.js")).setPodBaseUrl(""));
  await page.click('[data-tab-target="apps"]');
  await expect(page.locator("#services-list-content .fs-app-card")).toHaveCount(APPS.length, { timeout: 10_000 });
}

async function openMembers(page: Page, m: Mock): Promise<void> {
  const app = APPS.find((a) => a.slug === world.membersApp)!;
  const id = serviceId(app.slug);
  const sealed = await page.evaluate(
    async ({ members }) => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      const hk = await ks.deriveHouseholdKeyFromSeed(getSession().umk);
      const out: Record<string, string> = {};
      for (const p of members) out[p.name] = await si.sealInviteBundle({ name: p.name }, hk, `inv-${p.name.toLowerCase()}`);
      const dev = await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "a1b2c3d4e5f60718293a4b5c6d7e8f90");
      return { bundles: out, devicePub: ks.bytesToHex(dev.publicKey) };
    },
    { members: world.members },
  );
  const people = world.members as { name: string; rank: string }[];
  const aid = (i: number) => String(i + 6).repeat(64).slice(0, 64);
  m.get(`/api/users/${USER}/service-invites`, {
    invites: people.map((p, i) => ({
      inviteId: `inv-${p.name.toLowerCase()}`, serviceRef: id, encryptedBundle: sealed.bundles[p.name], boundAID: aid(i),
      boundAt: NOW - (i + 2) * 24 * HOUR, createdAt: NOW - (i + 3) * 24 * HOUR, approvalMode: "auto",
    })),
  });
  m.get((u) => u.pathname === `/api/screens/services/${id}/members`, {
    mode: "restricted",
    roles: ["member", "manager", "master"],
    defaultRole: "member",
    descriptions: { member: "Plays games", manager: "Runs the ladder", master: "Manages who's in" },
    accountMembers: [
      { kind: "device", deviceId: DEVICE_ID, devicePub: sealed.devicePub, tier: "admin", rank: "master", set: false, refused: false },
      { kind: "device", deviceId: PHONE_DEVICE_ID, devicePub: "7b".repeat(32), tier: "admin", rank: "master", set: false, refused: false },
    ],
    members: people.map((p, i) => ({ aid: aid(i), role: p.rank, grants: [{ inviteId: `inv-${p.name.toLowerCase()}`, role: p.rank }], direct: false })),
    invites: people.map((p) => ({ inviteId: `inv-${p.name.toLowerCase()}`, role: p.rank, set: p.rank !== "member" })),
  });
  await page.evaluate(
    async ({ service, server }) => {
      (await import("/lib/api.js")).setPodBaseUrl(`https://${server}`);
      await (await import("/views/service-access.js")).enterServiceAccess(service);
    },
    { service: appRow(app), server: fqdn(app.server) },
  );
  await expect(page.locator("#sa-members-title")).toContainText(String(people.length), { timeout: 10_000 });
  await expect(page.locator("#sa-people .card")).toHaveCount(people.length, { timeout: 10_000 });
  await scrollToTop(page, "#sa-members-title");
}

async function openBackups(page: Page, m: Mock): Promise<void> {
  const b = world.backups;
  const home = fqdn(b.server);
  const at = (p: string) => onHost(home, p);
  const names = appsOn(b.server).map((a) => ({ serviceId: serviceId(a.slug), name: a.name }));
  const entry = (hoursAgo: number, i: number) => ({
    archiveId: String(i + 5).repeat(32), createdAt: NOW - hoursAgo * HOUR, trigger: "schedule",
    bytes: b.sizeGiB * GB, backupBytes: 2048, bundleBytes: b.sizeGiB * GB + 2064, bundleFileName: `${b.server}.flagship`,
    bundleSha256: "ab".repeat(32), sha256: "cd".repeat(32), backupFileName: `${b.server}.flagship-backup`, dataFileName: `${b.server}.flagship-data`,
    apps: names, left: [],
  });
  const backups = [b.lastHoursAgo, b.lastHoursAgo + 24, b.lastHoursAgo + 48].map(entry);
  m.get(at("/api/screens/server-archive/backups"), {
    schedule: { frequency: "daily", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: b.keep, keepWeekly: 4 },
    scheduleActive: true, nextRunAt: NOW + (24 - b.lastHoursAgo) * HOUR, lastRun: { at: backups[0]!.createdAt, ok: true, trigger: "schedule", archiveId: backups[0]!.archiveId },
    running: null, keysLeft: 300, keysWanted: 0, usedBytes: backups.reduce((n, x) => n + x.bundleBytes, 0), backups,
  });
  m.get(at("/api/screens/backup-policy"), {
    policy: { policy: "phone", phoneReserveBytes: 32 * GB, issuedAt: 1 },
    cap: { limitBytes: 32 * GB, usedBytes: b.sizeGiB * GB, measuredAt: NOW, overLimit: false, diskBytes: 480 * GB, reservedForPeersBytes: null, apps: [] },
    peer: null,
  });
  await page.evaluate(async (f) => (await import("/views/server-detail.js")).enterServerDetail(f), home);
  await expect(page.locator("#bk-list li").first()).toBeVisible({ timeout: 15_000 });
  await scrollToTop(page, "#backups-card");
}

/** Scroll so `selector` sits just under the sticky app header. */
async function scrollToTop(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((e) => {
    // the sticky header, and on a wide screen the tab bar under it
    const covers = [document.querySelector("header"), document.getElementById("tab-bar")]
      .map((x) => x?.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r && r.top < window.innerHeight / 2);
    const header = Math.max(0, ...covers.map((r) => r.bottom));
    window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - header - 20);
  });
}

// ───────────────────────────── the captures ─────────────────────────────

for (const lang of LANGS) {
  for (const [device, opts] of Object.entries(DEVICES).filter(([d]) => !ONLY_DEVICES || ONLY_DEVICES.includes(d))) {
    test.describe(`${lang} ${device}`, () => {
      test.use({ locale: lang === "en" ? "en-US" : lang, timezoneId: "UTC", ...opts });
      for (const slide of SLIDES.filter((s) => !ONLY || ONLY.includes(s.id))) {
        test(slide.id, async ({ page }) => {
          await page.clock.setFixedTime(NOW);
          await page.emulateMedia({ colorScheme: slide.scheme, reducedMotion: "reduce" });
          await signIn(page);
          const m = await installWorld(page, { waiting: slide.id === "02" });
          await slide.open(page, m);
          await page.waitForTimeout(500);
          if (process.env.STORE_DEBUG) {
            const seen = [...new Set(m.calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`))];
            console.log(`[${lang} ${device} ${slide.id}] ${seen.join("\n  ")}`);
          }
          const out = path.join(ROOT, "store/captures/webapp", lang, device, `${slide.id}.png`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await page.screenshot({ path: out, animations: "disabled", caret: "hide" });
        });
      }
    });
  }
}
