/**
 * S0 — pod-sim rig smoke test. Doesn't drive the browser; just
 * proves the pod-sim spins up, accepts orders, and CORS-preflights
 * cleanly. If this fails, no other flow can possibly pass.
 *
 * Uses Playwright's `request` fixture instead of Node's global
 * fetch — `request` honors `ignoreHTTPSErrors` from playwright.config,
 * which we need because the pod-sim runs on a self-signed dev cert.
 */

import { test, expect } from "../fixtures/pod-sim.js";
import { signPhoneOrder } from "@flagship/protocol";
import { bytesToHex } from "../fixtures/identity.js";

test("pod-sim listens on a localhost port + answers /api/orders-from-user", async ({
  identity,
  podSim,
  request,
}) => {
  expect(podSim.baseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);

  const order = {
    type: "noop" as const,
    serverId: identity.serverFqdn,
    issuedAt: Date.now(),
    nonce: "smoke-test",
  };
  const sig = signPhoneOrder(order, identity.irk);
  const r = await request.post(`${podSim.baseUrl}/api/orders-from-user`, {
    headers: { "content-type": "application/json" },
    data: {
      request: order,
      signature: bytesToHex(sig),
    },
  });
  expect(r.status()).toBe(200);
  expect(podSim.orders.list().length).toBe(1);
  expect(podSim.orders.list()[0]!.type).toBe("noop");
});

test("pod-sim rejects /api/screens/* without a paired-session token", async ({
  podSim,
  request,
}) => {
  const r = await request.get(`${podSim.baseUrl}/api/screens/server-detail`);
  expect(r.status()).toBe(401);
});

test("pod-sim CORS preflight echoes the cross-origin request", async ({
  podSim,
  request,
}) => {
  const r = await request.fetch(`${podSim.baseUrl}/api/orders-from-user`, {
    method: "OPTIONS",
    headers: {
      origin: "https://web.flagshipserver.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  expect(r.status()).toBe(204);
  expect(r.headers()["access-control-allow-origin"]).toBe("https://web.flagshipserver.com");
});
