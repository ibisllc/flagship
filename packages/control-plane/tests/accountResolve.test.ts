// Unit tests for the /api/account/resolve/<username> login preflight.
//
// The contract: 200 ALWAYS (a missing account is kind:"unknown", never
// a 404), and the right (kind, graceModel, recovery.present) for each
// account shape so the client login state machine can branch without
// trial-and-error. See docs/login-and-account-redesign.md.

import { describe, expect, it } from "vitest";
import {
  handleAccountResolve,
  type AccountResolution,
  type AccountResolveDeps,
} from "../src/accountResolve.js";
import type {
  UsernameStorage,
  WebauthnRecoveryStorage,
  DemoUsersStorage,
  UsernameRecord,
  WebauthnRecoveryRecord,
} from "@flagship/storage";

function usernames(rows: Record<string, Partial<UsernameRecord>>): UsernameStorage {
  return {
    async get(name: string) {
      const r = rows[name.toLowerCase()];
      return r
        ? ({ username: name.toLowerCase(), irkPubHex: "aa".repeat(32), claimedAt: 1, ...r } as UsernameRecord)
        : undefined;
    },
    async put() { return { ok: true } as const; },
    async list() { return []; },
  } as unknown as UsernameStorage;
}

function recovery(rows: Record<string, Partial<WebauthnRecoveryRecord>>): WebauthnRecoveryStorage {
  return {
    async get(username: string) {
      const r = rows[username.toLowerCase()];
      return r
        ? ({
            username: username.toLowerCase(),
            credentialIdHex: "cc".repeat(16),
            wrappedUmkB64: "AAAA",
            updatedAt: 1,
            ...r,
          } as WebauthnRecoveryRecord)
        : undefined;
    },
  } as unknown as WebauthnRecoveryStorage;
}

const noDemo = { async get() { return undefined; } } as unknown as DemoUsersStorage;

function deps(over: Partial<AccountResolveDeps> = {}): AccountResolveDeps {
  return {
    usernames: usernames({}),
    webauthnRecovery: recovery({}),
    demoUsers: noDemo,
    ...over,
  };
}

const body = (r: { body: unknown }) => r.body as AccountResolution;

describe("handleAccountResolve", () => {
  it("unknown account: 200 + kind:unknown, zeroed factors (never 404)", async () => {
    const r = await handleAccountResolve(deps(), "nobody");
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.kind).toBe("unknown");
    expect(b.exists).toBe(false);
    expect(b.graceModel).toBe("none");
    expect(b.recovery.present).toBe(false);
    expect(b).not.toHaveProperty("trustedDeviceCount");
  });

  it("dotted/invalid input resolves to unknown (no dot-form login)", async () => {
    const r = await handleAccountResolve(deps(), "harry.ipad");
    expect(r.status).toBe(200);
    expect(body(r).kind).toBe("unknown");
  });

  it("demo account: 200 + kind:demo, demoServer, graceModel:instant (crypto no-op)", async () => {
    const { InMemoryDemoUsersStorage } = await import("@flagship/storage");
    const demoUsers = new InMemoryDemoUsersStorage();
    await demoUsers.insert({
      username: "demoalice",
      idempotencyKey: "demo-account-request-1234",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "ready",
      createdAt: 1,
      activeServerIp: null,
      image: "debian-12",
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });
    const r = await handleAccountResolve(deps({ demoUsers }), "demoalice");
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.kind).toBe("demo");
    expect(b.exists).toBe(true);
    expect(b.graceModel).toBe("instant");
    expect(b.demoServer).toBeDefined();
    expect(b.demoServer!.fqdn).toBe("home.demoalice.flagship.services");
    expect(b.recovery.present).toBe(false);
  });

  it("single account without cloud recovery: kind:single, recovery.present false, graceModel:3d", async () => {
    const r = await handleAccountResolve(
      deps({ usernames: usernames({ harry: {} }) }),
      "harry",
    );
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.kind).toBe("single");
    expect(b.exists).toBe(true);
    expect(b.graceModel).toBe("3d");
    expect(b.recovery.present).toBe(false);
    expect(b.totpEnrolled).toBe(false);
    expect(b).not.toHaveProperty("trustedDeviceCount");
  });

  it("single account WITH cloud recovery: recovery.present + hasFetchGate + credentialId", async () => {
    const r = await handleAccountResolve(
      deps({
        usernames: usernames({ harry: {} }),
        webauthnRecovery: recovery({ harry: { credentialIdHex: "ab".repeat(16), fetchTokenHashHex: "ff".repeat(32) } }),
      }),
      "harry",
    );
    const b = body(r);
    expect(b.kind).toBe("single");
    expect(b.recovery.present).toBe(true);
    expect(b.recovery.hasFetchGate).toBe(true);
    expect(b.recovery.credentialId).toBe("ab".repeat(16));
  });

  it("multi account: kind:multi, totpEnrolled true, graceModel:24h-totp", async () => {
    const r = await handleAccountResolve(
      deps({
        usernames: usernames({ team: { accountType: "multi", totpEnrolledAt: 123 } }),
        webauthnRecovery: recovery({ team: {} }),
      }),
      "team",
    );
    const b = body(r);
    expect(b.kind).toBe("multi");
    expect(b.exists).toBe(true);
    expect(b.totpEnrolled).toBe(true);
    expect(b.graceModel).toBe("24h-totp");
    expect(b).not.toHaveProperty("trustedDeviceCount");
    expect(b.recovery.present).toBe(true);
  });

  it("normalizes case", async () => {
    const r = await handleAccountResolve(deps({ usernames: usernames({ harry: {} }) }), "HARRY");
    expect(body(r).username).toBe("harry");
    expect(body(r).kind).toBe("single");
  });

  it("enriches demoServer with the latest provisioning phase + phaseAt", async () => {
    const { InMemoryDemoUsersStorage } = await import("@flagship/storage");
    const demoUsers = new InMemoryDemoUsersStorage();
    await demoUsers.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: "srv-1",
      activeServerFqdn: "home.demoalice.flagship.services",
      lastActivityAt: 0,
      state: "provisioning",
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });
    await demoUsers.setProvisionPhase("demoalice", "cert-issued", null, 555);
    const r = await handleAccountResolve(deps({ demoUsers }), "demoalice");
    const b = body(r);
    expect(b.demoServer!.phase).toBe("cert-issued");
    expect(b.demoServer!.phaseAt).toBe(555);
    expect(b.demoServer!.lastError).toBeUndefined();
  });

  it("surfaces the failure detail in demoServer.lastError on a failed phase", async () => {
    const { InMemoryDemoUsersStorage } = await import("@flagship/storage");
    const demoUsers = new InMemoryDemoUsersStorage();
    await demoUsers.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: "srv-1",
      activeServerFqdn: "home.demoalice.flagship.services",
      lastActivityAt: 0,
      state: "provisioning",
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });
    await demoUsers.setProvisionPhase("demoalice", "failed", "acme dns-01 timeout", 777);
    const r = await handleAccountResolve(deps({ demoUsers }), "demoalice");
    const b = body(r);
    expect(b.demoServer!.phase).toBe("failed");
    expect(b.demoServer!.lastError).toBe("acme dns-01 timeout");
  });

  it("demoServer.phase is null before any checkpoint arrives", async () => {
    const { InMemoryDemoUsersStorage } = await import("@flagship/storage");
    const demoUsers = new InMemoryDemoUsersStorage();
    await demoUsers.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });
    const r = await handleAccountResolve(deps({ demoUsers }), "demoalice");
    const b = body(r);
    expect(b.demoServer!.phase).toBeNull();
    expect(b.demoServer!.phaseAt).toBeNull();
  });
});
