// The org-read group's flow (lib/orgReadFlow.ts) against the real Worker routes on a real D1 schema, offline: the live
// run does the same against the gym's `.com`.
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { tryControlPlane, type ControlPlaneEnv } from "../../../apps/com/src/controlPlaneRoutes.js";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { orgReadFlow } from "../lib/orgReadFlow.js";

const ORIGIN = "https://gym.flagshipserver.com";

function worker(over: Partial<ControlPlaneEnv> = {}) {
  const sqlite = createSqliteD1();
  const env = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "k".repeat(64), SERVICES_APEX: "gym.flagship.services", ...over } as ControlPlaneEnv;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await tryControlPlane(new Request(String(input), init), env);
    return r ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { sqlite, env, fetchImpl };
}

describe("org read token flow (the org-read gym group)", () => {
  it("an org box reads with its STK token, never the audit log, and is refused once revoked", async () => {
    const w = worker();
    try {
      const flow = orgReadFlow({ control: ORIGIN, servicesApex: "gym.flagship.services", fetchImpl: w.fetchImpl });
      expect(await flow.createOrg()).toMatch(/^org gymorg[0-9a-f]{8} /);
      expect(await flow.registerBox()).toBe(flow.serverDomain);
      expect(await flow.boxReads()).toMatch(/^authority, seats, keys read with box token ort1\./);
      expect(await flow.auditScope()).toMatch(/^box token 401, admin token 200/);
      const revoked = await flow.revokedBoxRefused();
      expect(revoked).toMatch(/^new token refused \(403\)/);
      // main's .com: these reads accept the token but do not need it yet (0.5 makes them need it).
      expect(revoked).toContain("seats: open without a token on this .com");
    } finally {
      w.sqlite.close();
    }
  });

  it("fails the box-read step when .com mints no token (the box would read without it)", async () => {
    const w = worker({ ACCOUNT_READ_TOKEN_SECRET: undefined });
    try {
      const flow = orgReadFlow({ control: ORIGIN, servicesApex: "gym.flagship.services", fetchImpl: w.fetchImpl });
      await flow.createOrg();
      await flow.registerBox();
      await expect(flow.boxReads()).rejects.toThrow(/without the org read token/);
    } finally {
      w.sqlite.close();
    }
  });
});
