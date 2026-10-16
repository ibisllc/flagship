/**
 * Shared harness for the webapp mock gym (apps/web/e2e/gym/gym-*.spec.ts).
 *
 * - Reaching a signed-in shell with no backend, waiting on conditions (the
 *   "Unlocked" toast that follows the unlock's view dispatch), not sleeps.
 * - The four sessions the apps distinguish: an admin device (holds the
 *   account's admin root), a non-admin device of the same account (the
 *   account pins an admin root this device doesn't hold), a demo account
 *   (operator-run, pins none), and a co-manager (another account's server).
 * - One router for `.com` and every box that records each request; anything
 *   it doesn't know answers 404, so nothing reaches a network.
 * - `.com`'s and the box's signature rule for sensitive orders
 *   (control-plane adminAuthorityGate.authorizeSensitiveComOp): with an admin
 *   root pinned only the admin root verifies, the IRK is refused; with none
 *   pinned (a demo account) the IRK is accepted. `mock.sensitive(...)` answers
 *   exactly so, so a regression to IRK signing fails the test.
 */

import { expect, type Page, type TestInfo, type Route } from "@playwright/test";

export const PASSPHRASE = "correct-horse-battery-staple-gym";
export const USER = "smoketest";
export const HOME = "home.smoketest.flagship.services";
export const OFFICE = "office.smoketest.flagship.services";
export const MEDIA = "media.smoketest.flagship.services";
export const CONTROL = "https://flagshipserver.com";
export const STK: Record<string, string> = { [HOME]: "11".repeat(32), [OFFICE]: "22".repeat(32), [MEDIA]: "33".repeat(32) };
export const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
export const DEVICE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** The account's admin root seed: the admin device holds it; a non-admin device only sees its public key pinned. */
export const ADMIN_SEED_HEX = "5a".repeat(32);

export async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

/** Record every toast shown in `window.__gymToasts`, once per showing (the
 *  webapp queues toasts, so one can be gone before a poll sees it). Runs
 *  before any page script on every load. */
export async function watchToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gymToasts: string[] };
    w.__gymToasts = [];
    const start = () => {
      const t = document.getElementById("toast");
      if (!t) return void setTimeout(start, 20);
      let shown = "";
      const note = () => {
        const visible = !t.classList.contains("hidden");
        const s = (t.textContent ?? "").trim();
        if (!visible || !s) {
          shown = "";
          return;
        }
        if (s !== shown) {
          shown = s;
          w.__gymToasts.push(s);
        }
      };
      new MutationObserver(note).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  });
}

/** How many toasts have shown since the last load: pass it to `sawToast` as
 *  `after` to wait for a toast that comes after this point. */
export async function toastMark(page: Page): Promise<number> {
  return page.evaluate(() => ((window as unknown as { __gymToasts?: string[] }).__gymToasts ?? []).length);
}

/** Wait until a toast containing `text` has shown since the last load (or
 *  since `after`, a `toastMark`). */
export async function sawToast(page: Page, text: string, timeout = 15_000, after = 0): Promise<void> {
  await page.waitForFunction(
    ({ t, after }) => ((window as unknown as { __gymToasts?: string[] }).__gymToasts ?? []).slice(after).some((s) => s.includes(t)),
    { t: text, after },
    { timeout },
  );
}

export async function toasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __gymToasts?: string[] }).__gymToasts ?? []);
}

/** Cold launch → create an account in the passphrase modal (the wrapped UMK
 *  is in IndexedDB once the post-mint toast shows). */
export async function createAccount(page: Page): Promise<void> {
  await watchToasts(page);
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.click("#bootstrap-create");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 30_000 });
}

/** Reload at `?view=<alias>`, unlock with the passphrase and wait for the
 *  unlock to finish dispatching its view (its "Unlocked" toast follows the
 *  dispatch), so a late dispatch can't replace the screen a test opens next. */
export async function unlock(page: Page, view = "home"): Promise<void> {
  await page.goto(`/index.html?view=${view}`);
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 15_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await sawToast(page, "Unlocked", 30_000);
}

export type Kind = "admin" | "non-admin" | "demo";

export interface SessionSeed {
  /** admin: this device holds the admin root; non-admin: the account pins one
   *  this device lacks; demo: an operator-run demo account, no admin root. */
  kind?: Kind;
  /** Servers this device has a session for; the first is the current one. */
  servers?: string[];
}

export interface Keys {
  kind: Kind;
  /** The admin root `.com` and the boxes pin for this account (null: demo). */
  adminPubHex: string | null;
  irkPubHex: string;
}

/** Make the unlocked session one of the account kinds above, paired to `servers`. */
export async function seedSession(page: Page, seed: SessionSeed = {}): Promise<Keys> {
  const kind = seed.kind ?? "admin";
  const servers = seed.servers ?? [HOME];
  return page.evaluate(
    async ({ kind, servers, USER, ACCOUNT_ID, DEVICE_ID, ADMIN_SEED_HEX, CONTROL }) => {
      const ks = await import("/keystore.js");
      const profiles = await import("/lib/profiles.js");
      const store = await import("/lib/profilesStore.js");
      const { getSession } = await import("/lib/state.js");
      const api = await import("/lib/api.js");
      // As opening the account does: the device key (under the passphrase)
      // moves onto the account's own keystore record, so a reload unlocks it.
      await ks.adoptProfileKeys(USER);
      profiles.addProfile({
        cloudName: USER,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        ...(kind === "demo" ? { demoServer: { fqdn: servers[0], status: "up", phase: "live" } } : {}),
      });
      store.ensureProfile(USER);
      store.setActiveCloudName(USER);
      store.set("username", USER);
      const s = getSession();
      s.username = USER;
      const adminSeed = ks.hexToBytes(ADMIN_SEED_HEX);
      s.adminRootSeed = kind === "admin" ? adminSeed : null;
      api.setPodBaseUrl(`https://${servers[0]}`);
      api.setSessionToken(`gym-token-${servers[0]}`);
      for (const b of servers) api.setSessionTokenForPod(b, `gym-token-${b}`);
      (await import("/lib/apex.js")).setApexOverride({ control: CONTROL });
      const irk = await ks.deriveIrkFromSeed(s.umk);
      return {
        kind,
        adminPubHex: kind === "demo" ? null : await ks.adminRootPubHex(adminSeed),
        irkPubHex: ks.bytesToHex(irk.publicKey),
      };
    },
    { kind, servers, USER, ACCOUNT_ID, DEVICE_ID, ADMIN_SEED_HEX, CONTROL },
  );
}

/** Create, unlock and seed: a signed-in Home with `/pods` (and anything else) answered by `mock`. */
export async function reachHome(page: Page, seed: SessionSeed = {}): Promise<Keys> {
  await createAccount(page);
  await unlock(page, "home");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 15_000 });
  return seedSession(page, seed);
}

// ───────────────────────────── the router ─────────────────────────────

export interface Call {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}
export type Answer =
  | { status?: number; json: unknown }
  | { status?: number; raw: Buffer | string; contentType: string; headers?: Record<string, string> }
  | null
  | undefined;
type Matcher = string | RegExp | ((url: URL) => boolean);
interface Rule {
  method?: string;
  match: Matcher;
  answer: (call: Call) => Answer | Promise<Answer>;
}

function matches(m: Matcher, url: URL): boolean {
  if (typeof m === "function") return m(url);
  if (m instanceof RegExp) return m.test(url.href);
  return url.href.includes(m);
}

/** `.com` + every box as one recorded router. Rules match in the order added;
 *  `first()` puts a rule ahead of the others. The account read-token mint
 *  always answers. */
export class Mock {
  readonly calls: Call[] = [];
  private rules: Rule[] = [];
  constructor(readonly page: Page) {}

  async install(): Promise<this> {
    await this.page.route(
      (url) => url.pathname.startsWith("/api/") || url.hostname !== "127.0.0.1",
      (route) => this.handle(route),
    );
    return this;
  }

  on(method: string | undefined, match: Matcher, answer: unknown | ((call: Call) => Answer | Promise<Answer>)): this {
    this.rules.push({ method, match, answer: typeof answer === "function" ? (answer as Rule["answer"]) : () => ({ json: answer }) });
    return this;
  }
  get(match: Matcher, answer: unknown | ((call: Call) => Answer | Promise<Answer>)): this {
    return this.on("GET", match, answer);
  }
  post(match: Matcher, answer: unknown | ((call: Call) => Answer | Promise<Answer>)): this {
    return this.on("POST", match, answer);
  }
  first(method: string | undefined, match: Matcher, answer: unknown | ((call: Call) => Answer | Promise<Answer>)): this {
    this.rules.unshift({ method, match, answer: typeof answer === "function" ? (answer as Rule["answer"]) : () => ({ json: answer }) });
    return this;
  }

  /** Requests (POST by default) whose URL contains `needle`. */
  sent(needle: string | RegExp, method = "POST"): Call[] {
    return this.calls.filter((c) => c.method === method && matches(needle, c.url));
  }
  last(needle: string | RegExp, method = "POST"): Call | undefined {
    const all = this.sent(needle, method);
    return all[all.length - 1];
  }
  async waitFor(needle: string | RegExp, method = "POST", count = 1): Promise<Call> {
    await expect.poll(() => this.sent(needle, method).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
    return this.sent(needle, method)[count - 1]!;
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const call: Call = { method: req.method(), url, body, headers: req.headers() };
    if (url.pathname.endsWith("/read-token")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "art1.gym.mac", expiresAt: Date.now() + 86_400_000 }) });
      return;
    }
    this.calls.push(call);
    for (const rule of this.rules) {
      if (rule.method && rule.method !== call.method) continue;
      if (!matches(rule.match, url)) continue;
      const a = await rule.answer(call);
      if (!a) continue;
      if ("raw" in a) {
        await route.fulfill({ status: a.status ?? 200, contentType: a.contentType, body: a.raw, headers: a.headers });
        return;
      }
      await route.fulfill({ status: a.status ?? 200, contentType: "application/json", body: JSON.stringify(a.json) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
  }
}

export async function mock(page: Page): Promise<Mock> {
  return new Mock(page).install();
}

// ─────────────────────── the sensitive-order rule ───────────────────────

/** A canonical-bytes builder the webapp itself exports, named so the page can
 *  run it: `["/lib/serverOrder.js", "canonicalServerOrderBytes"]`, or a
 *  function of the signed object returning the canonical text itself. */
export type Canon = [module: string, fn: string] | ((arg: any) => string);

/** Whether `sigHex` verifies under `pubHex` over `canon(arg)`. */
export async function verifies(page: Page, canon: Canon, arg: unknown, sigHex: string, pubHex: string): Promise<boolean> {
  const text = typeof canon === "function" ? canon(arg) : null;
  return page.evaluate(
    async ({ mod, text, arg, sigHex, pubHex }) => {
      const ks = await import("/keystore.js");
      let msg: Uint8Array;
      if (text != null) msg = new TextEncoder().encode(text);
      else {
        const m = await import(mod![0]);
        const bytes = await m[mod![1]](arg);
        msg = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      }
      return ks.verifyWithEd25519Pub(ks.hexToBytes(pubHex), ks.hexToBytes(sigHex), msg);
    },
    { mod: typeof canon === "function" ? null : canon, text, arg, sigHex, pubHex },
  );
}

/** Which key signed: "admin" (the pinned admin root), "irk", or null (neither). */
export async function signer(page: Page, keys: Keys, canon: Canon, arg: unknown, sigHex: string): Promise<"admin" | "irk" | null> {
  if (keys.adminPubHex && (await verifies(page, canon, arg, sigHex, keys.adminPubHex))) return "admin";
  if (await verifies(page, canon, arg, sigHex, keys.irkPubHex)) return "irk";
  return null;
}

/** `.com`/the box's answer to a sensitive order: with an admin root pinned
 *  only it verifies (the IRK is refused exactly as `.com` refuses it); a demo
 *  account (none pinned) takes the IRK. */
export const REFUSED_NOT_ADMIN = "sensitive op requires master-admin authority";
export async function authorize(page: Page, keys: Keys, canon: Canon, arg: unknown, sigHex: unknown): Promise<boolean> {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  const who = await signer(page, keys, canon, arg, sigHex);
  return keys.adminPubHex ? who === "admin" : who === "irk";
}

/**
 * A rule answering a sensitive order the way `.com` and an admin-pinned box
 * do: `pick(body)` returns the signed object and its signature; a valid one
 * gets `ok(call)`, anything else a 403 with `.com`'s reason.
 */
export function sensitive(
  page: Page,
  keys: Keys,
  canon: Canon,
  pick: (body: any) => { arg: unknown; sig: unknown },
  ok: (call: Call) => Answer | Promise<Answer>,
): (call: Call) => Promise<Answer> {
  return async (call) => {
    const { arg, sig } = pick(call.body ?? {});
    if (await authorize(page, keys, canon, arg, sig)) return ok(call);
    return { status: 403, json: { error: REFUSED_NOT_ADMIN } };
  };
}

// ───────────────────────────── fixtures ─────────────────────────────

export function livePod(fqdn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { serverDomain: fqdn, identityPubKey: STK[fqdn] ?? "44".repeat(32), liveness: "live", lastReported: Date.now(), registeredAt: Date.now() - 30 * 86_400_000, ...extra };
}

export function offlinePod(fqdn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverDomain: fqdn,
    identityPubKey: STK[fqdn] ?? "44".repeat(32),
    liveness: "unreachable",
    lastSeenMsAgo: 2 * 3_600_000,
    lastReported: Date.now() - 2 * 3_600_000,
    registeredAt: Date.now() - 20 * 86_400_000,
    ...extra,
  };
}

/** A server page read for `fqdn`, with the fields every card reads. */
export function serverDetail(fqdn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverFqdn: fqdn,
    username: USER,
    daemonVersion: "1.0.0",
    currentCommit: "7ac1b50a".padEnd(40, "1"),
    uptimeMs: 3_600_000,
    certNotAfter: Date.now() + 60 * 86_400_000,
    certSans: [fqdn],
    serviceCount: 1,
    pairedSessionCount: 1,
    recentInstallEvents: [],
    ...extra,
  };
}

/** Render Home again (after the router is installed). */
export async function renderHome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { renderHome } = await import("/views/home.js");
    await renderHome();
  });
}

export function homeCard(page: Page, fqdn: string) {
  return page.locator(`#servers-list [data-open-fqdn="${fqdn}"]`);
}
