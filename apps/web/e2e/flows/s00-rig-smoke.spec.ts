/**
 * S0 — pod-sim rig smoke test. Doesn't drive the browser; just
 * proves the pod-sim spins up, accepts orders, and CORS-preflights
 * cleanly. If this fails, no other flow can possibly pass.
 */

import { test, expect } from "../fixtures/pod-sim.js";
import { signPhoneOrder } from "@flagship/protocol";
import { bytesToHex } from "../fixtures/identity.js";

test("pod-sim listens on a localhost port + answers /api/orders-from-user", async ({
  identity,
  podSim,
}) => {
  expect(podSim.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const order = {
    type: "noop" as const,
    serverId: identity.serverFqdn,
    issuedAt: Date.now(),
    nonce: "smoke-test",
  };
  const sig = signPhoneOrder(order, identity.irk);
  const r = await fetch(`${podSim.baseUrl}/api/orders-from-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: order,
      signature: bytesToHex(sig),
    }),
  });
  expect(r.status).toBe(200);
  expect(podSim.orders.list().length).toBe(1);
  expect(podSim.orders.list()[0]!.type).toBe("noop");
});

test("pod-sim rejects /api/screens/* without a paired-session token", async ({ podSim }) => {
  const r = await fetch(`${podSim.baseUrl}/api/screens/server-detail`);
  expect(r.status).toBe(401);
});

test("pod-sim CORS preflight echoes the cross-origin request", async ({ podSim }) => {
  const r = await fetch(`${podSim.baseUrl}/api/orders-from-user`, {
    method: "OPTIONS",
    headers: {
      origin: "https://web.flagshipserver.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-origin")).toBe("https://web.flagshipserver.com");
});
