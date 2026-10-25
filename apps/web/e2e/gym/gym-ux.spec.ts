/**
 * The feat/UX round on the webapp with no backend:
 *
 *   - languages (docs/i18n.md): a French or Japanese browser gets Home,
 *     Activity, Services and Settings in its language, with none of those
 *     screens' English sentences left; an English browser stays English;
 *     pt-BR and zh-Hans spot checks;
 *   - named links (docs/named-links.md): the service page's "Your link"
 *     field sets a name with an admin-signed order, writes a sentence for each
 *     `.com` refusal, and clearing brings the random code back;
 *   - the `.com` name dibs notice on Home while the window is open, and the
 *     claim screen it opens;
 *   - the owner UI round: "Add / Restore a server", Activity's no-server card,
 *     compact AI API keys rows, Cloud recovery's (?) help, "Scan a code or
 *     enter a link", and the red Sign out / Remove device / Delete account.
 *
 * The wire shapes are `.com`'s own: links (control-plane serviceRename.ts
 * handleGetAppLinks), voici-name-check / voici-name (control-plane
 * voiciNames.ts), name-dibs/window (nameDibs.ts handleNameDibsWindow).
 */

import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  HOME,
  OFFICE,
  PASSPHRASE,
  USER,
  authorize,
  livePod,
  mock,
  reachHome,
  renderHome,
  sawToast,
  seedSession,
  sensitive,
  serverDetail,
  shot,
  signer,
  watchToasts,
  type Call,
  type Keys,
  type Mock,
} from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const SERVICE_ID = "smoketest--notes";
const CODE = "k3x9qa";
const DAY = 86_400_000;
const box = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;

// ───────────────────────────── sign-in in any language ─────────────────────────────

/** gymKit's helpers wait on English toasts; this waits on the page's structure only. */
async function reachHomeAnyLanguage(page: Page, servers = [HOME]): Promise<Keys> {
  await watchToasts(page);
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
  await page.waitForFunction(() => ((window as unknown as { __gymToasts?: string[] }).__gymToasts ?? []).length > 0, null, { timeout: 30_000 });
  return seedSession(page, { kind: "admin", servers });
}

function world(m: Mock, pods: Record<string, unknown>[]): void {
  m.get("/api/users/smoketest/pods", { pods });
  m.get(box(HOME, "/api/screens/apps-list"), {
    apps: [{ serviceId: SERVICE_ID, slug: "notes", displayLabel: "Notes", name: "Notes", creator: "smoketest", summary: "Shared notes", status: "running", version: "1.0.0", url: `https://notes.${HOME}`, accessMode: "open" }],
  });
  m.get(box(HOME, "/api/screens/server-detail"), serverDetail(HOME));
  m.get(box(HOME, "/api/leads"), { leads: ["notes"] });
  m.get("/api/name-dibs/window", { configured: true, open: false, start: Date.now() - 30 * DAY, end: Date.now() - DAY, scope: ".com", priceUsd: 20 });
}

async function openTab(page: Page, tab: "home" | "apps" | "activity" | "settings"): Promise<void> {
  await page.click(`[data-tab-target="${tab}"]`);
}

/** Visible text of the four main screens, one after another, lower-cased
 *  (headings are upper-cased by CSS, which innerText reflects). */
async function mainScreens(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await renderHome(page);
  await expect(page.locator("#home-add-server")).toBeVisible({ timeout: 10_000 });
  out.home = await page.locator("#view-home").innerText();
  await openTab(page, "apps");
  await expect(page.locator("#services-list-content .fs-app-card").first()).toBeVisible({ timeout: 10_000 });
  out.services = await page.locator("#view-services-list").innerText();
  await openTab(page, "activity");
  await expect(page.locator("#activity-approvals-heading")).toBeVisible({ timeout: 10_000 });
  out.activity = await page.locator("#view-activity").innerText();
  await openTab(page, "settings");
  await expect(page.locator("#view-settings-tab")).toBeVisible();
  out.settings = await page.locator("#view-settings-tab").innerText();
  out.tabs = await page.locator("#tab-bar").innerText();
  for (const k of Object.keys(out)) out[k] = out[k]!.toLowerCase();
  return out;
}

/** English sentences from those screens: none may remain once translated. */
const ENGLISH = [
  "Add / Restore a server",
  "Server approvals",
  "Install progress",
  "Account security",
  "AI API keys",
  "Cloud recovery",
  "Back up account key",
  "Trusted devices",
  "Scan a code or enter a link",
  "Browser sessions",
  "Open secured sessions",
  "Lock the app",
  "Sign out",
  "Remove this device from account",
  "Delete account",
  "DANGER ZONE",
];

async function catalog(page: Page, lang: string): Promise<Record<string, string>> {
  return page.evaluate(async (l) => (await fetch(`/i18n/${l}.json`)).json(), lang);
}

/** Home, Services, Activity and Settings in `lang`: known catalog values shown, none of ENGLISH left. */
async function screensIn(page: Page, lang: string, testInfo: TestInfo): Promise<void> {
  await reachHomeAnyLanguage(page);
  const m = await mock(page);
  world(m, [livePod(HOME)]);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
  const cat = await catalog(page, lang);
  const screens = await mainScreens(page);
  if (process.env.GYM_UX_DUMP) console.log(JSON.stringify(screens, null, 1));
  await shot(page, testInfo, `language-${lang}-settings`);
  const want: Array<[string, string]> = [
    ["home", "Add / Restore a server"],
    ["activity", "Server approvals"],
    ["activity", "Install progress"],
    ["settings", "AI API keys"],
    ["settings", "Cloud recovery"],
    ["settings", "Trusted devices"],
    ["settings", "Scan a code or enter a link"],
    ["settings", "Lock the app"],
    ["settings", "Delete account"],
    ["tabs", "Activity"],
    ["tabs", "Settings"],
  ];
  for (const [screen, en] of want) {
    expect(cat[en], `${lang} catalog has "${en}"`).toBeTruthy();
    expect(screens[screen], `${screen} shows "${cat[en]}"`).toContain(cat[en]!.toLowerCase());
  }
  for (const [screen, text] of Object.entries(screens)) {
    for (const en of ENGLISH) expect(text, `${screen} still says "${en}" in English`).not.toContain(en.toLowerCase());
  }
}

/** Home and Settings spot check in `lang`. */
async function spotCheck(page: Page, lang: string, testInfo: TestInfo): Promise<void> {
  await reachHomeAnyLanguage(page);
  const m = await mock(page);
  world(m, [livePod(HOME)]);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
  const cat = await catalog(page, lang);
  await renderHome(page);
  await expect(page.locator("#home-add-server")).toHaveText(cat["Add / Restore a server"]!, { timeout: 10_000 });
  await openTab(page, "settings");
  await expect(page.locator("#settings-tab-providers")).toHaveText(cat["AI API keys"]!);
  await expect(page.locator("#settings-signout")).toHaveText(cat["Sign out"]!);
  await shot(page, testInfo, `language-${lang}-settings`);
}

test.describe("gym ux language fr", () => {
  test.use({ locale: "fr-FR" });
  test("gym ux language a French browser gets Home, Services, Activity and Settings in French", async ({ page }, testInfo) => {
    await screensIn(page, "fr", testInfo);
  });
});

test.describe("gym ux language ja", () => {
  test.use({ locale: "ja-JP" });
  test("gym ux language a Japanese browser gets Home, Services, Activity and Settings in Japanese", async ({ page }, testInfo) => {
    await screensIn(page, "ja", testInfo);
  });
});

test.describe("gym ux language en", () => {
  test.use({ locale: "en-US" });
  test("gym ux language an English-first browser stays in English", async ({ page }, testInfo) => {
    await reachHomeAnyLanguage(page);
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    expect(await page.evaluate(() => document.documentElement.lang)).not.toMatch(/^(fr|ja|es|de|pt|zh)/);
    const screens = await mainScreens(page);
    expect(screens.home).toContain("add / restore a server");
    expect(screens.activity).toContain("server approvals");
    for (const en of ["AI API keys", "Cloud recovery", "Scan a code or enter a link", "Lock the app", "Sign out", "Delete account"]) {
      expect(screens.settings).toContain(en.toLowerCase());
    }
    await shot(page, testInfo, "language-en-settings");
  });
});

test.describe("gym ux language pt-BR", () => {
  test.use({ locale: "pt-BR" });
  test("gym ux language a Brazilian Portuguese browser gets Home and Settings in pt-BR", async ({ page }, testInfo) => {
    await spotCheck(page, "pt-BR", testInfo);
  });
});

test.describe("gym ux language zh-Hans", () => {
  test.use({ locale: "zh-CN" });
  test("gym ux language a Simplified Chinese browser gets Home and Settings in zh-Hans", async ({ page }, testInfo) => {
    await spotCheck(page, "zh-Hans", testInfo);
  });
});

// ───────────────────────────── named links ─────────────────────────────

interface LinkState {
  name: string | null;
  held: number;
  limit: number;
  changesLeft: number;
  nextChangeAt: number | null;
  releasesAt: number | null;
}
const freshLink = (extra: Partial<LinkState> = {}): LinkState => ({ name: null, held: 0, limit: 5, changesLeft: 3, nextChangeAt: null, releasesAt: null, ...extra });

/** `.com`'s links answer (handleGetAppLinks). */
const linksBody = (link: LinkState) => ({
  serviceId: SERVICE_ID,
  displayLabel: "notes",
  canonicalUrl: "https://notes.smoketest.flagship.services",
  instances: [{ url: `https://notes.${HOME}` }],
  shortUrl: `https://voi.ci/${CODE}`,
  shortCode: CODE,
  link,
  customDomain: null,
  customDomainConfirmed: null,
});

function appDetail() {
  return {
    app: { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", summary: "Shared notes", status: "running", version: "1.0.0", url: `https://notes.${HOME}` },
    manifest: { name: "notes", runtime: { base: "node-24" } },
    dataLayerInstances: [],
    members: [],
    editable: false,
  };
}

async function servicePage(page: Page, link: LinkState): Promise<{ m: Mock; keys: Keys; state: { link: LinkState } }> {
  const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
  const m = await mock(page);
  const state = { link };
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  m.get(box(HOME, `/api/screens/app-detail/${SERVICE_ID}`), appDetail());
  m.get(box(HOME, "/api/screens/apps-list"), { apps: [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }] });
  m.get((u) => u.pathname === `/api/users/smoketest/apps/${SERVICE_ID}/links`, () => ({ json: linksBody(state.link) }));
  m.get("/api/name-dibs/window", { configured: true, open: true, start: Date.now() - DAY, end: Date.now() + 180 * DAY, scope: ".com", priceUsd: 20 });
  await page.evaluate(async (id) => (await import("/views/service-detail.js")).enterServiceDetail(id), SERVICE_ID);
  await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-lf="root"]')).toBeVisible({ timeout: 10_000 });
  return { m, keys, state };
}

/** `.com`'s availability answer per typed name (handleVoiciNameCheck). */
function answerChecks(m: Mock, answers: Record<string, unknown>): void {
  m.get((u) => u.pathname === "/api/users/smoketest/voici-name-check", (c: Call) => {
    const name = c.url.searchParams.get("name") ?? "";
    return { json: answers[name] ?? { status: "available" } };
  });
}

const VOICI: [string, string] = ["/lib/voiciName.js", "canonicalVoiciNameBytes"];

/** Answers a voici-name order signed by this browser with either key (the
 *  admin-root rule itself is pinned by its own test below), else 403. */
function signedOrder(page: Page, keys: Keys, ok: (call: Call) => { json: unknown }) {
  return async (call: Call) => {
    const who = await signer(page, keys, VOICI, call.body?.order, call.body?.signature);
    return who ? ok(call) : { status: 403, json: { error: "invalid signature", code: "not-admin" } };
  };
}

const field = (page: Page) => page.locator('[data-lf="input"]');
const fieldMsg = (page: Page) => page.locator('[data-lf="msg"]');
const fieldButton = (page: Page, label: string) => page.locator('[data-lf="actions"] button', { hasText: label });

async function typeAvailable(page: Page, name: string): Promise<void> {
  await field(page).fill(name);
  await expect(fieldMsg(page)).toHaveText("Available", { timeout: 10_000 });
  await expect(fieldButton(page, "Save")).toBeVisible();
}

test.describe("gym ux named links", () => {
  test("gym ux named links the service page shows Your link and an admin sets a name with a signed order", async ({ page }, testInfo) => {
    const { m, keys, state } = await servicePage(page, freshLink());
    await expect(page.locator('[data-lf="root"] label')).toHaveText("Your link");
    await expect(page.locator(".link-field-prefix")).toHaveText("voi.ci/");
    await expect(field(page)).toHaveValue(CODE);
    await expect(field(page)).not.toHaveAttribute("readonly");
    await expect(page.locator('[data-lf="note"]')).toHaveCount(0);

    answerChecks(m, { admin: { status: "reserved" } });
    // Local checks first, then .com's.
    await field(page).fill("ab");
    await expect(fieldMsg(page)).toHaveText("At least 4 characters");
    await field(page).fill("bad_name");
    await expect(fieldMsg(page)).toHaveText("Letters, numbers and hyphens only");
    await field(page).fill("admin");
    await expect(fieldMsg(page)).toHaveText("Reserved", { timeout: 10_000 });

    m.post(
      `/api/users/smoketest/apps/${SERVICE_ID}/voici-name`,
      signedOrder(page, keys, (c) => {
        state.link = freshLink({ name: c.body.order.name, held: 1, changesLeft: 2, releasesAt: Date.now() + 60 * DAY });
        return { json: { ok: true, link: state.link } };
      }),
    );
    await typeAvailable(page, "halloweenparty");
    await fieldButton(page, "Save").click();
    const sent = await m.waitFor("/voici-name");
    expect(sent.body.order).toMatchObject({ user: "smoketest", serviceId: SERVICE_ID, name: "halloweenparty", op: "set" });
    await expect(fieldMsg(page)).toHaveText("");
    await expect(field(page)).toHaveValue("halloweenparty");
    await expect(fieldButton(page, "Use default")).toBeVisible();
    await shot(page, testInfo, "named-link-set");
  });

  test("gym ux named links an admin device signs the order with the admin root, as .com requires", async ({ page }, testInfo) => {
    const { m, keys } = await servicePage(page, freshLink());
    answerChecks(m, {});
    m.post(
      `/api/users/smoketest/apps/${SERVICE_ID}/voici-name`,
      sensitive(page, keys, VOICI, (b) => ({ arg: b.order, sig: b.signature }), (c) => ({
        json: { ok: true, link: freshLink({ name: c.body.order.name, held: 1, changesLeft: 2, releasesAt: Date.now() + 60 * DAY }) },
      })),
    );
    await typeAvailable(page, "halloweenparty");
    await fieldButton(page, "Save").click();
    const sent = await m.waitFor("/voici-name");
    await shot(page, testInfo, "named-link-admin-root");
    expect(await signer(page, keys, VOICI, sent.body.order, sent.body.signature)).toBe("admin");
    await expect(field(page)).toHaveValue("halloweenparty");
  });

  test("gym ux named links each refusal from .com reads as a sentence", async ({ page }, testInfo) => {
    const { m } = await servicePage(page, freshLink());
    answerChecks(m, {});
    const next = Date.now() + 12 * DAY;
    const refusals: Record<string, { status: number; json: Record<string, unknown> }> = {
      "gym-taken": { status: 409, json: { error: "that name is taken", code: "taken" } },
      "gym-reserved": { status: 409, json: { error: "that name is reserved", code: "reserved" } },
      "halloweenparty": { status: 409, json: { error: "reserved for the owner of its .com", code: "dibs", domain: "halloweenparty.com", until: Date.now() + 180 * DAY } },
      "gym-limit": { status: 429, json: { error: "too many changes for this service", code: "change-limit", nextChangeAt: next } },
      "gym-names": { status: 409, json: { error: "all names in use", code: "name-limit", held: 5, limit: 5 } },
      "gym-today": { status: 429, json: { error: "too many changes today", code: "rate-limited", retryAfterSec: 86_400 } },
      "gym-stopped": { status: 409, json: { error: "none of this account's servers runs this app", code: "app-not-running" } },
    };
    m.post(`/api/users/smoketest/apps/${SERVICE_ID}/voici-name`, (c: Call) => refusals[c.body?.order?.name] ?? { status: 500, json: { error: "gym: unexpected" } });
    const nextText = await page.evaluate(async (t) => (await import("/lib/dateFormat.js")).formatWhen(t), next);
    const expected: Record<string, string> = {
      "gym-taken": "Taken",
      "gym-reserved": "Reserved",
      "halloweenparty": "Reserved for the owner of halloweenparty.com",
      "gym-limit": `Next change ${nextText}`,
      "gym-names": "All 5 names in use",
      "gym-today": "Too many changes today",
    };
    for (const [name, sentence] of Object.entries(expected)) {
      await typeAvailable(page, name);
      await fieldButton(page, "Save").click();
      await expect(fieldMsg(page), name).toHaveText(sentence);
      await expect(fieldMsg(page)).toHaveClass(/lf-bad/);
    }
    // app-not-running: no server of the account has reported the app yet.
    await typeAvailable(page, "gym-stopped");
    await fieldButton(page, "Save").click();
    await expect(fieldMsg(page)).toHaveClass(/lf-bad/);
    await expect(fieldMsg(page)).toHaveText("None of your servers runs this app yet");
    await expect(fieldMsg(page)).not.toContainText("none of this account");
    expect(m.sent("/voici-name").length).toBe(Object.keys(expected).length + 1);
    await expect(field(page)).toHaveValue("gym-stopped");
    await shot(page, testInfo, "named-link-refused");
  });

  test("gym ux named links a .com holder's name offers I own it, and the claim screen opens with it", async ({ page }, testInfo) => {
    const { m } = await servicePage(page, freshLink());
    answerChecks(m, { halloweenparty: { status: "dibs", domain: "halloweenparty.com", until: Date.now() + 180 * DAY } });
    await field(page).fill("halloweenparty");
    await expect(fieldMsg(page)).toHaveText("Reserved for the owner of halloweenparty.com", { timeout: 10_000 });
    await expect(fieldButton(page, "Save")).toHaveCount(0);
    await fieldButton(page, "I own it").click();
    const dlg = page.locator('dialog[aria-label="Claim your .com name"]');
    await expect(dlg).toBeVisible({ timeout: 10_000 });
    await expect(dlg.locator("[data-dibs-name]")).toHaveValue("halloweenparty");
    await shot(page, testInfo, "named-link-dibs");
  });

  test("gym ux named links at the change limit the field says when the next change is", async ({ page }, testInfo) => {
    const next = Date.now() + 9 * DAY;
    await servicePage(page, freshLink({ name: "halloweenparty", held: 1, changesLeft: 0, nextChangeAt: next, releasesAt: Date.now() + 60 * DAY }));
    const nextText = await page.evaluate(async (t) => (await import("/lib/dateFormat.js")).formatWhen(t), next);
    await expect(fieldMsg(page)).toHaveText(`Next change ${nextText}`);
    await expect(page.locator('[data-lf="note"]')).toHaveText("Unused for 60 days, it's released.");
    await shot(page, testInfo, "named-link-change-limit");
  });

  test("gym ux named links clearing a name asks first and brings the random code back", async ({ page }, testInfo) => {
    const { m, keys, state } = await servicePage(page, freshLink({ name: "halloweenparty", held: 1, changesLeft: 2, releasesAt: Date.now() + 60 * DAY }));
    await expect(field(page)).toHaveValue("halloweenparty");
    m.post(
      `/api/users/smoketest/apps/${SERVICE_ID}/voici-name`,
      signedOrder(page, keys, () => {
        state.link = freshLink({ changesLeft: 1 });
        return { json: { ok: true, link: state.link } };
      }),
    );
    await fieldButton(page, "Use default").click();
    await expect(page.locator(".modal-title")).toHaveText("Replace voi.ci/halloweenparty? It stops working now and can't be taken back.");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/voici-name")).toHaveLength(0);
    await expect(field(page)).toHaveValue("halloweenparty");

    await fieldButton(page, "Use default").click();
    await page.click("[data-modal-ok]");
    const sent = await m.waitFor("/voici-name");
    expect(sent.body.order).toMatchObject({ name: "", op: "clear" });
    await expect(field(page)).toHaveValue(CODE);
    await expect(fieldButton(page, "Use default")).toHaveCount(0);
    await shot(page, testInfo, "named-link-cleared");
  });
});

// ───────────────────────────── .com name dibs on Home ─────────────────────────────

test.describe("gym ux dibs", () => {
  test("gym ux dibs Home shows Claim your .com name while the window is open and the claim screen opens", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    const end = Date.UTC(2027, 3, 25);
    m.first("GET", "/api/name-dibs/window", { configured: true, open: true, start: Date.UTC(2026, 9, 25), end, scope: ".com", priceUsd: 20 });
    await renderHome(page);
    const banner = page.locator("#home-dibs-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("Own a .com? Claim the matching name");
    const endText = await page.evaluate(async (t) => (await import("/lib/nameDibs.js")).formatDibsDate(t), end);
    await expect(banner).toContainText(endText);
    await shot(page, testInfo, "dibs-banner");
    await banner.locator("[data-ann-cta]").click();
    const dlg = page.locator('dialog[aria-label="Claim your .com name"]');
    await expect(dlg).toBeVisible({ timeout: 10_000 });
    await expect(dlg.locator('[data-stage="name"]')).toBeVisible();
    await expect(dlg.locator("[data-dibs-name]")).toBeVisible();
  });

  test("gym ux dibs Home shows no dibs notice while the window is closed", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    await renderHome(page);
    await expect(page.locator("#home-add-server")).toBeVisible({ timeout: 10_000 });
    await m.waitFor("/api/name-dibs/window", "GET");
    await expect(page.locator("#home-dibs-banner")).toHaveCount(0);
    await shot(page, testInfo, "dibs-closed");
  });
});

// ───────────────────────────── owner UI round ─────────────────────────────

test.describe("gym ux owner round", () => {
  test("gym ux owner round Home's add button and Activity with no server show the new wording and the Services card", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, []);
    await renderHome(page);
    await expect(page.locator("#home-add-server")).toHaveText("Add / Restore a server", { timeout: 10_000 });

    await openTab(page, "activity");
    const card = page.locator("#activity-no-server [data-no-server]");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".empty-headline")).toHaveText("Add a server first");
    await expect(page.locator("#activity-with-server")).toBeHidden();
    const activityCard = await card.innerHTML();
    await shot(page, testInfo, "activity-no-server");

    await openTab(page, "apps");
    const services = page.locator("#services-list-content [data-no-server]");
    await expect(services).toBeVisible({ timeout: 10_000 });
    expect(await services.innerHTML()).toBe(activityCard);
  });

  test("gym ux owner round AI API keys are compact rows with Make default and a confirmed Delete key", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    const ids = await page.evaluate(async () => {
      const p = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      const umk = getSession().umk;
      const a = await p.addProvider(umk, { provider: "anthropic", label: "anthropic", apiKey: "sk-ant-gym-0123456789abcdef" });
      const b = await p.addProvider(umk, { provider: "openai", label: "work", apiKey: "sk-gym-0123456789abcdef" });
      return [a.id, b.id] as string[];
    });
    await openTab(page, "settings");
    await page.click("#settings-tab-providers");
    await expect(page.locator("#view-settings > h2").first()).toHaveText("AI API keys");
    const rows = page.locator("#providers-list .key-row");
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    const [first, second] = [rows.nth(0), rows.nth(1)];
    await expect(first.locator(".key-row-name")).toHaveText("anthropic");
    await expect(second.locator(".key-row-name")).toHaveText("work · openai");
    await expect(first.locator(".key-row-tag")).toHaveText("Default");
    await expect(second.locator(".key-row-tag")).toHaveCount(0);
    for (const r of [first, second]) await expect(r).not.toContainText("0123456789abcdef");
    await expect(second.locator(".key-row-more")).toBeHidden();
    await shot(page, testInfo, "ai-keys-rows");

    // The ⋯ menu: Make default and Delete key (the key's settings sit with them).
    await second.locator('[data-action="more"]').click();
    await expect(second.locator('[data-action="more"]')).toHaveAttribute("aria-expanded", "true");
    await expect(second.locator(".key-row-more")).toBeVisible();
    await expect(second.locator('[data-action="relay"]')).toBeAttached();
    await expect(second.locator('[data-action="set-active"]')).toHaveText("Make default");
    await expect(second.locator('[data-action="remove"]')).toHaveText("Delete key");
    await second.locator('[data-action="set-active"]').click();
    await expect(page.locator(`#providers-list .key-row:has([aria-controls="key-more-${ids[1]}"]) .key-row-tag`)).toHaveText("Default", { timeout: 10_000 });

    const row = page.locator(`#providers-list .key-row:has([aria-controls="key-more-${ids[0]}"])`);
    await row.locator('[data-action="more"]').click();
    await row.locator('[data-action="remove"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Delete this key?");
    await page.click("[data-modal-cancel]");
    await expect(rows).toHaveCount(2);
    await row.locator('[data-action="remove"]').click();
    await page.click("[data-modal-ok]");
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    await expect(rows.first().locator(".key-row-name")).toHaveText("work · openai");
  });

  test("gym ux owner round Cloud recovery's (?) opens How this works and closes it", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    await openTab(page, "settings");
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#view-recovery")).not.toContainText("Recovery requires both your recovery passphrase");
    await page.click("#recovery-help");
    const help = page.locator("#recovery-help-dialog");
    await expect(help).toBeVisible();
    await expect(help.locator(".modal-title")).toHaveText("How this works");
    await expect(help).toContainText("Recovery requires both your recovery passphrase");
    await shot(page, testInfo, "recovery-help");
    await page.click("#recovery-help-close");
    await expect(help).toHaveCount(0);
    await page.click("#recovery-help");
    await page.keyboard.press("Escape");
    await expect(page.locator("#recovery-help-dialog")).toHaveCount(0);
  });

  test("gym ux owner round Scan a code or enter a link opens a pasted join link and refuses junk", async ({ page }, testInfo) => {
    await page.routeWebSocket(/.*/, () => {});
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    await openTab(page, "settings");
    await expect(page.locator("#settings-tab-join-account")).toHaveText("Scan a code or enter a link");
    await expect(page.locator("#settings-tab-process-url")).toHaveCount(0);
    await page.click("#settings-tab-join-account");
    const dlg = page.locator("dialog:has([data-join-input])");
    await expect(dlg).toBeVisible();

    await dlg.locator("[data-join-input]").fill("hello, not a link");
    await dlg.locator("[data-join-continue]").click();
    await expect(dlg.locator("[data-join-error]")).toHaveText("That isn't a Flagship code or link. Copy the whole link and try again.");
    await shot(page, testInfo, "scan-or-link-refused");

    await dlg.locator("[data-join-input]").fill(`https://flagshipserver.com/join?sid=${"ab".repeat(16)}&pk=${"cd".repeat(32)}`);
    await dlg.locator("[data-join-continue]").click();
    await expect(page.locator("#view-join")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#join-sas")).toBeVisible();
    await expect(page.locator("#join-confirm")).toBeDisabled();
  });

  test("gym ux owner round Sign out, Remove device and Delete account are red and Lock the app is plain", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    await openTab(page, "settings");
    for (const id of ["#settings-signout", "#settings-reset", "#settings-tab-account-delete"]) {
      await expect(page.locator(id)).toHaveClass(/\bdanger(-outline)?\b/);
    }
    await expect(page.locator("#settings-pin-lock")).toHaveText("Lock the app");
    await expect(page.locator("#settings-pin-lock")).not.toHaveClass(/danger/);
    const red = await page.locator("#settings-signout").evaluate((e) => getComputedStyle(e).color);
    const plain = await page.locator("#settings-pin-lock").evaluate((e) => getComputedStyle(e).color);
    expect(red).not.toBe(plain);
    await page.locator("#settings-danger-zone-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "settings-bottom");
  });
});

// ───────────────────────────── app chat requests (N08) ─────────────────────────────

const CHAT_CANON: [string, string] = ["/lib/chatApproval.js", "canonicalChatApproval"];
const SW_GENERIC = () => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "ACCESS_REQUESTS" } }));

type ChatReq = { requestId: string; kind: "incoming" | "outgoing"; claimedSender: { author: string; slug: string }; receiverApp: { author: string; slug: string }; phrase?: string; count: number; at: number };

/** The box's chat screens (chat/approvals.ts): the list, a signed answer that removes the request, and the Always allow revoke. */
function chatBox(m: Mock, page: Page, keys: Keys, state: { requests: ChatReq[]; always: Array<{ receiverApp: { author: string; slug: string }; claimedSender: { author: string; slug: string } }> }): Mock {
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
  m.get(box(HOME, "/api/screens/chat/requests"), () => ({ json: { requests: state.requests, always: state.always } }));
  m.post(
    box(HOME, "/api/screens/chat/answer"),
    sensitive(
      page,
      keys,
      CHAT_CANON,
      (b) => ({ arg: { serverDomain: HOME, requestId: b.requestId, kind: b.kind, decision: b.decision, issuedAt: b.issuedAt }, sig: b.signature }),
      (c) => {
        const r = state.requests.find((q) => q.requestId === c.body.requestId);
        if (!r) return { status: 404, json: { error: "that request is no longer waiting" } };
        state.requests = state.requests.filter((q) => q !== r);
        if (c.body.decision === "always") state.always.push({ receiverApp: r.receiverApp, claimedSender: r.claimedSender });
        return { json: { ok: true } };
      },
    ),
  );
  m.post(box(HOME, "/api/screens/chat/always/revoke"), (c: Call) => {
    state.always = state.always.filter((a) => !(a.receiverApp.author === c.body.author && a.receiverApp.slug === c.body.slug && (!c.body.sender || (a.claimedSender.author === c.body.sender.author && a.claimedSender.slug === c.body.sender.slug))));
    return { json: { ended: 1 } };
  });
  return m;
}

const incoming = (id: string, from: string): ChatReq => ({ requestId: id, kind: "incoming", claimedSender: { author: from, slug: "chess" }, receiverApp: { author: "smoketest", slug: "notes" }, count: 1, at: Date.now() });

test.describe("gym ux chat requests", () => {
  test("gym ux chat requests a request shows in a sheet and under Activity, and Allow and Deny send signed answers", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const state = {
      requests: [
        { ...incoming("r1", "alice"), phrase: "blue fox", count: 3 },
        { requestId: "r2", kind: "outgoing" as const, claimedSender: { author: "smoketest", slug: "notes" }, receiverApp: { author: "bob", slug: "board" }, count: 1, at: Date.now() },
      ],
      always: [] as Array<{ receiverApp: { author: string; slug: string }; claimedSender: { author: string; slug: string } }>,
    };
    const m = chatBox(await mock(page), page, keys, state);
    await page.evaluate(SW_GENERIC);

    // Incoming: the sender is a claim, the phrase and the count are shown; Allow.
    const sheet = page.locator(".modal-overlay", { has: page.locator("[data-chat-sheet]") });
    await expect(sheet.locator("[data-chat-sheet]")).toHaveText("A remote machine claiming to run alice/chess wants to start a chat with your app notes.", { timeout: 10_000 });
    await expect(sheet).toContainText("Flagship can't confirm who runs that machine.");
    await expect(sheet).toContainText("The sender's recognition phrase: blue fox");
    await expect(sheet).toContainText("It asked 3 times.");
    await expect(sheet.locator('[data-choice="always"]')).toHaveText("Always allow");
    await shot(page, testInfo, "chat-request-sheet");
    await sheet.locator('[data-choice="allow"]').click();
    const allow = await m.waitFor("/api/screens/chat/answer");
    expect(allow.body).toMatchObject({ requestId: "r1", kind: "incoming", decision: "allow" });
    expect(await signer(page, keys, CHAT_CANON, { serverDomain: HOME, ...allow.body }, allow.body.signature)).toBe("admin");

    // Outgoing: no Always allow; Deny.
    await expect(page.locator("[data-chat-sheet]")).toHaveText("Your app notes wants to start a chat with bob/board, an app on another owner's server.", { timeout: 10_000 });
    await expect(page.locator('.modal-overlay [data-choice="always"]')).toHaveCount(0);
    await page.locator('.modal-overlay [data-choice="deny"]').click();
    const deny = await m.waitFor("/api/screens/chat/answer", "POST", 2);
    expect(deny.body).toMatchObject({ requestId: "r2", kind: "outgoing", decision: "deny" });
    expect(await signer(page, keys, CHAT_CANON, { serverDomain: HOME, ...deny.body }, deny.body.signature)).toBe("admin");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);

    // A new one arrives on the screens socket: Not now, then Deny it from Activity.
    state.requests.push(incoming("r3", "carol"));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("flagship:screens-event", { detail: { type: "chat-request" } })));
    await expect(page.locator("[data-chat-sheet]")).toContainText("carol/chess", { timeout: 10_000 });
    await page.locator('.modal-overlay [data-choice="later"]').click();
    expect(m.sent("/api/screens/chat/answer")).toHaveLength(2);
    await page.click('[data-tab-target="activity"]');
    const card = page.locator('#activity-chat [data-chat-request="r3"]');
    await expect(card).toContainText("A remote machine claiming to run carol/chess wants to start a chat with your app notes.", { timeout: 10_000 });
    await expect(page.locator("#activity-chat-heading")).toHaveText("App chat requests");
    await shot(page, testInfo, "chat-request-activity");
    await card.locator('[data-chat-answer="deny"]').click();
    const deny3 = await m.waitFor("/api/screens/chat/answer", "POST", 3);
    expect(deny3.body).toMatchObject({ requestId: "r3", decision: "deny" });
    await expect(page.locator("#activity-chat")).toBeHidden({ timeout: 10_000 });
  });

  test("gym ux chat requests Always allow is listed under Activity and Ask me each time ends it", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const state = { requests: [incoming("r1", "alice")], always: [] as Array<{ receiverApp: { author: string; slug: string }; claimedSender: { author: string; slug: string } }> };
    const m = chatBox(await mock(page), page, keys, state);
    await page.evaluate(SW_GENERIC);
    const sheet = page.locator(".modal-overlay", { has: page.locator("[data-chat-sheet]") });
    await expect(sheet).toContainText("Always allow lets a machine claiming to run alice/chess start chats with notes without asking you again.", { timeout: 10_000 });
    await sheet.locator('[data-choice="always"]').click();
    const always = await m.waitFor("/api/screens/chat/answer");
    expect(always.body).toMatchObject({ requestId: "r1", kind: "incoming", decision: "always" });
    expect(await signer(page, keys, CHAT_CANON, { serverDomain: HOME, ...always.body }, always.body.signature)).toBe("admin");

    await page.click('[data-tab-target="activity"]');
    const row = page.locator('#activity-chat [data-chat-always="alice/chess>smoketest/notes"]');
    await expect(row).toHaveText(/A machine claiming to run alice\/chess can start chats with notes without asking you\./, { timeout: 10_000 });
    await expect(page.locator("#activity-chat")).toContainText("No chat requests are waiting.");
    await shot(page, testInfo, "chat-always-listed");
    await row.locator("[data-chat-revoke]").click();
    const revoke = await m.waitFor("/api/screens/chat/always/revoke");
    expect(revoke.body).toEqual({ author: "smoketest", slug: "notes", sender: { author: "alice", slug: "chess" } });
    await expect(page.locator("#activity-chat")).toBeHidden({ timeout: 10_000 });
  });
});

// ───────────────────────────── AI-run consent (N12) ─────────────────────────────

const CONSENT_CANON: [string, string] = ["/lib/aiRepairConsent.js", "canonicalAiRepairConsent"];
const GIT_ID = "0123456789abcdef";
const PROMO_PASS = { provider: "flagship", apiKey: "fa.gym-pass", baseUrl: "https://inference.flagshipserver.com/v1", source: "promo", relay: true };
const ESTIMATE = { provider: "flagship", source: "promo", operation: "adapt", lowTokens: 12_000, highTokens: 72_000, unit: "tokens" };
const onHomePath = (p: string) => (u: URL) => u.host === HOME && u.pathname === p;

/** A not-fit git build reopened from Build sessions, with Flagship Inference as the only key. */
async function gitBuild(page: Page, m: Mock, onAdapt: (c: Call) => unknown): Promise<{ adapt: () => Record<string, unknown> }> {
  let adapt: Record<string, unknown> = { status: "failed", reason: "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy." };
  const credits = { remainingCredits: 1840, weeklyCredits: 500, tokensPerCredit: 1000, remainingTokens: 1_840_000 };
  m.on(undefined, (u: URL) => u.pathname === "/api/free-ai/status", { available: true, ended: false, reason: null, credits })
    .on(undefined, (u: URL) => u.pathname === "/api/free-ai/token", { ok: true, credential: PROMO_PASS, model: "low", expiresAt: Date.now() + 43_200_000, credits })
    .on(undefined, (u: URL) => u.pathname === "/api/inference/models", { models: [{ id: "low", tier: "Low", model: "m", multiplier: 1, label: "Low", default: true }], defaultModel: "low", creditTokens: 1000, inputWeight: 1, outputWeight: 4 })
    .get("/api/users/smoketest/pods", { pods: [livePod(HOME)] })
    .get(onHomePath("/api/llm/sessions"), { sessions: [] })
    .get(onHomePath("/api/build/sessions"), { builds: [{ buildId: GIT_ID, mode: "git", name: "blog", startedAt: Date.now(), open: true }] })
    .post(onHomePath(`/api/build/sessions/${GIT_ID}/adapt`), async (c: Call) => {
      const r = (await onAdapt(c)) as { status?: number; json: unknown } | undefined;
      if (r && (r.status ?? 200) < 300) adapt = { status: "done", fileCount: 3, deployed: true, deployedUrl: `https://blog.${HOME}` };
      return r;
    })
    .get(onHomePath(`/api/build/sessions/${GIT_ID}/journal`), { entries: [] })
    .get(onHomePath(`/api/build/sessions/${GIT_ID}`), () => ({ json: { state: { buildId: GIT_ID, mode: "git", serverFqdn: HOME, createdAt: 1, gitFit: false, name: "blog", adapt }, files: ["a"] } }));
  await page.click('[data-tab-target="apps"]');
  await page.click("#services-list-open-vibe-code");
  await page.click("#build-source-journal-link");
  const row = page.locator(`#build-journal-list .build-session-row[data-build="${GIT_ID}"]`);
  await expect(row).toContainText("blog", { timeout: 10_000 });
  await row.click();
  await expect(page.locator("#build-git-adapt")).toBeVisible({ timeout: 10_000 });
  return { adapt: () => adapt };
}

test.describe("gym ux ai consent", () => {
  test("gym ux ai consent an adapt shows the estimate first and Continue resends it with a signed consent", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    const verify = sensitive(
      page,
      keys,
      CONSENT_CANON,
      (b) => ({ arg: { serverDomain: HOME, buildId: GIT_ID, operation: "adapt", provider: b.consent?.provider, source: b.consent?.source, highTokens: b.consent?.highTokens, issuedAt: b.consent?.issuedAt }, sig: b.consent?.signature }),
      () => ({ status: 202, json: { ok: true, started: true } }),
    );
    await gitBuild(page, m, (c) => (c.body?.consent ? verify(c) : { status: 428, json: { error: "consent-required", code: "ai-consent", estimate: ESTIMATE } }));
    await page.click("#build-git-adapt");
    const consent = page.locator(".modal-overlay", { has: page.locator("[data-ai-consent]") });
    await expect(consent.locator("[data-ai-consent]")).toHaveText("This uses AI that costs money", { timeout: 10_000 });
    await expect(consent.locator("[data-ai-consent-range]")).toHaveText("This run can use up to about 72,000 tokens. The run stops there.");
    await expect(consent.locator("[data-ai-consent-payer]")).toHaveText("Flagship Inference runs it, and it is paid from your free Flagship Inference credits.");
    await shot(page, testInfo, "ai-consent-sheet");
    expect(m.sent(`/api/build/sessions/${GIT_ID}/adapt`)).toHaveLength(1);
    await consent.locator('[data-choice="continue"]').click();
    const second = await m.waitFor(`/api/build/sessions/${GIT_ID}/adapt`, "POST", 2);
    expect(second.body.consent).toMatchObject({ provider: "flagship", source: "promo", highTokens: 72_000 });
    expect(second.body.credential).toMatchObject({ provider: "flagship" });
    expect(
      await signer(page, keys, CONSENT_CANON, { serverDomain: HOME, buildId: GIT_ID, operation: "adapt", provider: "flagship", source: "promo", highTokens: 72_000, issuedAt: second.body.consent.issuedAt }, second.body.consent.signature),
    ).toBe("admin");
    await expect(page.locator("#build-git-verdict")).toContainText("Installed ✓", { timeout: 15_000 });
  });

  test("gym ux ai consent Cancel sends nothing more and offers the adapt again", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    await gitBuild(page, m, () => ({ status: 428, json: { error: "consent-required", code: "ai-consent", estimate: { ...ESTIMATE, provider: "openai", source: "byok" } } }));
    const polls = () => m.sent(`/api/build/sessions/${GIT_ID}`, "GET").filter((c) => c.url.pathname === `/api/build/sessions/${GIT_ID}`).length;
    const before = polls();
    await page.click("#build-git-adapt");
    const consent = page.locator(".modal-overlay", { has: page.locator("[data-ai-consent]") });
    await expect(consent.locator("[data-ai-consent-payer]")).toHaveText("OpenAI runs it with your own API key, so OpenAI bills you for it.", { timeout: 10_000 });
    await consent.locator('[data-choice="cancel"]').click();
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect(page.locator("#build-git-adapt")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-git-verdict .build-git-adapting")).toHaveCount(0);
    await shot(page, testInfo, "ai-consent-cancelled");
    expect(m.sent(`/api/build/sessions/${GIT_ID}/adapt`)).toHaveLength(1);
    // Nothing was started, so nothing is followed.
    await page.waitForTimeout(3_000);
    expect(polls()).toBe(before);
  });
});

// ───────────────────────────── first contact ─────────────────────────────
//
// docs/first-contact.md: the device that made the recipe checks the box's enrollment proof at the
// first blessing, shows the code it computes from the key above Approve, pins the key, and signs the
// app-name certificate grant in the same moment; a key that isn't the pin is refused.

const GRANT_CANON: [string, string] = ["/lib/serverWildcardGrant.js", "canonicalServerWildcardGrant"];
const SERIAL = "AC-GYM1-0001";

interface BoxRequest { stk: string; request: Record<string, unknown>; code: string }

/** A box key made in the page, and its signed entitlement request (with `proof` when asked). */
async function boxRequest(page: Page, fqdn: string, opts: { purpose?: string; proof?: "good" | "bad" | "none"; secretHex?: string } = {}): Promise<BoxRequest> {
  return page.evaluate(async ({ fqdn, purpose, proof, secretHex, serial }) => {
    const enr = await import("/lib/enrollment.js");
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const stk = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const issuedAt = Date.now();
    const canonical = new TextEncoder().encode(["flagship/secret-request/v1", fqdn, stk, purpose, nonce, issuedAt].join("|"));
    const sig = hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, canonical)));
    const deviceInfo: Record<string, string> = { os: "Debian" };
    if (proof === "good") deviceInfo.enrollmentProof = (await enr.enrollmentProofHex(secretHex, { serverDomain: fqdn, stkPubHex: stk, authCodeSerial: serial }))!;
    if (proof === "bad") deviceInfo.enrollmentProof = (await enr.enrollmentProofHex(secretHex, { serverDomain: fqdn, stkPubHex: stk, authCodeSerial: "AC-NOT-MINE" }))!;
    return {
      stk,
      code: (await enr.serverCode(stk))!,
      request: { serverDomain: fqdn, stkPub: stk, purpose, requestNonceHex: nonce, requestSignature: sig, issuedAt, deviceInfo },
    };
  }, { fqdn, purpose: opts.purpose ?? "entitlement", proof: opts.proof ?? "none", secretHex: opts.secretHex ?? "77".repeat(32), serial: SERIAL });
}

/** This device made the recipe for `fqdn`: it keeps the one-time secret. */
async function keepSecret(page: Page, fqdn: string, secretHex = "77".repeat(32)): Promise<void> {
  await page.evaluate(async ({ fqdn, secretHex, serial }) => {
    const sp = await import("/lib/serverPins.js");
    const { getSession } = await import("/lib/state.js");
    await sp.keepEnrollmentSecret(getSession().umk, fqdn, { secretHex, serial });
  }, { fqdn, secretHex, serial: SERIAL });
}

const pinOf = (page: Page, fqdn: string) => page.evaluate(async (d) => (await import("/lib/serverPins.js")).pinnedStk(d), fqdn);
const secretOf = (page: Page, fqdn: string) =>
  page.evaluate(async (d) => {
    const { getSession } = await import("/lib/state.js");
    return (await import("/lib/serverPins.js")).loadEnrollmentSecret(getSession().umk, d);
  }, fqdn);

/** `/pods` (a server that has never come online) and `.com`'s pending requests for those boxes. */
function approvals(m: Mock, reqs: BoxRequest[], pods?: Record<string, unknown>[]): void {
  m.get("/api/users/smoketest/pods", {
    pods: pods ?? reqs.map((r) => ({
      serverDomain: r.request.serverDomain,
      identityPubKey: r.stk,
      registeredAt: Date.now() - 600_000,
      pendingRequests: [{ id: r.request.requestNonceHex, type: r.request.purpose, issuedAt: r.request.issuedAt, expiresAt: Number(r.request.issuedAt) + 600_000 }],
    })),
  });
  m.post("/api/secret-requests", { requests: reqs.map((r) => r.request) });
  m.post("/api/boot/response", { ok: true });
}

async function openApprovals(page: Page): Promise<void> {
  await page.evaluate(async () => (await import("/views/boot-approval.js")).enterBootApproval());
  await expect(page.locator("#view-activity")).toBeVisible({ timeout: 10_000 });
}

const requestCard = (page: Page, r: BoxRequest) => page.locator(`[data-boot-request-id="${r.request.serverDomain}#${r.request.requestNonceHex}"]`);
const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

test.describe("gym ux first contact", () => {
  test("gym ux first contact a good proof shows the code above Approve, pins the key and sends the app-name grant", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    await keepSecret(page, HOME);
    const r = await boxRequest(page, HOME, { proof: "good" });
    const m = await mock(page);
    approvals(m, [r]);
    m.post(box(HOME, "/api/screens/server-wildcard-grant"), { ok: true, restarting: true });
    await openApprovals(page);
    const card = requestCard(page, r);
    await expect(card.locator("[data-server-code]")).toHaveText(`If your machine has a monitor, it is showing this code: ${spaced(r.code)}`, { timeout: 10_000 });
    // The code box sits directly above Approve.
    expect(await card.evaluate((el) => el.querySelector("[data-server-code]")?.nextElementSibling?.hasAttribute("data-approve-id"))).toBe(true);
    await shot(page, testInfo, "first-contact-code-box");
    expect(await pinOf(page, HOME)).toBeNull();
    await card.locator("[data-approve-id]").click();
    const reply = await m.waitFor("/api/boot/response");
    const carrier = JSON.parse(Buffer.from(reply.body.response.sealed, "hex").toString("utf8"));
    expect(carrier.rootEntitlement).toMatchObject({ podPubKey: r.stk, podCanonical: HOME });
    expect(await pinOf(page, HOME)).toBe(r.stk);
    expect(await secretOf(page, HOME)).toBeNull();
    const grant = await m.waitFor("/api/screens/server-wildcard-grant");
    expect(await signer(page, keys, GRANT_CANON, { username: USER, serverDomain: HOME, stkPubHex: r.stk, issuedAt: grant.body.issuedAt }, grant.body.signature)).toBe("admin");
  });

  test("gym ux first contact a wrong or missing proof is refused and nothing is pinned", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    await keepSecret(page, HOME);
    await keepSecret(page, OFFICE);
    const bad = await boxRequest(page, HOME, { proof: "bad" });
    const none = await boxRequest(page, OFFICE, { proof: "none" });
    const m = await mock(page);
    approvals(m, [bad, none]);
    await openApprovals(page);
    for (const r of [bad, none]) {
      const card = requestCard(page, r);
      await expect(card.locator('[data-first-contact-refusal="not-your-recipe"]')).toHaveText("This server was not built from your recipe. Do not approve it.", { timeout: 10_000 });
      await expect(card.locator("[data-approve-id]")).toHaveCount(0);
      await expect(card.locator("[data-server-code]")).toHaveCount(0);
    }
    await shot(page, testInfo, "first-contact-not-your-recipe");
    expect(await pinOf(page, HOME)).toBeNull();
    expect(await pinOf(page, OFFICE)).toBeNull();
    expect(m.sent("/api/boot/response")).toHaveLength(0);
  });

  test("gym ux first contact a request under a key other than the pin is refused, and Home says so", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    await page.evaluate(async (d) => (await import("/lib/serverPins.js")).pinServerKey(d, "11".repeat(32)), HOME);
    const r = await boxRequest(page, HOME, { purpose: "unlock-key" });
    const m = await mock(page);
    approvals(m, [r]);
    m.get(box(HOME, "/api/screens/apps-list"), { apps: [] });
    await openApprovals(page);
    const card = requestCard(page, r);
    await expect(card.locator('[data-first-contact-refusal="key-changed"]')).toHaveText("This server's key changed. If you did not rebuild it, do not approve anything for it.", { timeout: 10_000 });
    await expect(card.locator("[data-approve-id]")).toHaveCount(0);
    await shot(page, testInfo, "first-contact-key-changed");
    await page.click('[data-tab-target="home"]');
    await renderHome(page);
    await expect(page.locator('#servers-list [data-first-contact-refusal="key-changed"]')).toHaveText("This server's key changed. If you did not rebuild it, do not approve anything for it.", { timeout: 10_000 });
    expect(await pinOf(page, HOME)).toBe("11".repeat(32));
    expect(m.sent("/api/boot/response")).toHaveLength(0);
  });

  test("gym ux first contact a device without the recipe's secret pins on first sight with the code box", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const r = await boxRequest(page, HOME, { proof: "none" });
    const m = await mock(page);
    approvals(m, [r]);
    m.post(box(HOME, "/api/screens/server-wildcard-grant"), { ok: true, restarting: true });
    await openApprovals(page);
    const card = requestCard(page, r);
    await expect(card.locator("[data-server-code]")).toHaveText(`If your machine has a monitor, it is showing this code: ${spaced(r.code)}`, { timeout: 10_000 });
    await shot(page, testInfo, "first-contact-first-sight");
    await card.locator("[data-approve-id]").click();
    await m.waitFor("/api/boot/response");
    expect(await pinOf(page, HOME)).toBe(r.stk);
    const grant = await m.waitFor("/api/screens/server-wildcard-grant");
    expect(await signer(page, keys, GRANT_CANON, { username: USER, serverDomain: HOME, stkPubHex: r.stk, issuedAt: grant.body.issuedAt }, grant.body.signature)).toBe("admin");
  });

  test("gym ux first contact the server page signs the app-name grant silently when the server has none", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const stk = "11".repeat(32);
    await page.evaluate(async ({ d, stk }) => (await import("/lib/serverPins.js")).pinServerKey(d, stk), { d: HOME, stk });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    m.get(box(HOME, "/api/screens/server-wildcard-grant"), { granted: false });
    m.post(box(HOME, "/api/screens/server-wildcard-grant"), { ok: true, restarting: true });
    await page.evaluate(async (fqdn) => (await import("/views/server-detail.js")).enterServerDetail(fqdn), HOME);
    const grant = await m.waitFor("/api/screens/server-wildcard-grant");
    expect(await signer(page, keys, GRANT_CANON, { username: USER, serverDomain: HOME, stkPubHex: stk, issuedAt: grant.body.issuedAt }, grant.body.signature)).toBe("admin");
    await expect(page.locator("#server-key-card")).toHaveCount(0);
    await shot(page, testInfo, "first-contact-silent-grant");
    expect(m.sent("/api/screens/server-wildcard-grant")).toHaveLength(1);
  });
});

// ───────────────────────────── passkey recovery (SEC-REPAIR-001) ─────────────────────────────
//
// The recovery window (recovery.<apex>) asks for the passphrase, then `.com`'s challenge, then ONE
// passkey sheet that gives the PRF and signs the challenge, then the fetch carrying that signature.
// It runs here on its real origin with a virtual WebAuthn authenticator (PRF on); its messages to the
// webapp are read from a stand-in opener. The webapp's own screens are driven with a stand-in window.

const RECOVERY_HOST = "recovery.flagshipserver.com";
const RECOVERY_DIR = fileURLToPath(new URL("../../public/recovery/", import.meta.url));
const RECOVERY_USER = "gymrec";
const RECOVERY_PASS = "a whole sentence I will remember";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const corsJson = (status: number, body: unknown) => ({ status, raw: JSON.stringify(body), contentType: "application/json", headers: CORS });
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

type Posted = { type: string; [k: string]: any };

/** The recovery page's own files, served on its origin; `.com` answers with CORS like the Worker. */
async function recoveryPage(page: Page, m: Mock): Promise<void> {
  m.on("OPTIONS", () => true, () => ({ status: 204, raw: "", contentType: "text/plain", headers: CORS }));
  m.get((u: URL) => u.host === RECOVERY_HOST, (c: Call) => {
    const rel = c.url.pathname === "/" ? "index.html" : c.url.pathname.slice(1);
    const file = RECOVERY_DIR + rel;
    if (!existsSync(file)) return { status: 404, raw: "", contentType: "text/plain" };
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ?? "application/octet-stream";
    return { raw: readFileSync(file), contentType: type };
  });
  // The page talks to its opener (the webapp); here the opener records what it is sent.
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: unknown[]; opener: unknown };
    w.__posted = [];
    w.opener = { closed: false, postMessage: (msg: unknown) => w.__posted.push(msg) };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
}

async function posted(page: Page, type: string, count = 1): Promise<Posted> {
  await page.waitForFunction(({ type, count }) => ((window as unknown as { __posted: Posted[] }).__posted ?? []).filter((x) => x.type === type || x.type === "flagship-recovery-error").length >= count, { type, count }, { timeout: 60_000 });
  const all = await page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
  const err = all.find((x) => x.type === "flagship-recovery-error");
  if (err) throw new Error(`recovery window error: ${err.reason}`);
  return all.filter((x) => x.type === type)[count - 1]!;
}

/** Enrol through the recovery window: the webapp's payload, the passphrase twice, one passkey. */
async function enrolInWindow(page: Page, umk: number[]): Promise<Posted> {
  await page.goto(`https://${RECOVERY_HOST}/#enroll`);
  await expect(page.locator("#view-enroll")).toBeVisible();
  await page.evaluate(
    ({ umk, user }) => window.dispatchEvent(new MessageEvent("message", { origin: "https://webapp.flagshipserver.com", data: { type: "flagship-recovery-enroll-payload", umk, username: user } })),
    { umk, user: RECOVERY_USER },
  );
  await page.fill("#enroll-passphrase", RECOVERY_PASS);
  await page.fill("#enroll-passphrase-2", RECOVERY_PASS);
  await page.click("#enroll-go");
  return posted(page, "flagship-recovery-enroll-result");
}

/** `.com`'s side of a recovery over the record `held` (credential, ciphertext, salt hash). */
function recoveryCom(m: Mock, held: { credentialIdHex: string; wrappedUmkB64: string; prfSaltHashHex: string }, opts: { passkeyRequired: boolean; challenge: string | null; passkeyLegacy: boolean }) {
  m.first("GET", (u: URL) => u.pathname === `/api/recovery/by-username/${RECOVERY_USER}`, () => corsJson(200, { credentialId: held.credentialIdHex, hasFetchTokenGate: true, passkeyRequired: opts.passkeyRequired, legacy: true }));
  m.first("POST", (u: URL) => u.pathname === `/api/recovery/by-username/${RECOVERY_USER}/challenge`, () =>
    opts.challenge ? corsJson(200, { challenge: opts.challenge, expiresAt: Date.now() + 300_000 }) : corsJson(503, { error: "passkey recovery is not configured", code: "passkey-unavailable" }),
  );
  m.first("POST", (u: URL) => u.pathname === `/api/recovery/by-username/${RECOVERY_USER}/fetch`, () =>
    corsJson(200, {
      username: RECOVERY_USER,
      credentialId: held.credentialIdHex,
      wrappedUmk: held.wrappedUmkB64,
      prfSaltHash: held.prfSaltHashHex,
      legacy: true,
      ...(opts.passkeyLegacy ? { passkeyLegacy: true } : { passkeyChecked: true }),
    }),
  );
}

async function recoverInWindow(page: Page): Promise<void> {
  await page.goto(`https://${RECOVERY_HOST}/?t=${Date.now()}#recover`);
  await expect(page.locator("#view-recover")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __posted: unknown[] }).__posted = []));
  await page.fill("#recover-username", RECOVERY_USER);
  await page.fill("#recover-passphrase", RECOVERY_PASS);
  await page.click("#recover-go");
}

const UMK = Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff);

test.describe("gym ux passkey recovery", () => {
  test("gym ux passkey recovery the recovery window signs .com's challenge in the one passkey sheet and the fetch carries it", async ({ page }, testInfo) => {
    const m = await mock(page);
    await recoveryPage(page, m);
    const enrolled = await enrolInWindow(page, UMK);
    expect(enrolled.passkeyAttestationObject).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(enrolled.credentialIdHex).toMatch(/^[0-9a-f]{16,}$/);

    const challenge = b64url(Uint8Array.from({ length: 48 }, (_, i) => (i * 29 + 3) & 0xff));
    recoveryCom(m, enrolled as never, { passkeyRequired: true, challenge, passkeyLegacy: false });
    await recoverInWindow(page);
    const result = await posted(page, "flagship-recovery-recover-result");
    expect(result.umk).toEqual(UMK);
    expect(result.passkeyLegacy).toBeUndefined();
    await shot(page, testInfo, "recovery-window-done");

    const order = ["GET", "POST", "POST"].map((method, i) => m.calls.findIndex((c) => c.method === method && c.url.pathname === [`/api/recovery/by-username/${RECOVERY_USER}`, `/api/recovery/by-username/${RECOVERY_USER}/challenge`, `/api/recovery/by-username/${RECOVERY_USER}/fetch`][i]));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const fetch = m.last(`/api/recovery/by-username/${RECOVERY_USER}/fetch`)!;
    expect(fetch.body.passkey.challenge).toBe(challenge);
    expect(Buffer.from(fetch.body.passkey.assertion.credentialId, "base64url").toString("hex")).toBe(enrolled.credentialIdHex);
    const client = JSON.parse(Buffer.from(fetch.body.passkey.assertion.clientDataJSON, "base64url").toString("utf8"));
    expect(client).toMatchObject({ type: "webauthn.get", challenge, origin: `https://${RECOVERY_HOST}` });
    expect(fetch.body.fetchToken).toMatch(/^[0-9a-f]{64}$/);
  });

  test("gym ux passkey recovery a record from before offers Update once; Update sends a new passkey, Not now is remembered", async ({ page }, testInfo) => {
    const m = await mock(page);
    await recoveryPage(page, m);
    const enrolled = await enrolInWindow(page, UMK);

    // A record from before: `.com` issues no challenge it can check, the fetch carries no passkey.
    recoveryCom(m, enrolled as never, { passkeyRequired: false, challenge: null, passkeyLegacy: true });
    await recoverInWindow(page);
    const panel = page.locator("#view-recover-update");
    await expect(panel.locator("#recover-update-title")).toHaveText("Update your account recovery", { timeout: 60_000 });
    await expect(panel).toContainText("Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy.");
    await shot(page, testInfo, "recovery-window-update");
    expect(m.last(`/api/recovery/by-username/${RECOVERY_USER}/fetch`)!.body.passkey).toBeUndefined();
    await page.click("#recover-update-go");
    const updated = await posted(page, "flagship-recovery-recover-result");
    expect(updated.umk).toEqual(UMK);
    expect(updated.passkeyLegacy).toBe(true);
    expect(updated.update.passkeyAttestationObject).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(updated.update.prfSaltHashHex).toBe(enrolled.prfSaltHashHex);
    expect(updated.update.fetchTokenHashHex).toBe(enrolled.fetchTokenHashHex);

    // The new passkey unwraps the re-wrapped key; Not now is remembered on this device.
    recoveryCom(m, updated.update, { passkeyRequired: false, challenge: null, passkeyLegacy: true });
    await recoverInWindow(page);
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await page.click("#recover-update-later");
    const declined = await posted(page, "flagship-recovery-recover-result");
    expect(declined).toMatchObject({ updateDeclined: true, passkeyLegacy: true });
    expect(declined.update).toBeUndefined();

    await recoverInWindow(page);
    const quiet = await posted(page, "flagship-recovery-recover-result");
    expect(quiet.updateDeclined).toBeUndefined();
    expect(quiet.update).toBeUndefined();
    expect(quiet.umk).toEqual(UMK);
  });
});

// ───────────── the webapp's side: one-time update prompt, enrolment and wipe & restart ─────────────

/** A stand-in recovery window: answers the webapp's popup protocol with `answer(mode)`. */
async function standInRecoveryWindow(page: Page, answers: Record<string, Record<string, unknown>>): Promise<void> {
  await page.evaluate((answers) => {
    const w = window as unknown as { __opened: string[]; open: (u: string) => unknown };
    w.__opened = [];
    w.open = (url: string) => {
      w.__opened.push(String(url));
      const mode = String(url).split("#")[1] ?? "";
      // The webapp's recovery origin is recovery.<its control apex> (here, of the gym's own host).
      const origin = String(url).split("#")[0]!.replace(/\/+$/, "");
      const fire = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { origin, data }));
      let ready = false;
      return {
        closed: false,
        close() {
          this.closed = true;
        },
        postMessage(msg: { type: string }) {
          if (msg.type === "flagship-recovery-hello" && !ready) {
            ready = true;
            setTimeout(() => fire({ type: "flagship-recovery-ready", mode }), 0);
            if (mode === "recover") setTimeout(() => fire(answers.recover), 10);
          }
          if (msg.type === "flagship-recovery-enroll-payload") setTimeout(() => fire(answers.enroll), 0);
        },
      };
    };
  }, answers);
}

const ATT_STANDIN = b64url(Uint8Array.from({ length: 96 }, (_, i) => (i * 5 + 1) & 0xff));
const enrollAnswer = (cred = "c0ffee00".repeat(4)) => ({
  type: "flagship-recovery-enroll-result",
  credentialIdHex: cred,
  wrappedUmkB64: Buffer.from(Uint8Array.from({ length: 60 }, (_, i) => i)).toString("base64"),
  fetchTokenHashHex: "ab".repeat(32),
  prfSaltHashHex: "cd".repeat(32),
  passkeyAttestationObject: ATT_STANDIN,
});

test.describe("gym ux recovery update", () => {
  test("gym ux recovery update a record from before is asked about once; Not now is remembered and Settings keeps Update", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    m.get("/api/recovery/by-username/smoketest", { credentialId: "aa".repeat(16), hasFetchTokenGate: true, passkeyRequired: false, legacy: true });
    // The first Home of the session with a server asks.
    await page.click('[data-tab-target="settings"]');
    await page.click('[data-tab-target="home"]');
    const prompt = page.locator(".modal-overlay", { hasText: "Update your account recovery" });
    await expect(prompt.locator(".modal-message")).toHaveText(
      "Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once.",
      { timeout: 20_000 },
    );
    await shot(page, testInfo, "recovery-update-prompt");
    await prompt.locator('[data-modal-choice="later"]').click();
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("flagship.recoveryUpdateAsked.smoketest"))).toBe("1");
    expect(m.sent("/api/recovery", "POST").filter((c) => c.url.pathname === "/api/recovery")).toHaveLength(0);

    // Asked once: another Home shows nothing; Settings keeps a quiet Update row.
    await page.click('[data-tab-target="settings"]');
    await page.click('[data-tab-target="home"]');
    await page.waitForTimeout(1_500);
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await page.click('[data-tab-target="settings"]');
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#recovery-cloud-update")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#recovery-cloud-update")).toHaveText("Update account recovery");
    await shot(page, testInfo, "recovery-update-row");
  });

  test("gym ux recovery update Update re-enrols and the record carries the passkey's attestation", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    let legacy = true;
    m.get("/api/recovery/by-username/smoketest", () => ({ json: { credentialId: "aa".repeat(16), hasFetchTokenGate: true, passkeyRequired: !legacy, legacy } }));
    m.get("/api/username/smoketest", { username: USER, irkPub: keys.irkPubHex, adminRootPub: keys.adminPubHex });
    m.post((u: URL) => u.pathname === "/api/recovery", () => {
      legacy = false;
      return { json: { ok: true, generation: 1, passkeyChecked: true } };
    });
    await standInRecoveryWindow(page, { enroll: enrollAnswer() });
    await page.click('[data-tab-target="settings"]');
    await page.click("#settings-tab-recovery");
    await expect(page.locator("#recovery-cloud-update")).toBeVisible({ timeout: 10_000 });
    await page.click("#recovery-cloud-update");
    const up = await m.waitFor((u: URL) => u.pathname === "/api/recovery");
    expect(up.body.passkeyAttestationObject).toBe(ATT_STANDIN);
    expect(up.body.claim).toMatchObject({ credentialIdHex: "c0ffee00".repeat(4), priorDigestHex: "legacy", irkPubHex: keys.irkPubHex });
    expect(JSON.stringify(up.body.claim)).not.toContain(ATT_STANDIN);
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0]!).toMatch(/^https?:\/\/recovery\./);
    expect(opened[0]!.endsWith("/#enroll")).toBe(true);
    await sawToast(page, "Account recovery updated.");
    await expect(page.locator("#recovery-cloud-update")).toBeHidden({ timeout: 10_000 });
    await shot(page, testInfo, "recovery-updated");
  });

  test("gym ux recovery update wipe and restart sends the new passkey's attestation", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    world(m, [livePod(HOME)]);
    m.get(`/api/accounts/${"0f1e2d3c4b5a69788796a5b4c3d2e1f0"}/directory`, { devices: [], selfProfiles: [], managedProfiles: [], grants: [] });
    m.post("/api/users/smoketest/wipe-restart", { ok: true, auditSeq: 7, newIrkPub: "cc".repeat(32), revokedGrantIds: [] });
    await standInRecoveryWindow(page, { enroll: enrollAnswer("beef0000".repeat(4)) });
    await page.click('[data-tab-target="settings"]');
    await page.click("#settings-tab-trusted-devices");
    await page.click("#wipe-restart-btn");
    await page.locator("dialog.ceremony-dialog [data-primary]").click();
    await page.fill(".modal-input", "a brand new browser passphrase");
    await page.click("[data-modal-ok]");
    const wipe = await m.waitFor("/api/users/smoketest/wipe-restart");
    expect(wipe.body.newPasskeyAttestationObject).toBe(ATT_STANDIN);
    expect(wipe.body.request).toMatchObject({ username: USER, oldIrkPub: keys.irkPubHex, newCredentialId: "beef0000".repeat(4) });
    await shot(page, testInfo, "wipe-restart-attestation");
  });
});

// ───────────────────────────── browser access requests (SEC-BROWSER-002) ─────────────────────────────

const BROWSER_CANON: [string, string] = ["/lib/browserGrant.js", "canonicalBrowserGrantAnswer"];
type GrantAsk = { requestId: string; serviceId: string; capabilities: string[]; origins: string[]; localNetwork: null | { kind: string; hosts?: string[] }; duration: "once" | "session" | "service"; explanation: string; at: number; meaning: string[] };
const grantAsk = (id: string, extra: Partial<GrantAsk> = {}): GrantAsk => ({
  requestId: id,
  serviceId: SERVICE_ID,
  capabilities: ["navigate", "read-dom"],
  origins: ["*.example.com", "shop.example.org"],
  localNetwork: { kind: "exact", hosts: ["printer.local"] },
  duration: "session",
  explanation: "To print your receipts",
  at: Date.now(),
  meaning: ["BOX ENGLISH NEVER SHOWN"],
  ...extra,
});

/** The box's owner routes for browser grants (browser/grantRequests.ts): the list, and answers that remove the ask. */
function browserBox(m: Mock, page: Page, keys: Keys, state: { requests: GrantAsk[] }): Mock {
  m.get(box(HOME, "/api/browser/owner/grant-requests"), () => ({ json: { requests: state.requests } }));
  m.post(box(HOME, "/api/browser/owner/grant-requests/answer"), async (c: Call) => {
    const r = state.requests.find((q) => q.requestId === c.body.requestId);
    if (!r) return { status: 404, json: { error: "that request is no longer waiting" } };
    if (c.body.decision === "allow") {
      const arg = { serverDomain: HOME, requestId: r.requestId, serviceId: r.serviceId, decision: "allow", duration: r.duration, capabilities: r.capabilities, origins: r.origins, localNetwork: r.localNetwork, issuedAt: c.body.issuedAt };
      if (!(await authorize(page, keys, BROWSER_CANON, arg, c.body.signature))) return { status: 403, json: { error: "that answer was not signed by the owner" } };
    }
    state.requests = state.requests.filter((q) => q !== r);
    return { json: { ok: true } };
  });
  return m;
}

test.describe("gym ux browser grants", () => {
  test("gym ux browser grants an ask shows in a sheet and under Activity; Allow signs the ask's duration and Deny is unsigned", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const state = { requests: [grantAsk("11111111-1111-4111-8111-111111111111"), grantAsk("22222222-2222-4222-8222-222222222222", { duration: "once", localNetwork: { kind: "whole-lan" }, origins: [], explanation: "" })] };
    const m = browserBox(await mock(page), page, keys, state);
    world(m, [livePod(HOME)]);
    await page.evaluate(SW_GENERIC);

    const sheet = page.locator(".modal-overlay", { has: page.locator("[data-browser-grant-sheet]") });
    await expect(sheet.locator("[data-browser-grant-sheet]")).toHaveText("Browser access request", { timeout: 10_000 });
    await expect(sheet.locator("[data-grant-title]")).toHaveText("notes wants to use this server's browser.");
    await expect(sheet.locator("[data-grant-sites]")).toContainText("*.example.com and every address under it");
    await expect(sheet.locator("[data-grant-sites]")).toContainText("shop.example.org");
    await expect(sheet.locator("[data-grant-lan]")).toHaveText("These devices on your network: printer.local");
    await expect(sheet.locator("[data-grant-caps]")).toContainText("Open pages");
    await expect(sheet.locator("[data-grant-caps]")).toContainText("Read page content");
    await expect(sheet.locator("[data-grant-duration]")).toHaveText("Until this browser session ends");
    await expect(sheet.locator("[data-grant-explanation]")).toHaveText("The app says: “To print your receipts”");
    await expect(sheet).toContainText("If you deny, the app has to wait before asking again.");
    await expect(sheet).not.toContainText("BOX ENGLISH");
    await expect(sheet.locator('[data-choice="allow"]')).toHaveText("Allow for this session");
    await shot(page, testInfo, "browser-grant-sheet");
    await sheet.locator('[data-choice="allow"]').click();
    const allow = await m.waitFor("/api/browser/owner/grant-requests/answer");
    expect(allow.body).toMatchObject({ requestId: "11111111-1111-4111-8111-111111111111", decision: "allow" });
    const r1 = grantAsk("11111111-1111-4111-8111-111111111111");
    expect(await signer(page, keys, BROWSER_CANON, { serverDomain: HOME, requestId: r1.requestId, serviceId: SERVICE_ID, decision: "allow", duration: "session", capabilities: r1.capabilities, origins: r1.origins, localNetwork: r1.localNetwork, issuedAt: allow.body.issuedAt }, allow.body.signature)).toBe("admin");

    // A one-visit ask for the whole local network: Allow once is offered; Not now, then Deny it from Activity.
    await expect(page.locator("[data-grant-lan]")).toHaveText("Every device on your local network", { timeout: 10_000 });
    await expect(page.locator('.modal-overlay [data-choice="allow"]')).toHaveText("Allow once");
    await page.locator('.modal-overlay [data-choice="later"]').click();
    await page.click('[data-tab-target="activity"]');
    const card = page.locator('#activity-browser [data-browser-request="22222222-2222-4222-8222-222222222222"]');
    await expect(card).toContainText("notes wants to use this server's browser.", { timeout: 10_000 });
    await expect(page.locator("#activity-browser-heading")).toHaveText("Browser access requests");
    await shot(page, testInfo, "browser-grant-activity");
    await card.locator('[data-browser-answer="deny"]').click();
    const deny = await m.waitFor("/api/browser/owner/grant-requests/answer", "POST", 2);
    expect(deny.body).toMatchObject({ requestId: "22222222-2222-4222-8222-222222222222", decision: "deny" });
    expect(deny.body.signature).toBeUndefined();
    await expect(page.locator("#activity-browser")).toBeHidden({ timeout: 10_000 });
  });

  test("gym ux browser grants the app's page lists what the manifest grants and answers a waiting ask", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    await page.evaluate(async () => (await import("/lib/pushSetting.js")).setPushNotificationsEnabled?.(false));
    const state = { requests: [grantAsk("33333333-3333-4333-8333-333333333333", { duration: "service", localNetwork: null, origins: ["docs.example.com"] })] };
    const m = browserBox(await mock(page), page, keys, state);
    world(m, [livePod(HOME)]);
    m.get(box(HOME, `/api/screens/app-detail/${SERVICE_ID}`), {
      app: { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` },
      manifest: { name: "notes", browser: { domains: ["example.com"] } },
      dataLayerInstances: [],
      members: [],
    });
    await page.evaluate(async (id) => (await import("/views/service-detail.js")).enterServiceDetail(id), SERVICE_ID);
    const section = page.locator("#sd-browser-access");
    await expect(section.locator("[data-browser-manifest]")).toContainText("example.com", { timeout: 10_000 });
    await expect(section.locator("[data-browser-manifest]")).toContainText("Approved when you installed it");
    const ask = section.locator('[data-browser-request="33333333-3333-4333-8333-333333333333"]');
    await expect(ask).toContainText("docs.example.com");
    await expect(ask).toContainText("Until you remove it");
    await expect(ask.locator('[data-browser-answer="allow"]')).toHaveText("Always allow");
    await shot(page, testInfo, "browser-grant-app-page");
    await ask.locator('[data-browser-answer="allow"]').click();
    const allow = await m.waitFor("/api/browser/owner/grant-requests/answer");
    expect(await signer(page, keys, BROWSER_CANON, { serverDomain: HOME, requestId: "33333333-3333-4333-8333-333333333333", serviceId: SERVICE_ID, decision: "allow", duration: "service", capabilities: ["navigate", "read-dom"], origins: ["docs.example.com"], localNetwork: null, issuedAt: allow.body.issuedAt }, allow.body.signature)).toBe("admin");
    await expect(section.locator("[data-browser-request]")).toHaveCount(0, { timeout: 10_000 });
    await expect(section.locator("[data-browser-manifest]")).toBeVisible();
  });
});

// ───────────────────────────── upstream sync (N12) ─────────────────────────────

const SYNC_BUILD = "fedcba9876543210";
const SYNC_COMMIT = "9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc";
const syncDetail = (extra: Record<string, unknown> = {}) => ({
  app: { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` },
  manifest: { name: "notes" },
  dataLayerInstances: [],
  members: [],
  editable: true,
  importedFrom: { repo: "https://github.com/alice/notes.git", commit: "1".repeat(40) },
  ...extra,
});
const syncAnswer = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  buildId: SYNC_BUILD,
  candidateCommit: SYNC_COMMIT,
  upToDate: false,
  proposal: {
    upstreamChanged: ["src/a.ts", "src/b.ts", "flagship.app.json"],
    localChanged: ["src/b.ts", "README.md"],
    takeUpstream: ["src/a.ts", "flagship.app.json"],
    conflicts: ["src/b.ts"],
    alreadyApplied: ["LICENSE"],
    capabilityChanges: [{ section: "network.egress", added: ["api.example.com"], removed: [] }],
    clean: false,
  },
  ...extra,
});

async function openSyncedApp(page: Page, m: Mock, detail = syncDetail()): Promise<void> {
  world(m, [livePod(HOME)]);
  m.get(box(HOME, `/api/screens/app-detail/${SERVICE_ID}`), detail);
  await page.evaluate(async (id) => (await import("/views/service-detail.js")).enterServiceDetail(id), SERVICE_ID);
}

test.describe("gym ux upstream sync", () => {
  test("gym ux upstream sync the proposal shows new permissions apart and the conflicts, then opens the build to deploy", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    m.post(box(HOME, `/api/build/apps/${SERVICE_ID}/sync`), syncAnswer());
    m.get(box(HOME, `/api/build/sessions/${SYNC_BUILD}`), { state: { buildId: SYNC_BUILD, mode: "git", serverFqdn: HOME, createdAt: 1, gitFit: true, name: "notes" }, files: ["a", "b"] });
    await openSyncedApp(page, m);
    const row = page.locator("#sd-sync-upstream");
    await expect(row).toContainText("Check for updates from github.com/alice/notes", { timeout: 10_000 });
    await row.click();
    const sheet = page.locator("[data-sync-sheet]");
    await sheet.locator("#sync-ref").fill("v2.0");
    await sheet.locator('[data-sync-choice="check"]').click();
    const sent = await m.waitFor(`/api/build/apps/${SERVICE_ID}/sync`);
    expect(sent.body).toEqual({ ref: "v2.0" });
    await expect(sheet.locator("[data-sync-title]")).toHaveText("Update from github.com/alice/notes", { timeout: 10_000 });
    await expect(sheet.locator("[data-sync-version]")).toHaveText("Version 9f8e7d6c5b4a");
    const perms = sheet.locator("[data-sync-capabilities]");
    await expect(perms).toContainText("New permissions");
    await expect(perms).toContainText("This update changes what the app is allowed to do. Review before you deploy.");
    await expect(perms.locator('[data-sync-section="network.egress"]')).toContainText("Internet access");
    await expect(perms.locator('[data-sync-section="network.egress"]')).toContainText("Adds: api.example.com");
    await expect(sheet.locator("[data-sync-summary]")).toContainText("2 files updated from upstream");
    await expect(sheet.locator("[data-sync-summary]")).toContainText("1 of your changes kept");
    await expect(sheet.locator("[data-sync-summary]")).toContainText("1 file already matches");
    await expect(sheet.locator("[data-sync-conflicts]")).toContainText("1 conflict: your version was kept");
    await expect(sheet.locator("[data-sync-conflicts]")).toContainText("src/b.ts");
    await expect(sheet.locator("[data-sync-footer]")).toHaveText("Nothing goes live until you deploy.");
    // The permissions come before the code.
    expect(await sheet.evaluate((el) => {
      const p = el.querySelector("[data-sync-capabilities]")!;
      const s = el.querySelector("[data-sync-summary]")!;
      return !!(p.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await shot(page, testInfo, "upstream-sync-proposal");
    await sheet.locator('[data-sync-choice="review"]').click();
    await expect(page.locator("#view-build-git")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#build-git-deploy")).toBeVisible({ timeout: 10_000 });
    expect(m.sent(`/api/build/sessions/${SYNC_BUILD}/discard`)).toHaveLength(0);
    expect(m.sent(/\/deploy$/)).toHaveLength(0);
  });

  test("gym ux upstream sync up to date discards the opened build, and an app not imported here says so", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    let upToDate = true;
    m.post(box(HOME, `/api/build/apps/${SERVICE_ID}/sync`), () =>
      upToDate ? { json: syncAnswer({ upToDate: true, candidateCommit: "1".repeat(40), proposal: { upstreamChanged: [], localChanged: [], takeUpstream: [], conflicts: [], alreadyApplied: [], capabilityChanges: [], clean: true } }) } : { status: 404, json: { error: "this app was not imported from a repo on this server" } },
    );
    m.post(box(HOME, `/api/build/sessions/${SYNC_BUILD}/discard`), { ok: true });
    await openSyncedApp(page, m, syncDetail({ importedFrom: undefined, adaptedFrom: { repo: "github.com/alice/notes" } }));
    await page.locator("#sd-sync-upstream").click();
    const sheet = page.locator("[data-sync-sheet]");
    await sheet.locator('[data-sync-choice="check"]').click();
    await expect(sheet.locator("[data-sync-up-to-date]")).toHaveText("You already run the latest version from github.com/alice/notes.", { timeout: 10_000 });
    await shot(page, testInfo, "upstream-sync-up-to-date");
    await sheet.locator('[data-sync-choice="close"]').click();
    await m.waitFor(`/api/build/sessions/${SYNC_BUILD}/discard`);
    await expect(sheet).toHaveCount(0);

    upToDate = false;
    await page.locator("#sd-sync-upstream").click();
    await page.locator('[data-sync-sheet] [data-sync-choice="check"]').click();
    await expect(page.locator("[data-sync-sheet] [data-sync-error]")).toHaveText("This app wasn't imported from a repo on this server, so it can't check for updates.", { timeout: 10_000 });
    await page.locator('[data-sync-sheet] [data-sync-choice="cancel"]').click();
    expect(m.sent(`/api/build/sessions/${SYNC_BUILD}/discard`)).toHaveLength(1);
  });

  test("gym ux upstream sync an app with no repo offers no check", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    await openSyncedApp(page, m, syncDetail({ importedFrom: undefined }));
    await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
    await expect(page.locator("#sd-sync-upstream")).toHaveCount(0);
    await shot(page, testInfo, "upstream-sync-no-repo");
  });
});
