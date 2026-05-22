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
  PushTokenStorage,
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

function pushTokens(countByUser: Record<string, number>): PushTokenStorage {
  return {
    async listByUser(username: string) {
      const n = countByUser[username.toLowerCase()] ?? 0;
      return Array.from({ length: n }, (_, i) => ({
        tokenId: `t${i}`,
        username: username.toLowerCase(),
        label: "d",
        platform: "apns",
        registeredAt: 1,
        lastSeenAt: 1,
      }));
    },
  } as unknown as PushTokenStorage;
}

const noDemo = { async get() { return undefined; } } as unknown as DemoUsersStorage;

function deps(over: Partial<AccountResolveDeps> = {}): AccountResolveDeps {
  return {
    usernames: usernames({}),
    webauthnRecovery: recovery({}),
    demoUsers: noDemo,
    pushTokens: pushTokens({}),
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
    expect(b.trustedDeviceCount).toBe(0);
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
      username: "demo-alice",
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
    });
    const r = await handleAccountResolve(deps({ demoUsers }), "demo-alice");
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.kind).toBe("demo");
    expect(b.exists).toBe(true);
    expect(b.graceModel).toBe("instant");
    expect(b.demoServer).toBeDefined();
    expect(b.demoServer!.fqdn).toBe("home.demo-alice.flagship.services");
    expect(b.recovery.present).toBe(false);
  });

  it("single account without cloud recovery: kind:single, recovery.present false, graceModel:7d", async () => {
    const r = await handleAccountResolve(
      deps({ usernames: usernames({ harry: {} }), pushTokens: pushTokens({ harry: 1 }) }),
      "harry",
    );
    expect(r.status).toBe(200);
    const b = body(r);
    expect(b.kind).toBe("single");
    expect(b.exists).toBe(true);
    expect(b.graceModel).toBe("7d");
    expect(b.recovery.present).toBe(false);
    expect(b.totpEnrolled).toBe(false);
    expect(b.trustedDeviceCount).toBe(1);
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
        pushTokens: pushTokens({ team: 3 }),
      }),
      "team",
    );
    const b = body(r);
    expect(b.kind).toBe("multi");
    expect(b.exists).toBe(true);
    expect(b.totpEnrolled).toBe(true);
    expect(b.graceModel).toBe("24h-totp");
    expect(b.trustedDeviceCount).toBe(3);
    expect(b.recovery.present).toBe(true);
  });

  it("normalizes case", async () => {
    const r = await handleAccountResolve(deps({ usernames: usernames({ harry: {} }) }), "HARRY");
    expect(body(r).username).toBe("harry");
    expect(body(r).kind).toBe("single");
  });
});
