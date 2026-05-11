/**
 * Playwright fixture that brings up a fresh pod-sim per test, wired
 * to a freshly-minted test identity. Each test gets isolated state.
 */

import { test as base, type Page } from "@playwright/test";
import { newTestIdentity, type TestIdentity, bytesToHex } from "./identity.js";
import { startPodSim, type PodSim } from "../pod-sim/server.js";

export interface E2EFixtures {
  identity: TestIdentity;
  podSim: PodSim;
}

/**
 * Read the webapp's freshly-derived IRK public key (the one created
 * from the in-browser bootstrap random UMK) and tell the pod-sim to
 * trust it. Call after `view-home` becomes visible and before any
 * pair / install order is sent. Idempotent within a test.
 */
export async function syncWebappPubkey(page: Page, podSim: PodSim): Promise<string> {
  const hex = await page.evaluate(async () => {
    const state = await import("/lib/state.js");
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
  page: async ({ page }, use) => {
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
