/**
 * Route-wiring tests for the #28 Option B seal-to-box ACME account-key
 * DELIVERY endpoints. Targets `tryControlPlane` with a stub D1 binding — we're
 * verifying status codes + route dispatch (POST/GET/DELETE all reach the right
 * handler), not storage round-trips. The deep functional coverage lives in
 * packages/control-plane/tests/acmeAccountKeyDelivery.test.ts.
 */

import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";

/** Stub D1 that returns "no rows everywhere" — the servers lookup is null, so
 *  the deposit/release/revoke handlers all reach their "unknown server" /
 *  not-ready branches, which is exactly what proves the dispatch. */
function stubDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

function env(): ControlPlaneEnv {
  return { DB: stubDb() };
}

const PATH = "https://flagshipserver.com/api/server/nas.dani.flagship.services/acme-account-key";

describe("seal-to-box ACME delivery routes — dispatch", () => {
  it("GET release reaches the handler → 404 (no slot for an unknown server)", async () => {
    const r = await tryControlPlane(new Request(PATH, { method: "GET" }), env());
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    const body = (await r!.json()) as { error: string };
    expect(body.error).toMatch(/no acme account key ready/);
  });

  it("POST deposit reaches the handler → 400 on a malformed body", async () => {
    const r = await tryControlPlane(
      new Request(PATH, { method: "POST", body: JSON.stringify({}) }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
  });

  it("POST deposit with a well-formed-but-unverifiable body → 404 (unknown server)", async () => {
    // A structurally valid body (passes the malformed gate) hits the servers
    // lookup, which the stub returns null for → 404 unknown server. This proves
    // the body parses through to the handler's server check.
    const body = {
      grant: {
        grantId: "g1",
        username: "dani",
        accountKeyId: "key-aaa",
        recipientPubKey: "aa".repeat(32),
        sealedAccountKey: "cc".repeat(8),
        issuedAt: 1,
        expiresAt: 9_999_999_999_999,
      },
      signature: "bb".repeat(64),
    };
    const r = await tryControlPlane(
      new Request(PATH, { method: "POST", body: JSON.stringify(body) }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });

  it("DELETE revoke reaches the handler → 400 on a malformed body", async () => {
    const r = await tryControlPlane(
      new Request(PATH, { method: "DELETE", body: JSON.stringify({}) }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
  });

  it("DELETE revoke with a well-formed body → 404 (unknown server)", async () => {
    const body = {
      request: {
        accountKeyId: "key-aaa",
        username: "dani",
        reason: "compromise",
        issuedAt: 1,
      },
      signature: "bb".repeat(64),
    };
    const r = await tryControlPlane(
      new Request(PATH, { method: "DELETE", body: JSON.stringify(body) }),
      env(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });
});
