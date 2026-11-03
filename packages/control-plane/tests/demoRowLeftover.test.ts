/**
 * Security review M5: a demo_users row left behind by a deleted or reclaimed demo account made whoever held the name
 * next a demo account: readable by anyone without a read token (requireAccountRead), counted as existing by
 * accountExists, and resolved as `kind: "demo"` (the client then skips every credential gate). Now the row goes with
 * the account (deletion, reclaim, demo cleanup), and a demo row only ever speaks for the account row it was created
 * with (demo provisioning writes both, `isDemo: true`, in one batch).
 */
import { describe, expect, it } from "vitest";
import { ed, signAccountSelfDelete, type Keypair } from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { handleAccountDeletionBundle, handleAdminUsernameReclaim, type AccountDeletionDeps } from "../src/accountDeletion.js";
import { accountExists } from "../src/accountGone.js";
import { requireAccountRead, type AccountReadTokenDeps } from "../src/accountReadToken.js";
import { handleAccountResolve } from "../src/accountResolve.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const key = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};

function demoRow(username: string): DemoUserRecord {
  return {
    username, idempotencyKey: `key-${username}`, snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "r", size: "s",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state: "ready",
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  };
}

function deletionDeps(storage: InMemoryStorage, now = NOW): AccountDeletionDeps & { demoUsers: InMemoryStorage["demoUsers"] } {
  return {
    usernames: storage.usernames,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    deviceCapabilityGrants: storage.deviceCapabilityGrants,
    auditEvents: storage.auditEvents,
    demoUsers: storage.demoUsers,
    now: () => now,
  };
}

function readDeps(storage: InMemoryStorage): AccountReadTokenDeps {
  return {
    secret: "s3cret",
    usernames: storage.usernames,
    identities: storage.deviceIdentities,
    servers: storage.servers,
    demoUsers: storage.demoUsers,
    nonces: { claim: async () => true },
    now: () => NOW,
  };
}

async function demoAccount(storage: InMemoryStorage, username: string, irk: Keypair, claimedAt = NOW) {
  await storage.usernames.put({ username, irkPubHex: hex(irk.publicKey), claimedAt, isDemo: true, accountType: "demo" });
  await storage.demoUsers.insert(demoRow(username));
}

describe("a demo row never outlives its account (M5)", () => {
  it("account deletion removes the demo row", async () => {
    const storage = new InMemoryStorage();
    const irk = key(3);
    await demoAccount(storage, "demo-ann", irk);
    const request = { username: "demo-ann", issuedAt: NOW };
    const res = await handleAccountDeletionBundle(deletionDeps(storage), {
      accountSelfDelete: { request, signature: hex(signAccountSelfDelete(request, irk)) },
    });
    expect(res.status).toBe(200);
    expect(await storage.usernames.get("demo-ann")).toBeUndefined();
    expect(await storage.demoUsers.get("demo-ann")).toBeUndefined();
  });

  it("the dormant-name reclaim removes the demo row", async () => {
    const storage = new InMemoryStorage();
    await demoAccount(storage, "demo-bob", key(4), NOW - 91 * DAY);
    const res = await handleAdminUsernameReclaim(deletionDeps(storage), "demo-bob");
    expect(res.status).toBe(200);
    expect(await storage.demoUsers.get("demo-bob")).toBeUndefined();
  });

  it("the demo cleanup removes both rows", async () => {
    const storage = new InMemoryStorage();
    await demoAccount(storage, "demo-cat", key(5));
    expect(await storage.demoAccountProvisioning.cleanup("demo-cat", "key-demo-cat")).toBe(true);
    expect(await storage.usernames.get("demo-cat")).toBeUndefined();
    expect(await storage.demoUsers.get("demo-cat")).toBeUndefined();
  });
});

describe("a leftover demo row never applies to the name's next owner (M5)", () => {
  async function leftover() {
    const storage = new InMemoryStorage();
    // A row from an earlier demo account under this name, and a real account that holds the name now.
    await storage.demoUsers.insert(demoRow("dana"));
    await storage.usernames.put({ username: "dana", irkPubHex: hex(key(6).publicKey), claimedAt: NOW });
    return storage;
  }

  it("needs a read token for the real owner's private state", async () => {
    const storage = await leftover();
    const r = await requireAccountRead(readDeps(storage), "dana", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("resolves the name as the real account, never as a demo", async () => {
    const storage = await leftover();
    const r = await handleAccountResolve({ usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery, demoUsers: storage.demoUsers }, "dana");
    expect((r.body as { kind: string }).kind).not.toBe("demo");
  });

  it("counts an account as existing from its own row only", async () => {
    const storage = await leftover();
    expect(await accountExists(storage, "dana")).toBe(true);
    const orphan = new InMemoryStorage();
    await orphan.demoUsers.insert(demoRow("gone"));
    expect(await accountExists(orphan, "gone")).toBe(false);
  });

  it("still treats a live demo account as a demo", async () => {
    const storage = new InMemoryStorage();
    await demoAccount(storage, "demo-eve", key(7));
    expect(await requireAccountRead(readDeps(storage), "demo-eve", null)).toEqual({ ok: true, demo: true });
    expect(await accountExists(storage, "demo-eve")).toBe(true);
    const r = await handleAccountResolve({ usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery, demoUsers: storage.demoUsers }, "demo-eve");
    expect((r.body as { kind: string }).kind).toBe("demo");
  });
});
