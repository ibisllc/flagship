/**
 * Worker-level integration tests for the v2 device-addressing routes
 * (S3.3). Targets `tryControlPlane` directly with a stub D1 binding
 * — the deeper handler logic is tested at the control-plane level
 * (deviceCapabilityGrants.test.ts + demoUsersAdmin.test.ts).
 *
 * Coverage:
 *   - admin-bearer rejection paths for the two admin endpoints
 *   - 503 when DEMO_IRK_KEK isn't configured
 *   - anonymous device and grant enumeration routes do not exist
 *   - public POST /device-grants/revoke rejects malformed body with 400
 *   - public POST /device-grants rejects malformed body with 400
 */

import { describe, expect, it } from "vitest";
import {
  tryControlPlane,
  type ControlPlaneEnv,
} from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";

/** Stub D1 that returns "no rows everywhere". Sufficient for the
 *  wiring-level tests below — we're verifying status codes + route
 *  dispatch, not storage round-trips. The deeper functional coverage
 *  lives in the control-plane test suite. */
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

const ADMIN_SECRET = "test-admin-secret-fixed";
const KEK_HEX = "42".repeat(32);

function baseEnv(overrides: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv {
  return {
    DB: stubDb(),
    FLAGSHIP_ADMIN_SECRET: ADMIN_SECRET,
    ...overrides,
  };
}

describe("devGrants routes — admin endpoints", () => {
  it("admin-claim-and-issue: 401 without x-admin-secret", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/dev/sample-user/admin-claim-and-issue", {
        method: "POST",
        body: JSON.stringify({ username: "demoalice", serverName: "home" }),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(401);
  });

  it("admin-claim-and-issue: 403 with wrong x-admin-secret", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/dev/sample-user/admin-claim-and-issue", {
        method: "POST",
        headers: { "x-admin-secret": "wrong" },
        body: JSON.stringify({ username: "demoalice", serverName: "home" }),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });

  it("admin-claim-and-issue: 503 when DEMO_IRK_KEK is unset", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/dev/sample-user/admin-claim-and-issue", {
        method: "POST",
        headers: { "x-admin-secret": ADMIN_SECRET },
        body: JSON.stringify({ username: "demoalice", serverName: "home" }),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(503);
    const body = await r!.json();
    expect((body as { error: string }).error).toMatch(/DEMO_IRK_KEK/);
  });

  it("admin-mint-device-grant: 401 without x-admin-secret", async () => {
    const r = await tryControlPlane(
      new Request(
        "https://flagshipserver.com/api/dev/sample-user/demoalice/admin-mint-device-grant",
        {
          method: "POST",
          body: JSON.stringify({ deviceId: "reviewer", scopes: ["browse"] }),
        },
      ),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(401);
  });

  it("admin-mint-device-grant: 503 when DEMO_IRK_KEK is unset", async () => {
    const r = await tryControlPlane(
      new Request(
        "https://flagshipserver.com/api/dev/sample-user/demoalice/admin-mint-device-grant",
        {
          method: "POST",
          headers: { "x-admin-secret": ADMIN_SECRET },
          body: JSON.stringify({ deviceId: "reviewer", scopes: ["browse"] }),
        },
      ),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(503);
  });

  it("admin-mint-device-grant: 404 for unknown demo user when DEMO_IRK_KEK is set", async () => {
    const r = await tryControlPlane(
      new Request(
        "https://flagshipserver.com/api/dev/sample-user/demoalice/admin-mint-device-grant",
        {
          method: "POST",
          headers: { "x-admin-secret": ADMIN_SECRET },
          body: JSON.stringify({ deviceId: "reviewer", scopes: ["browse"] }),
        },
      ),
      baseEnv({ DEMO_IRK_KEK: KEK_HEX }),
    );
    expect(r).not.toBeNull();
    // Stub D1 returns null for the demo_users lookup → 404.
    expect(r!.status).toBe(404);
  });
});

describe("devGrants routes — privacy containment", () => {
  it("GET /device-grants is removed", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/users/alice/device-grants"),
      baseEnv(),
    );
    expect(r).toBeNull();
  });

  it("GET /devices is removed", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/users/alice/devices"),
      baseEnv(),
    );
    expect(r).toBeNull();
  });

  it("POST /device-grants: 400 on malformed body", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/users/alice/device-grants", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
  });

  it("POST /device-grants/revoke: 400 on malformed body", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/users/alice/device-grants/revoke", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
  });

  it("POST /users/check does not resolve dot-form device identity", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/users/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "demoalice.reviewer" }),
      }),
      baseEnv(),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    const body = await r!.json();
    expect(body).toEqual({
      username: "demoalice.reviewer",
      available: false,
      reason: "username must be 3–30 lowercase letters/digits with interior single dashes (no leading/trailing or double dash)",
    });
    expect(JSON.stringify(body)).not.toContain("deviceId");
  });
});
