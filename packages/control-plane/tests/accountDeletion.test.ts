import { describe, expect, it } from "vitest";
import {
  ed,
  signAccountSelfDelete,
  signServersSelfDelete,
  signDaemonStatusReport,
  type AccountSelfDelete,
  type DaemonStatusReport,
  type Keypair,
  type ServersSelfDelete,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleAccountDeletionBundle,
  handleAdminUsernameReclaim,
  type AccountDeletionDeps,
} from "../src/accountDeletion.js";
import { handlePostDaemonStatus } from "../src/podInventory.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";

const NOW = 1_700_000_000_000;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

async function seedAccount(
  storage: InMemoryStorage,
  username: string,
  irk: Keypair,
  claimedAt = NOW,
): Promise<void> {
  await storage.usernames.put({
    username,
    irkPubHex: hex(irk.publicKey),
    claimedAt,
  });
}

function deps(storage: InMemoryStorage, now = NOW): AccountDeletionDeps {
  return {
    usernames: storage.usernames,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    deviceCapabilityGrants: storage.deviceCapabilityGrants,
    auditEvents: storage.auditEvents,
    autoUnlockLeases: storage.autoUnlockLeases,
    boxSealedLeases: storage.boxSealedLeases,
    luksKeys: storage.luksKeys,
    webauthnRecovery: storage.webauthnRecovery,
    pushTokens: storage.pushTokens,
    now: () => now,
  };
}

function acctEnvelope(username: string, irk: Keypair, issuedAt = NOW) {
  const order: AccountSelfDelete = { username, issuedAt };
  return {
    request: { username, issuedAt },
    signature: hex(signAccountSelfDelete(order, irk)),
  };
}

function serversEnvelope(username: string, irk: Keypair, issuedAt = NOW) {
  const order: ServersSelfDelete = { username, issuedAt };
  return {
    request: { username, issuedAt },
    signature: hex(signServersSelfDelete(order, irk)),
  };
}

describe("handleAccountDeletionBundle — account-self-delete", () => {
  it("hard-deletes the account and makes the name claimable again immediately", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(1);
    await seedAccount(storage, "alice", irk);

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("alice", irk),
    });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);

    // Row is gone.
    expect(await storage.usernames.get("alice")).toBeUndefined();

    // The name passes claim availability again — a DIFFERENT IRK can claim it.
    const newIrk = makeKey(2);
    const claimOrder = { username: "alice", irkPub: newIrk.publicKey, issuedAt: NOW };
    const { signClaimUsername } = await import("@flagship/protocol");
    const claim = await handleUsernameClaim(
      { storage: storage.usernames, now: () => NOW },
      {
        request: { username: "alice", irkPub: hex(newIrk.publicKey), issuedAt: NOW },
        signature: hex(signClaimUsername(claimOrder, newIrk)),
      },
    );
    expect(claim.status).toBe(200);
    expect((await storage.usernames.get("alice"))?.irkPubHex).toBe(
      hex(newIrk.publicKey),
    );
  });

  it("tears down every owned server (routing released, record revoked)", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(3);
    await seedAccount(storage, "bob", irk);
    const d1 = "home.bob.flagship.services";
    const d2 = "blog.bob.flagship.services";
    for (const domain of [d1, d2]) {
      await storage.servers.put({
        serverDomain: domain,
        username: "bob",
        identityPubKeyHex: "ab".repeat(32),
        registeredAt: NOW,
      });
      await storage.routing.register({
        subdomain: domain,
        username: "bob",
        rckPubKeyHex: "cd".repeat(32),
        currentTargetHex: "",
        registeredAt: NOW,
        lastTargetUpdate: NOW,
        lastTargetNonce: "0",
      });
    }

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("bob", irk),
    });
    expect(res.status).toBe(200);
    expect((res.body as { serversTornDown: number }).serversTornDown).toBe(2);

    expect((await storage.servers.get(d1))?.revokedAt).toBeTruthy();
    expect((await storage.servers.get(d2))?.revokedAt).toBeTruthy();
    expect(await storage.routing.get(d1)).toBeUndefined();
    expect(await storage.routing.get(d2)).toBeUndefined();
  });

  it("rejects a bad signature without deleting the account", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(4);
    const wrong = makeKey(5);
    await seedAccount(storage, "carol", irk);

    const env = acctEnvelope("carol", wrong); // signed by the wrong key
    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: env,
    });
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("carol")).toBeDefined();
  });

  it("rejects a stale request", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(6);
    await seedAccount(storage, "dave", irk);
    const env = acctEnvelope("dave", irk, NOW - 10 * 60_000);
    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: env,
    });
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("dave")).toBeDefined();
  });

  it("404s an unknown account", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(7);
    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("ghost", irk),
    });
    expect(res.status).toBe(404);
  });
});

describe("handleAccountDeletionBundle — LAST-DEVICE enforcement", () => {
  async function addActiveGrant(
    storage: InMemoryStorage,
    username: string,
    devSeed: number,
  ): Promise<void> {
    const dev = makeKey(devSeed);
    await storage.deviceCapabilityGrants.put({
      grantId: `g-${devSeed}`,
      username,
      deviceLabel: `dev-${devSeed}`,
      devicePubHex: hex(dev.publicKey),
      scopesJson: JSON.stringify(["install-service"]),
      issuedAt: NOW,
      expiresAt: NOW + 1_000_000,
      signatureHex: "00".repeat(64),
      revokedAt: null,
    });
  }

  it("rejects when another active device grant exists", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(8);
    await seedAccount(storage, "erin", irk);
    await addActiveGrant(storage, "erin", 80);

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("erin", irk),
    });
    expect(res.status).toBe(403);
    expect(String((res.body as { error?: string }).error ?? "")).toContain(
      "last device",
    );
    expect(await storage.usernames.get("erin")).toBeDefined();
  });

  it("allows deletion once the other grant is revoked (0 active)", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(9);
    await seedAccount(storage, "fae", irk);
    await addActiveGrant(storage, "fae", 90);
    await storage.deviceCapabilityGrants.revoke("g-90", NOW);

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("fae", irk),
    });
    expect(res.status).toBe(200);
    expect(await storage.usernames.get("fae")).toBeUndefined();
  });
});

describe("handleAccountDeletionBundle — §5 bundle atomicity", () => {
  it("a standalone serversSelfDelete (no account companion) is rejected — neither recorded", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(10);
    await seedAccount(storage, "gail", irk);
    await storage.servers.put({
      serverDomain: "home.gail.flagship.services",
      username: "gail",
      identityPubKeyHex: "ab".repeat(32),
      registeredAt: NOW,
    });

    const res = await handleAccountDeletionBundle(deps(storage), {
      // accountSelfDelete deliberately absent
      serversSelfDelete: serversEnvelope("gail", irk),
    } as never);
    expect(res.status).toBe(400);
    // Nothing committed: account + server still present, no audit rows.
    expect(await storage.usernames.get("gail")).toBeDefined();
    expect(
      (await storage.servers.get("home.gail.flagship.services"))?.revokedAt,
    ).toBeFalsy();
    const audit = await storage.auditEvents.list("gail", 0, 50);
    expect(audit.length).toBe(0);
  });

  it("a bundle with an INVALID servers-self-delete sig rejects the WHOLE bundle (account NOT deleted)", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(11);
    const wrong = makeKey(12);
    await seedAccount(storage, "hank", irk);
    await storage.servers.put({
      serverDomain: "home.hank.flagship.services",
      username: "hank",
      identityPubKeyHex: "ab".repeat(32),
      registeredAt: NOW,
    });

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("hank", irk),
      serversSelfDelete: serversEnvelope("hank", wrong), // bad sig
    });
    expect(res.status).toBe(403);
    // Atomic reject — account survives, no orders recorded.
    expect(await storage.usernames.get("hank")).toBeDefined();
    const audit = await storage.auditEvents.list("hank", 0, 50);
    expect(audit.length).toBe(0);
  });

  it("a valid bundle commits BOTH: account deleted + servers-self-delete recorded per server", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(13);
    await seedAccount(storage, "iris", irk);
    for (const domain of [
      "home.iris.flagship.services",
      "blog.iris.flagship.services",
    ]) {
      await storage.servers.put({
        serverDomain: domain,
        username: "iris",
        identityPubKeyHex: "ab".repeat(32),
        registeredAt: NOW,
      });
    }

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("iris", irk),
      serversSelfDelete: serversEnvelope("iris", irk),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      contentWipeRequested: boolean;
      serversSelfDeleteForwarded: number;
    };
    expect(body.contentWipeRequested).toBe(true);
    expect(body.serversSelfDeleteForwarded).toBe(2);
    expect(await storage.usernames.get("iris")).toBeUndefined();

    const audit = await storage.auditEvents.list("iris", 0, 50);
    const kinds = audit.map((a) => a.eventKind);
    expect(kinds).toContain("account-deleted");
    expect(kinds.filter((k) => k === "servers-self-delete-issued").length).toBe(2);
  });

  it("a non-last-device caller with a bundle is rejected (neither order recorded)", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(14);
    await seedAccount(storage, "jane", irk);
    const dev = makeKey(140);
    await storage.deviceCapabilityGrants.put({
      grantId: "g-jane",
      username: "jane",
      deviceLabel: "second",
      devicePubHex: hex(dev.publicKey),
      scopesJson: JSON.stringify(["install-service"]),
      issuedAt: NOW,
      expiresAt: NOW + 1_000_000,
      signatureHex: "00".repeat(64),
      revokedAt: null,
    });

    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("jane", irk),
      serversSelfDelete: serversEnvelope("jane", irk),
    });
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("jane")).toBeDefined();
    const audit = await storage.auditEvents.list("jane", 0, 50);
    expect(audit.length).toBe(0);
  });

  it("a companion servers-self-delete naming a DIFFERENT account is rejected", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(15);
    await seedAccount(storage, "kyle", irk);
    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: acctEnvelope("kyle", irk),
      serversSelfDelete: serversEnvelope("someoneelse", irk),
    });
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("kyle")).toBeDefined();
  });
});

describe("handleAdminUsernameReclaim", () => {
  const RECLAIM_NOW = NOW;
  const NINETY_ONE_DAYS_AGO = RECLAIM_NOW - 91 * 24 * 60 * 60 * 1000;
  const TEN_DAYS_AGO = RECLAIM_NOW - 10 * 24 * 60 * 60 * 1000;

  it("frees a ≥90-day-inactive name (last_active old)", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(20);
    await seedAccount(storage, "liam", irk, NINETY_ONE_DAYS_AGO);
    await storage.usernames.touchLastActive("liam", NINETY_ONE_DAYS_AGO);

    const res = await handleAdminUsernameReclaim(deps(storage, RECLAIM_NOW), "liam");
    expect(res.status).toBe(200);
    expect(await storage.usernames.get("liam")).toBeUndefined();
    const audit = await storage.auditEvents.list("liam", 0, 50);
    expect(audit.map((a) => a.eventKind)).toContain("username-reclaimed");
  });

  it("falls back to claimedAt when last_active was never recorded", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(21);
    await seedAccount(storage, "mary", irk, NINETY_ONE_DAYS_AGO);
    // no touchLastActive → lastActive undefined → use claimedAt
    const res = await handleAdminUsernameReclaim(deps(storage, RECLAIM_NOW), "mary");
    expect(res.status).toBe(200);
    expect(await storage.usernames.get("mary")).toBeUndefined();
  });

  it("refuses a recently-active name", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(22);
    await seedAccount(storage, "nina", irk, NINETY_ONE_DAYS_AGO);
    await storage.usernames.touchLastActive("nina", TEN_DAYS_AGO);

    const res = await handleAdminUsernameReclaim(deps(storage, RECLAIM_NOW), "nina");
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("nina")).toBeDefined();
  });

  it("refuses a dormant name that still has an active device", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(23);
    await seedAccount(storage, "owen", irk, NINETY_ONE_DAYS_AGO);
    await storage.usernames.touchLastActive("owen", NINETY_ONE_DAYS_AGO);
    const dev = makeKey(230);
    await storage.deviceCapabilityGrants.put({
      grantId: "g-owen",
      username: "owen",
      deviceLabel: "d",
      devicePubHex: hex(dev.publicKey),
      scopesJson: JSON.stringify(["install-service"]),
      issuedAt: NINETY_ONE_DAYS_AGO,
      expiresAt: RECLAIM_NOW + 1_000_000,
      signatureHex: "00".repeat(64),
      revokedAt: null,
    });

    const res = await handleAdminUsernameReclaim(deps(storage, RECLAIM_NOW), "owen");
    expect(res.status).toBe(403);
    expect(await storage.usernames.get("owen")).toBeDefined();
  });

  it("dry-run reports eligibility WITHOUT mutating", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(24);
    await seedAccount(storage, "pat", irk, NINETY_ONE_DAYS_AGO);
    await storage.usernames.touchLastActive("pat", NINETY_ONE_DAYS_AGO);

    const res = await handleAdminUsernameReclaim(
      deps(storage, RECLAIM_NOW),
      "pat",
      { dryRun: true },
    );
    expect(res.status).toBe(200);
    const body = res.body as { dryRun: boolean; eligible: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.eligible).toBe(true);
    // Not mutated.
    expect(await storage.usernames.get("pat")).toBeDefined();
    expect((await storage.auditEvents.list("pat", 0, 50)).length).toBe(0);
  });

  it("dry-run on a recently-active name reports ineligible", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(25);
    await seedAccount(storage, "quinn", irk, NINETY_ONE_DAYS_AGO);
    await storage.usernames.touchLastActive("quinn", TEN_DAYS_AGO);

    const res = await handleAdminUsernameReclaim(
      deps(storage, RECLAIM_NOW),
      "quinn",
      { dryRun: true },
    );
    expect(res.status).toBe(200);
    expect((res.body as { eligible: boolean }).eligible).toBe(false);
  });

  it("404s an unknown name", async () => {
    const storage = new InMemoryStorage();
    const res = await handleAdminUsernameReclaim(deps(storage, RECLAIM_NOW), "nobody");
    expect(res.status).toBe(404);
  });
});

describe("last_active bump on a verified daemon-status heartbeat", () => {
  function hexOf(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
  }

  it("a verified heartbeat coarsely bumps the owner's last_active", async () => {
    const storage = new InMemoryStorage();
    const irk = makeKey(40);
    const stk = makeKey(41);
    const domain = "home.rita.flagship.services";
    await seedAccount(storage, "rita", irk, NOW - 100 * 24 * 60 * 60 * 1000);
    await storage.servers.put({
      serverDomain: domain,
      username: "rita",
      identityPubKeyHex: hexOf(stk.publicKey),
      registeredAt: NOW,
    });

    const report: DaemonStatusReport = {
      serverDomain: domain,
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      appsServed: [],
      nonce: "n1",
      issuedAt: NOW,
    };
    const res = await handlePostDaemonStatus(
      {
        daemonStatus: storage.daemonStatus,
        servers: storage.servers,
        routing: storage.routing,
        usernames: storage.usernames,
        now: () => NOW,
      },
      {
        request: {
          serverDomain: domain,
          certSha256: null,
          certValidUntil: null,
          certIssuer: null,
          appsServed: [],
          nonce: "n1",
          issuedAt: NOW,
        },
        signature: hexOf(signDaemonStatusReport(report, stk)),
      },
    );
    expect(res.status).toBe(200);
    expect((await storage.usernames.get("rita"))?.lastActive).toBe(NOW);
  });

  it("an invalid heartbeat signature does NOT bump last_active", async () => {
    const storage = new InMemoryStorage();
    const stk = makeKey(42);
    const wrong = makeKey(43);
    const domain = "home.sam.flagship.services";
    await seedAccount(storage, "sam", makeKey(44), NOW - 100 * 24 * 60 * 60 * 1000);
    await storage.servers.put({
      serverDomain: domain,
      username: "sam",
      identityPubKeyHex: hexOf(stk.publicKey),
      registeredAt: NOW,
    });
    const report: DaemonStatusReport = {
      serverDomain: domain,
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      appsServed: [],
      nonce: "n1",
      issuedAt: NOW,
    };
    const res = await handlePostDaemonStatus(
      {
        daemonStatus: storage.daemonStatus,
        servers: storage.servers,
        routing: storage.routing,
        usernames: storage.usernames,
        now: () => NOW,
      },
      {
        request: {
          serverDomain: domain,
          certSha256: null,
          certValidUntil: null,
          certIssuer: null,
          appsServed: [],
          nonce: "n1",
          issuedAt: NOW,
        },
        signature: hexOf(signDaemonStatusReport(report, wrong)),
      },
    );
    expect(res.status).toBe(403);
    expect((await storage.usernames.get("sam"))?.lastActive).toBeUndefined();
  });
});
