import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signClaimUsername,
  signRevocation,
  verifyRevocation,
  type ServerRevocation,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleRevokeServer } from "../src/serverRevocation.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const USERNAME = "harry";
const DOMAIN = "home.harry.flagship.services";

async function setUpClaimedHarry() {
  const storage = new InMemoryStorage();
  const claim = {
    username: USERNAME,
    irkPub: harryIrk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claim, harryIrk);
  await handleUsernameClaim(
    { storage: storage.usernames },
    {
      request: {
        username: USERNAME,
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
  return storage;
}

async function seedServer(storage: InMemoryStorage, domain = DOMAIN) {
  await storage.servers.put({
    serverDomain: domain,
    username: USERNAME,
    identityPubKeyHex: "11".repeat(32),
    registeredAt: Date.now(),
  });
}

function revokeBody(
  irk = harryIrk,
  overrides: Partial<ServerRevocation> = {},
) {
  const claim: ServerRevocation = {
    userId: USERNAME,
    revokedServerId: DOMAIN,
    reason: "lost",
    issuedAt: Date.now(),
    ...overrides,
  };
  const sig = signRevocation(claim, irk);
  return {
    body: {
      request: {
        userId: claim.userId,
        revokedServerId: claim.revokedServerId,
        reason: claim.reason,
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
    claim,
  };
}

function deps(storage: InMemoryStorage) {
  return {
    usernames: storage.usernames,
    servers: storage.servers,
    auditEvents: storage.auditEvents,
    autoUnlockLeases: storage.autoUnlockLeases,
    boxSealedLeases: storage.boxSealedLeases,
  };
}

describe("POST /api/server-registry/revoke (IRK-signed user-initiated)", () => {
  it("happy path: marks the server revoked, writes audit row, returns 200", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);

    expect(r.status).toBe(200);
    const out = r.body as { ok: boolean; revokedAt: number; reason: string };
    expect(out.ok).toBe(true);
    expect(out.reason).toBe("lost");
    expect(out.revokedAt).toBeGreaterThan(0);

    // Server is marked revoked.
    const rec = await storage.servers.get(DOMAIN);
    expect(rec?.revokedAt).toBeGreaterThan(0);
    expect(rec?.revocationReason).toBe("lost");

    // Audit row landed under the user.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    const row = events.find((e) => e.eventKind === "server-revoked");
    expect(row).toBeDefined();
    expect(row?.detail).toContain(DOMAIN);
    expect(row?.detail).toContain("lost");
  });

  it("403 when signed by a different IRK than the registered one", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    const { body } = revokeBody(malloryIrk);
    const r = await handleRevokeServer(deps(storage), body);

    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/signature/i);

    // The server is untouched.
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();

    // No audit row.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.find((e) => e.eventKind === "server-revoked")).toBeUndefined();
  });

  it("400 on an invalid reason", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    const { body } = revokeBody(harryIrk, {
      reason: "totally-bogus" as unknown as ServerRevocation["reason"],
    });
    const r = await handleRevokeServer(deps(storage), body);

    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/reason/i);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("403 on a stale issuedAt (outside the 5-minute replay window)", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    const { body } = revokeBody(harryIrk, {
      issuedAt: Date.now() - 10 * 60_000,
    });
    const r = await handleRevokeServer(deps(storage), body);

    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/stale/i);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("is idempotent: replaying the same revocation returns 200 noop", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    const { body } = revokeBody();

    // First call lands.
    const r1 = await handleRevokeServer(deps(storage), body);
    expect(r1.status).toBe(200);
    const out1 = r1.body as { revokedAt: number; alreadyRevoked?: boolean };
    expect(out1.alreadyRevoked).toBeUndefined();
    const firstRevokedAt = out1.revokedAt;

    // Second call: same body, same signature → idempotent 200 with
    // alreadyRevoked + the ORIGINAL revokedAt (not a fresh stamp).
    const r2 = await handleRevokeServer(deps(storage), body);
    expect(r2.status).toBe(200);
    const out2 = r2.body as { revokedAt: number; alreadyRevoked: boolean; reason: string };
    expect(out2.alreadyRevoked).toBe(true);
    expect(out2.revokedAt).toBe(firstRevokedAt);
    expect(out2.reason).toBe("lost");

    // Only one audit row landed.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    const rows = events.filter((e) => e.eventKind === "server-revoked");
    expect(rows.length).toBe(1);
  });

  it("404 when the user is unknown", async () => {
    const storage = new InMemoryStorage(); // no username claimed
    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toMatch(/user/i);
  });

  it("404 when the server is unknown", async () => {
    const storage = await setUpClaimedHarry(); // user exists, no server
    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toMatch(/server/i);
  });

  it("403 when the server belongs to a different user", async () => {
    const storage = await setUpClaimedHarry();
    // Server registered to a different user — same domain shape.
    await storage.servers.put({
      serverDomain: DOMAIN,
      username: "someone-else",
      identityPubKeyHex: "22".repeat(32),
      registeredAt: Date.now(),
    });

    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/owned/i);
    // Untouched — even a valid IRK can't revoke a server it doesn't own.
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("400 on malformed body", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const r = await handleRevokeServer(deps(storage), { request: {} });
    expect(r.status).toBe(400);
  });

  it("accepts all three RevocationReason values (lost / stolen / decommissioned)", async () => {
    for (const reason of ["lost", "stolen", "decommissioned"] as const) {
      const storage = await setUpClaimedHarry();
      await seedServer(storage);

      const { body } = revokeBody(harryIrk, { reason });
      const r = await handleRevokeServer(deps(storage), body);
      expect(r.status).toBe(200);
      expect((await storage.servers.get(DOMAIN))?.revocationReason).toBe(reason);
    }
  });

  it("cascade: tears down active boot-unlock leases (both v1 plaintext and v2 box-sealed)", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);

    // Two legacy plaintext leases.
    await storage.autoUnlockLeases.put({
      serverDomain: DOMAIN,
      leaseId: "lease-1",
      unlockKeyHex: "aa".repeat(32),
      multiUse: false,
      depositedAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600_000,
    });
    await storage.autoUnlockLeases.put({
      serverDomain: DOMAIN,
      leaseId: "lease-2",
      unlockKeyHex: "bb".repeat(32),
      multiUse: true,
      depositedAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600_000,
    });
    // One v2 box-sealed lease.
    await storage.boxSealedLeases.put({
      serverDomain: DOMAIN,
      leaseId: "v2-1",
      stkPubHex: "cc".repeat(32),
      sealedKeyHex: "dd".repeat(32),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600_000,
      maxUses: null,
      usesConsumed: 0,
      signatureHex: "ee".repeat(64),
      depositedAt: Date.now(),
    });

    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(200);
    const out = r.body as { autoLeasesRevoked: number; boxSealedLeasesRevoked: number };
    expect(out.autoLeasesRevoked).toBe(2);
    expect(out.boxSealedLeasesRevoked).toBe(1);

    // Brick on next boot: every lease is gone.
    expect((await storage.autoUnlockLeases.list(DOMAIN, Date.now())).length).toBe(0);
    expect((await storage.boxSealedLeases.list(DOMAIN, Date.now())).length).toBe(0);
  });

  it("canonical bytes round-trip via @flagship/protocol's signRevocation / verifyRevocation", async () => {
    const claim: ServerRevocation = {
      userId: USERNAME,
      revokedServerId: DOMAIN,
      reason: "stolen",
      issuedAt: Date.now(),
    };
    const sig = signRevocation(claim, harryIrk);
    expect(verifyRevocation(claim, sig, harryIrk.publicKey)).toBe(true);
    // Wrong key fails.
    expect(verifyRevocation(claim, sig, malloryIrk.publicKey)).toBe(false);
    // Tamper with the reason → fails.
    expect(
      verifyRevocation({ ...claim, reason: "lost" }, sig, harryIrk.publicKey),
    ).toBe(false);
  });
});
