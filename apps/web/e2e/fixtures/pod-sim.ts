/**
 * Playwright fixture that brings up a fresh pod-sim per test, wired
 * to a freshly-minted test identity. Each test gets isolated state.
 */

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { newTestIdentity, type TestIdentity, bytesToHex } from "./identity.js";
import { startPodSim, type PodSim } from "../pod-sim/server.js";

export interface E2EFixtures {
  identity: TestIdentity;
  podSim: PodSim;
}

/**
 * Complete first-run identity creation without coupling flow tests to the
 * account-claim wizard. The identity is persisted before username suggestion,
 * so forcing that optional network step to fail lets us reload, unlock, and
 * reach the authenticated shell deterministically.
 */
export async function bootstrapToHome(page: Page, passphrase: string): Promise<void> {
  await page.route("**/api/username/suggest", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.click("#bootstrap-create");
  await page.locator(".modal-input").fill(passphrase);
  await page.click("[data-modal-ok]");
  await page.locator(".modal-input").fill(passphrase);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
  await page.unroute("**/api/username/suggest");

  await page.reload();
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", passphrase);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // Current persistence is profile-scoped. Create a local-only profile around
  // the same unlocked seed so subsequent pair/settings writes have a valid
  // namespace and later reloads can unlock the profile-specific wrapped key.
  await page.evaluate(async (localPassphrase) => {
    const state = (await import("/lib/state.js" as string)) as {
      getSession(): { umk: Uint8Array | null };
    };
    const keystore = (await import("/keystore.js" as string)) as {
      persistSeedForProfile(seed: Uint8Array, cloudName: string, passphrase: string): Promise<string>;
    };
    const profiles = (await import("/lib/profiles.js" as string)) as {
      addProfile(profile: { cloudName: string; accountId: string; deviceId: string; createdAt: number }): unknown;
    };
    const seed = state.getSession().umk;
    if (!seed) throw new Error("bootstrapToHome: unlocked seed missing");
    const cloudName = "e2e-local";
    await keystore.persistSeedForProfile(seed, cloudName, localPassphrase);
    // A real account-scoped device id (32 hex, as generateDeviceId writes):
    // signed envelopes such as the push-token register refuse anything else.
    const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    profiles.addProfile({ cloudName, accountId: "e2e-local", deviceId, createdAt: Date.now() });
  }, passphrase);
}
/**
 * Read the webapp's freshly-derived IRK public key (the one created
 * from the in-browser bootstrap random UMK) and tell the pod-sim to
 * trust it. Call after `view-home` becomes visible and before any
 * pair / install order is sent. Idempotent within a test.
 */
export async function syncWebappPubkey(page: Page, podSim: PodSim): Promise<string> {
  const hex = await page.evaluate(async () => {
    // Runtime-served browser module — widen the specifier so TS treats
    // it as a dynamic import (NodeNext won't honor a path ambient
    // shim); cast to the surface this fixture uses.
    const state = (await import("/lib/state.js" as string)) as {
      getSession(): { irk?: { publicKey?: Uint8Array } | null };
    };
    const session = state.getSession();
    if (!session.irk || !session.irk.publicKey) {
      throw new Error("syncWebappPubkey: session.irk not populated — call after view-home");
    }
    const pk: Uint8Array = session.irk.publicKey;
    return Array.from(pk).map((b: number) => b.toString(16).padStart(2, "0")).join("");
  });
  podSim.setTrustedIrkPub(hex);
  return hex;
}

/**
 * The rig serves the webapp from wrangler dev on localhost and tells the
 * Worker which host it means with x-flagship-effective-host. The `page`
 * fixture stamps that header with page.route, which never sees requests the
 * service worker makes itself — so a spec that allows the SW must call this,
 * or the SW's install-time precache fetches the APEX's /style.css (404), the
 * install rejects and navigator.serviceWorker.ready never settles. A context
 * route also covers SW-originated requests (Chromium). No-op against a
 * deployed webapp.
 */
export async function routeServiceWorkerToWebappHost(context: BrowserContext): Promise<void> {
  const base = process.env.WEBAPP_BASE_URL ?? "http://localhost:8787";
  if (!/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) return;
  const origin = new URL(base).origin;
  await context.route(
    (url) => url.origin === origin,
    (route, request) =>
      route.continue({
        headers: { ...request.headers(), "x-flagship-effective-host": "webapp.flagshipserver.com" },
      }),
  );
}

const E2E_VERBOSE = process.env.E2E_VERBOSE === "1";

export const test = base.extend<E2EFixtures>({
  identity: async ({}, use) => {
    await use(newTestIdentity());
  },
  podSim: async ({ identity }, use) => {
    const sim = await startPodSim({
      username: identity.username,
      serverFqdn: identity.serverFqdn,
      pskPubHex: bytesToHex(identity.irk.publicKey),
      hostIrkPubHex: bytesToHex(identity.irk.publicKey),
    });
    try {
      await use(sim);
    } finally {
      await sim.close();
    }
  },
  // Surface browser console errors + uncaught exceptions to the test
  // stderr so failures don't require us to dig into trace.zip every
  // time. Auto-attached via the `page` fixture override.
  //
  // Also stamps the wrangler-dev host override on every request that
  // targets the configured webapp origin. Workerd builds `request.url`
  // from the listening address, so the apex Worker can't tell a localhost
  // request is meant for the webapp host without a hint. We use page.route
  // (not playwright.config's extraHTTPHeaders) so the header is scoped to
  // wrangler-dev requests only — Google Fonts, the pod-sim, and
  // ServiceWorker registration all stay free of the custom header that
  // would otherwise trigger CORS preflight failures or MIME-type errors.
  // See `apps/com/src/route.ts` for the matching server-side hook.
  page: async ({ page }, use) => {
    const webappBase = process.env.WEBAPP_BASE_URL ?? "http://localhost:8787";
    const isLocalDev = /\/\/localhost(:|\/|$)/.test(webappBase) ||
      /\/\/127\.0\.0\.1(:|\/|$)/.test(webappBase);
    if (isLocalDev) {
      const localOrigin = new URL(webappBase).origin;
      // Match path-suffix `/**` because the route's URL pattern is the
      // request URL string. Use a function predicate so we can match by
      // origin reliably.
      await page.route(
        (url) => url.origin === localOrigin,
        async (route, request) => {
          const headers = {
            ...request.headers(),
            "x-flagship-effective-host": "webapp.flagshipserver.com",
          };
          await route.continue({ headers });
        },
      );
    }
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning" || E2E_VERBOSE) {
        console.error(`[browser ${t}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`[browser pageerror] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      console.error(`[browser requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`);
    });
    await use(page);
  },
});

export { expect } from "@playwright/test";
