import { describe, expect, it, vi } from "vitest";
import { decryptAccountProfile, deriveAccountProfileKey } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleAccountResolve } from "../src/accountResolve.js";
import { handleGetDemoUser, runDemoProvisioningPoller } from "../src/demoUsers.js";
import {
  handleCreateDemoAccount,
  handleCleanupDemoAccount,
  type DemoAccountProvisioningDeps,
} from "../src/demoAccountProvisioning.js";
import { deriveDemoUmk } from "../src/demoIdentity.js";

const now = 1_900_000_000_000;
const kek = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const body = {
  username: "openai-build",
  accountName: "OpenAI Build Week",
  idempotencyKey: "reviewer-demo-2026-07-20",
};

function harness(createImpl?: () => Promise<{ serverId: string; ipv4: string | null }>) {
  const storage = new InMemoryStorage();
  let randomByte = 0xa0;
  const createServerWithUserData = vi.fn(createImpl ?? (async () => ({ serverId: "server-1", ipv4: "192.0.2.8" })));
  const findServerByName = vi.fn(async () => null);
  const getServerStatus = vi.fn(async () => ({ status: "running", ipv4: "192.0.2.8" }));
  const deps: DemoAccountProvisioningDeps = {
    provisioning: storage.demoAccountProvisioning,
    demos: storage.demoUsers,
    authCodes: storage.authCodes,
    hetzner: { createServerWithUserData, findServerByName },
    demoIrkKek: kek,
    defaultRegion: "fsn1",
    defaultSize: "cpx11",
    now: () => now,
    random: (length) => new Uint8Array(length).fill(randomByte++),
  };
  return { storage, deps, createServerWithUserData, findServerByName, getServerStatus };
}

describe("atomic demo account provisioning", () => {
  it("commits identity, encrypted profiles, and bootstrap state before requesting a provider", async () => {
    const { storage, deps, createServerWithUserData } = harness();
    createServerWithUserData.mockImplementationOnce(async () => {
      expect(await storage.usernames.get(body.username)).toBeDefined();
      expect(await storage.deviceIdentities.listForAccount(body.username)).toHaveLength(1);
      expect(await storage.accountProfiles.get(body.username)).toBeDefined();
      expect((await storage.demoUsers.get(body.username))?.state).toBe("provisioning");
      return { serverId: "server-1", ipv4: "192.0.2.8" };
    });
    const response = await handleCreateDemoAccount(deps, body);
    expect(response.status).toBe(202);
    expect(createServerWithUserData).toHaveBeenCalledTimes(1);
    const profile = await storage.accountProfiles.get(body.username);
    expect(profile).toBeDefined();
    expect(JSON.stringify(profile)).not.toContain(body.accountName);
    expect(decryptAccountProfile(profile!, deriveAccountProfileKey(deriveDemoUmk(kek, body.username))).displayName)
      .toBe(body.accountName);
  });

  it("keeps provider failure retryable and never creates a second identity or provider server", async () => {
    let attempts = 0;
    const { storage, deps, createServerWithUserData } = harness(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider unavailable");
      return { serverId: "server-1", ipv4: null };
    });
    expect((await handleCreateDemoAccount(deps, body)).status).toBe(502);
    expect((await storage.demoUsers.get(body.username))?.state).toBe("failed");
    expect((await handleCreateDemoAccount(deps, body)).status).toBe(202);
    expect((await handleCreateDemoAccount(deps, body)).status).toBe(202);
    expect(createServerWithUserData).toHaveBeenCalledTimes(2);
    expect(await storage.deviceIdentities.listForAccount(body.username)).toHaveLength(1);
    expect(await storage.deviceCapabilityGrants.listForUser(body.username)).toHaveLength(1);
  });

  it("does not publicly resolve initializing or cleanup-only demos", async () => {
    const { storage, deps } = harness();
    await handleCreateDemoAccount(deps, body);
    const resolve = () => handleAccountResolve({
      usernames: storage.usernames,
      webauthnRecovery: storage.webauthnRecovery,
      demoUsers: storage.demoUsers,
    }, body.username);
    await storage.demoUsers.update(body.username, { state: "initializing" });
    expect((await resolve()).body).toMatchObject({ exists: false, kind: "unknown" });
    await storage.demoUsers.update(body.username, { state: "cleanup-only" });
    expect((await resolve()).body).toMatchObject({ exists: false, kind: "unknown" });
  });

  it("becomes ready only after the provider is running and the daemon registered", async () => {
    const { storage, deps, getServerStatus } = harness();
    await handleCreateDemoAccount(deps, body);
    const lifecycleDeps = {
      storage: storage.demoUsers,
      hetzner: { getServerStatus },
      now: () => now + 1,
    };
    expect((await runDemoProvisioningPoller(lifecycleDeps, async () => false)).promoted).toBe(0);
    expect((await storage.demoUsers.get(body.username))?.state).toBe("provisioning");
    expect((await runDemoProvisioningPoller(lifecycleDeps, async () => true)).promoted).toBe(1);
    expect((await storage.demoUsers.get(body.username))?.state).toBe("ready");
    const status = await handleGetDemoUser(lifecycleDeps, body.username);
    expect(status.body).not.toHaveProperty("accountName");
    expect(JSON.stringify(status.body)).not.toContain(body.accountName);
  });

  it("rejects invalid input before creating public state", async () => {
    const { storage, deps, createServerWithUserData } = harness();
    expect((await handleCreateDemoAccount(deps, { ...body, username: "bad--name" })).status).toBe(400);
    expect((await handleCreateDemoAccount(deps, { ...body, accountName: "bad\nname" })).status).toBe(400);
    expect(await storage.usernames.list()).toHaveLength(0);
    expect(createServerWithUserData).not.toHaveBeenCalled();
  });

  it("cleanup resolves exact provider and idempotency identifiers before deletion", async () => {
    const { storage, deps } = harness();
    await handleCreateDemoAccount(deps, body);
    const destroyServer = vi.fn(async () => undefined);
    expect((await handleCleanupDemoAccount({
      provisioning: storage.demoAccountProvisioning,
      demos: storage.demoUsers,
      destroyServer,
    }, { username: body.username, idempotencyKey: "wrong-idempotency-key" })).status).toBe(409);
    expect(destroyServer).not.toHaveBeenCalled();
    expect((await handleCleanupDemoAccount({
      provisioning: storage.demoAccountProvisioning,
      demos: storage.demoUsers,
      destroyServer,
    }, { username: body.username, idempotencyKey: body.idempotencyKey })).status).toBe(200);
    expect(destroyServer).toHaveBeenCalledWith("server-1");
    expect(await storage.demoUsers.get(body.username)).toBeUndefined();
    expect(await storage.usernames.get(body.username)).toBeUndefined();
  });
});
