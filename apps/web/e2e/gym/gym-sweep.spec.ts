/**
 * Every-button sweep (gym dimension D7): on each screen, press every visible
 * control and record what it did: a request, a screen change, a dialog, a
 * DOM change, a new tab or download. The test fails on any page error or
 * unhandled rejection a press causes, on a control that can't be pressed,
 * and on a screen that renders fewer controls than it should. Each screen is
 * reached by clicking from the tab bar or the screen before it. The per-
 * control results are attached (`sweep-<group>.json`); controls that showed no
 * effect are listed there for review, not failed, since some legitimately
 * do nothing without a backend.
 *
 * Presses that would end the session (Sign out, Lock, Remove this device)
 * are skipped; everything else runs against the mock (gymKit), so a signed
 * order goes nowhere.
 */

import { test, expect, type Page, type TestInfo, type Locator } from "@playwright/test";
import { HOME, OFFICE, USER, livePod, mock, reachHome, serverDetail, type Mock } from "./gymKit.js";

const SERVICE_ID = "smoketest--notes";

/** Controls that end the session or wipe this browser: pressing them would
 *  stop the sweep, and their own tests cover them. */
const SESSION_ENDERS = /^#(settings-signout|settings-pin-lock|settings-reset|bootstrap-reset|unlock-reset)$/;

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=switch]",
  "[role=tab]",
  ".is-tappable",
].join(",");

interface Result {
  view: string;
  control: string;
  effect: string;
}

function appDetail() {
  return {
    app: {
      serviceId: SERVICE_ID,
      slug: "notes",
      creator: USER,
      summary: "Shared notes for the house",
      status: "running",
      version: "1.2.0",
      url: `https://notes.${HOME}`,
      access: { rules: 1, pending: 0, draft: false },
      accessMode: "members-only",
    },
    manifest: { name: "notes", runtime: { base: "node-24" }, data: { stores: { postgres: true, files: true } } },
    dataLayerInstances: [{ kind: "postgres", name: "notes" }],
    members: [],
    editable: true,
  };
}

async function fixtures(page: Page): Promise<Mock> {
  const m = await mock(page);
  const now = Date.now();
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
  m.get(`${HOME}/api/screens/server-detail`, serverDetail(HOME));
  m.get(`${OFFICE}/api/screens/server-detail`, serverDetail(OFFICE));
  m.get("/api/screens/updates", { latest: null, releases: [] });
  m.get("/api/screens/apps-list", { apps: [{ serviceId: SERVICE_ID, slug: "notes", creator: USER, status: "running", summary: "Shared notes", url: `https://notes.${HOME}`, urlLabel: "notes" }] });
  m.get(`/api/screens/app-detail/${SERVICE_ID}`, appDetail());
  m.get(`/api/screens/services/${SERVICE_ID}/api-keys`, { keys: [] });
  m.get(`/api/screens/services/${SERVICE_ID}/members`, { members: [], invites: [] });
  m.get(`/api/screens/services/${SERVICE_ID}/access`, { rules: [], requests: [] });
  m.get(`/api/screens/services/${SERVICE_ID}/db`, { stores: [{ store: "notes", tables: [{ name: "notes", rows: 2 }] }] });
  m.get("/api/screens/access-requests", { requests: [] });
  m.get("/api/screens/activity", {
    entries: [
      { id: "a1", kind: "app-installed", at: now - 60_000, summary: "Installed notes", serviceId: SERVICE_ID },
      { id: "a2", kind: "server-updated", at: now - 3_600_000, summary: "Updated to v1.4.0" },
    ],
  });
  m.get("/api/build/sessions", { builds: [] });
  m.get("/api/screens/llm/sessions", { sessions: [] });
  m.get("/api/screens/paired-sessions/list", { sessions: [{ id: "ps1", kind: "remote", label: "Chrome on a laptop", createdAt: now - 86_400_000 }] });
  m.get("/api/accounts/smoketest/events", { events: [] });
  m.get("/api/users/smoketest/server-shares", { shares: [] });
  return m;
}

/** The visible controls of `root`, in document order. */
function controls(page: Page, root: string): Locator {
  return page.locator(`${root} :is(${CONTROL_SELECTOR}):visible`);
}

async function describe(el: Locator): Promise<string> {
  return el.evaluate((e) => {
    if (e.id) return `#${e.id}`;
    const data = [...e.attributes].filter((a) => a.name.startsWith("data-")).map((a) => (a.value ? `[${a.name}="${a.value}"]` : `[${a.name}]`));
    const label = e.getAttribute("aria-label") ?? (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${e.tagName.toLowerCase()}${data.join("")}${label ? ` "${label}"` : ""}`;
  });
}

/** Close anything a press opened: confirm/prompt overlays (Cancel resolves
 *  their promise), <dialog>s, and stray menus. */
async function closeOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const cancel = page.locator("[data-modal-cancel]:visible").first();
    if (!(await cancel.count())) break;
    await cancel.click({ timeout: 2_000 }).catch(() => {});
  }
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("dialog")) {
      try {
        (d as HTMLDialogElement).close();
      } catch {
        /* already closed */
      }
      d.remove();
    }
    for (const o of document.querySelectorAll(".modal-overlay")) o.remove();
    document.body.classList.remove("modal-open");
  });
}

async function effectMark(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __gymMut?: number };
    const view = [...document.querySelectorAll("section[id^=view-]")].find((s) => !s.classList.contains("hidden"))?.id ?? "";
    return { mut: w.__gymMut ?? 0, view, dialogs: document.querySelectorAll("dialog[open], .modal-overlay").length };
  });
}

interface Sweep {
  page: Page;
  m: Mock;
  results: Result[];
  errors: string[];
  popups: number;
  downloads: number;
}

async function startSweep(page: Page): Promise<Sweep> {
  const s: Sweep = { page, m: null as unknown as Mock, results: [], errors: [], popups: 0, downloads: 0 };
  page.on("pageerror", (e) => s.errors.push(`${e.name}: ${e.message} @ ${(e.stack ?? "").split("\n").slice(1, 3).join(" ").trim()}`));
  page.context().on("page", (p) => {
    s.popups++;
    void p.close().catch(() => {});
  });
  page.on("download", () => s.downloads++);
  page.on("dialog", (d) => void d.dismiss().catch(() => {}));
  await page.addInitScript(() => {
    const w = window as unknown as { __gymMut: number };
    w.__gymMut = 0;
    const start = () => new MutationObserver((ms) => (w.__gymMut += ms.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
  s.m = await fixtures(page);
  return s;
}

/**
 * Press every control on the screen `root` (reached with `reach`). After each
 * press the screen is reached again if the press left it or opened something.
 * Returns how many controls were pressed.
 */
/** Wait until the screen has finished rendering: its `ready` element (if
 *  any) shows and its control count holds still across two reads. */
async function settle(page: Page, root: string, ready?: string): Promise<void> {
  if (ready) await expect(page.locator(ready).first()).toBeVisible({ timeout: 15_000 });
  let last = -1;
  await expect
    .poll(async () => {
      const n = await controls(page, root).count();
      const same = n === last;
      last = n;
      return same;
    }, { intervals: [300], timeout: 15_000 })
    .toBe(true);
}

async function sweepScreen(s: Sweep, label: string, root: string, reach: () => Promise<void>, { min = 1, skip = /$^/, ready = "" } = {}): Promise<number> {
  const { page } = s;
  const arrive = async () => {
    await reach();
    await expect(page.locator(root)).toBeVisible({ timeout: 15_000 });
    await settle(page, root, ready || undefined);
  };
  await arrive();
  const seen = new Set<string>();
  let pressed = 0;
  for (let i = 0; i < 200; i++) {
    const all = controls(page, root);
    const n = await all.count();
    if (i >= n) break;
    const el = all.nth(i);
    const desc = await describe(el).catch(() => "");
    const key = `${i}:${desc}`;
    if (!desc || seen.has(key)) continue;
    seen.add(key);
    if (SESSION_ENDERS.test(desc) || skip.test(desc)) {
      s.results.push({ view: label, control: desc, effect: "skipped" });
      continue;
    }
    const type = await el.getAttribute("type");
    if (type === "file") {
      s.results.push({ view: label, control: desc, effect: "skipped (file picker; covered by its own spec)" });
      continue;
    }
    const before = await effectMark(page);
    const calls = s.m.calls.length;
    const popups = s.popups;
    const downloads = s.downloads;
    const errors = s.errors.length;
    let effect = "";
    try {
      if (type === "checkbox" || type === "radio") await el.click({ timeout: 3_000 });
      else if (await el.evaluate((e) => e.tagName === "SELECT")) {
        const opts = await el.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
        await el.selectOption(opts[opts.length - 1] ?? "", { timeout: 3_000 });
      } else if (await el.evaluate((e) => e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !["button", "submit", "checkbox", "radio", "range", "color"].includes((e as HTMLInputElement).type)))) {
        const numeric = await el.evaluate((e) => (e as HTMLInputElement).type === "number");
        await el.fill(numeric ? "3" : "gym sweep", { timeout: 3_000 });
      } else {
        await el.click({ timeout: 3_000 }).catch(async (e: Error) => {
          // A keyboard-only control (Home's Move up/down sit under the drag
          // handle for the pointer): press it the way a keyboard user does.
          if (!/intercepts pointer events|Timeout/.test(e.message) || (await el.isDisabled())) throw e;
          await el.focus();
          await page.keyboard.press("Enter");
        });
      }
    } catch (e) {
      const disabled = await el.isDisabled().catch(() => false);
      effect = disabled ? "disabled" : `NOT PRESSABLE: ${(e as Error).message.split("\n")[0]}`;
    }
    if (!effect) {
      // Give the press up to a second to show any effect.
      let after = before;
      for (let t = 0; t < 10; t++) {
        after = await effectMark(page);
        if (
          s.m.calls.length > calls ||
          after.view !== before.view ||
          after.dialogs !== before.dialogs ||
          s.popups > popups ||
          s.downloads > downloads ||
          after.mut > before.mut
        )
          break;
        await page.waitForTimeout(100);
      }
      const what: string[] = [];
      if (s.m.calls.length > calls) what.push(`request ${s.m.calls.slice(calls).map((c) => `${c.method} ${c.url.pathname}`).join(", ")}`);
      if (after.view !== before.view) what.push(`screen ${after.view}`);
      if (after.dialogs > before.dialogs) what.push("dialog");
      if (s.popups > popups) what.push("new tab");
      if (s.downloads > downloads) what.push("download");
      if (!what.length && after.mut > before.mut) what.push("page changed");
      effect = what.join("; ") || "no visible effect";
    }
    if (s.errors.length > errors) effect += ` | PAGE ERROR ${s.errors.slice(errors).join(" / ")}`;
    s.results.push({ view: label, control: desc, effect });
    pressed++;
    // Back to the screen, unchanged, for the next control.
    const now = await effectMark(page);
    if (now.dialogs > 0) await closeOverlays(page);
    if (now.view !== root.replace(/^#/, "") || effect.startsWith("request") || effect.includes("dialog")) {
      await closeOverlays(page);
      await arrive();
    }
  }
  expect(pressed, `${label}: controls pressed`).toBeGreaterThanOrEqual(min);
  return pressed;
}

async function finish(s: Sweep, testInfo: TestInfo, group: string): Promise<void> {
  const file = testInfo.outputPath(`sweep-${group}.json`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(s.results, null, 2));
  await testInfo.attach(`sweep-${group}`, { path: file, contentType: "application/json" });
  const unpressable = s.results.filter((r) => r.effect.startsWith("NOT PRESSABLE"));
  const broken = s.results.filter((r) => r.effect.includes("PAGE ERROR"));
  expect(broken, "presses that threw in the page").toEqual([]);
  expect(unpressable, "visible controls that can't be pressed").toEqual([]);
  expect(s.errors, "page errors").toEqual([]);
}

const tab = (page: Page, name: string) => async () => {
  await closeOverlays(page);
  await page.click(`[data-tab-target="${name}"]`);
};
const viaSettings = (page: Page, row: string) => async () => {
  await tab(page, "settings")();
  await expect(page.locator("#view-settings-tab")).toBeVisible();
  await page.click(`#${row}`);
};
const enter = (page: Page, mod: string, fn: string, ...args: unknown[]) => async () => {
  await closeOverlays(page);
  await page.evaluate(
    async ({ mod, fn, args }) => {
      const m = await import(mod);
      await m[fn](...args);
    },
    { mod, fn, args },
  );
};

test.describe("gym webapp every-button sweep", () => {
  test("gym sweep presses every control on Home, Activity and the Services list", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const s = await startSweep(page);
    await sweepScreen(s, "home", "#view-home", tab(page, "home"), { min: 3, ready: "#servers-list [data-open-fqdn]" });
    await sweepScreen(s, "activity", "#view-activity", tab(page, "activity"), { min: 1 });
    await sweepScreen(s, "services", "#view-services-list", tab(page, "apps"), { min: 2 });
    await finish(s, testInfo, "home");
  });

  test("gym sweep presses every control on Settings and the screens its rows open", async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    const s = await startSweep(page);
    await sweepScreen(s, "settings", "#view-settings-tab", tab(page, "settings"), { min: 15 });
    for (const [row, root] of [
      ["settings-tab-appearance", "#view-appearance"],
      ["settings-tab-privacy", "#view-privacy"],
      ["settings-tab-about", "#view-about"],
      ["settings-tab-providers", "#view-settings"],
      ["settings-tab-account-security", "#view-account-security"],
      ["settings-tab-trusted-devices", "#view-trusted-devices"],
      ["settings-tab-recovery", "#view-recovery"],
      ["settings-tab-profiles", "#view-profiles"],
      ["settings-tab-sessions", "#view-paired-sessions"],
      ["settings-tab-secured-sessions", "#view-secured-sessions"],
      ["settings-tab-peer-backup", "#view-peer-backup"],
      ["settings-tab-companion-requests", "#view-companion-requests"],
    ] as const) {
      await sweepScreen(s, row.replace("settings-tab-", ""), root, viaSettings(page, row));
    }
    await finish(s, testInfo, "settings");
  });

  test("gym sweep presses every control on a server page", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const s = await startSweep(page);
    const reach = async () => {
      await tab(page, "home")();
      await page.locator(`#servers-list [data-open-fqdn="${HOME}"]`).click();
    };
    await sweepScreen(s, "server", "#view-server-detail", reach, { min: 10 });
    await finish(s, testInfo, "server");
  });

  test("gym sweep presses every control on an app's pages", async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    const s = await startSweep(page);
    const app = enter(page, "/views/service-detail.js", "enterServiceDetail", SERVICE_ID);
    await sweepScreen(s, "app", "#view-service-detail", app, { min: 5 });
    await sweepScreen(s, "access-control", "#view-service-access", enter(page, "/views/service-access.js", "enterServiceAccess", appDetail().app), { min: 2 });
    await sweepScreen(s, "access-list", "#view-app-access", enter(page, "/views/app-access.js", "enterAppAccess", SERVICE_ID, "notes"));
    await sweepScreen(s, "database", "#view-app-db", enter(page, "/views/app-db.js", "enterAppDb", SERVICE_ID, "notes"));
    await sweepScreen(s, "environment", "#view-service-env", enter(page, "/views/service-env.js", "enterServiceEnv", SERVICE_ID, USER, "notes", HOME));
    await sweepScreen(s, "edit", "#view-edit-service", enter(page, "/views/edit-service.js", "enterEditService", SERVICE_ID));
    await finish(s, testInfo, "app");
  });

  test("gym sweep presses every control on the build screens", async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    const s = await startSweep(page);
    const source = async () => {
      await tab(page, "apps")();
      await page.click("#services-list-open-vibe-code");
    };
    await sweepScreen(s, "build-source", "#view-build-source", source, { min: 4 });
    await sweepScreen(s, "build-git", "#view-build-git", enter(page, "/views/build-git.js", "enterBuildGit"), { min: 3 });
    await sweepScreen(s, "build-mcp", "#view-build-mcp", enter(page, "/views/build-mcp.js", "enterBuildMcp"), { min: 2 });
    await sweepScreen(s, "build-journal", "#view-build-journal", enter(page, "/views/build-journal.js", "enterBuildJournal"));
    await sweepScreen(s, "build-key", "#view-build-key", enter(page, "/views/build-key.js", "enterBuildKey", {}), { min: 1 });
    await sweepScreen(s, "install-progress", "#view-install-progress", enter(page, "/views/install-progress.js", "enterInstallProgress"));
    await sweepScreen(s, "create-server", "#view-create-server", enter(page, "/views/create-server.js", "enterCreateServer"), { min: 3 });
    await finish(s, testInfo, "build");
  });
});
