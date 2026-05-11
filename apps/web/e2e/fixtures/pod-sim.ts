/**
 * Playwright fixture that brings up a fresh pod-sim per test, wired
 * to a freshly-minted test identity. Each test gets isolated state.
 */

import { test as base } from "@playwright/test";
import { newTestIdentity, type TestIdentity, bytesToHex } from "./identity.js";
import { startPodSim, type PodSim } from "../pod-sim/server.js";

export interface E2EFixtures {
  identity: TestIdentity;
  podSim: PodSim;
}

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
});

export { expect } from "@playwright/test";
