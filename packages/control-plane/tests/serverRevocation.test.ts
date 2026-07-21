import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  ed,
  signClaimUsername,
  signDeviceCapabilityGrant,
  signRevocation,
  verifyRevocation,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type Keypair,
  type ServerRevocation,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleMintDeviceGrant } from "../src/deviceCapabilityGrants.js";
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

/** Fake DNS-delete client that records every (name,type) deleteByName call.
 *  Returns 1 per call by default (one record "deleted") so the response
 *  count is assertable; `fail` makes it throw to prove best-effort. */
function makeFakeDns(opts?: { fail?: boolean }) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    async deleteByName(name: string, type: string): Promise<number> {
      calls.push([name, type]);
      if (opts?.fail) throw new Error("CF DNS boom");
      return 1;
    },
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

  it("DNS cleanup: deletes the per-box A/AAAA records (apex + wildcard), NOT the user-zone CAA", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const dns = makeFakeDns();

    const { body } = revokeBody();
    const r = await handleRevokeServer({ ...deps(storage), dns }, body);
    expect(r.status).toBe(200);

    // Exactly the four per-box records: <serverDomain> + *.<serverDomain>,
    // each A and AAAA. No CAA, no user-zone names (CAA is shared).
    expect(dns.calls.sort()).toEqual(
      [
        [DOMAIN, "A"],
        [DOMAIN, "AAAA"],
        [`*.${DOMAIN}`, "A"],
        [`*.${DOMAIN}`, "AAAA"],
      ].sort(),
    );
    expect(dns.calls.some(([, type]) => type === "CAA")).toBe(false);
    expect((r.body as { dnsRecordsDeleted: number }).dnsRecordsDeleted).toBe(4);
  });

  it("DNS cleanup is best-effort: a CF failure does NOT undo the revocation", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const dns = makeFakeDns({ fail: true });

    const { body } = revokeBody();
    const r = await handleRevokeServer({ ...deps(storage), dns }, body);
    expect(r.status).toBe(200);
    expect((r.body as { dnsRecordsDeleted: number }).dnsRecordsDeleted).toBe(0);
    // The server is still revoked even though every DNS delete threw.
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);
  });

  it("no dns dep wired → revocation succeeds with no cleanup", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const { body } = revokeBody();
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(200);
    expect((r.body as { dnsRecordsDeleted: number }).dnsRecordsDeleted).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Device-authorized revocation (task #39): a 2nd device holding a
// `revoke-others` (or superset `admin`) DeviceCapabilityGrant may revoke a
// server by passing `signerPubHex` on the body. This is the ONLY production
// consumer of `requireDeviceScope`. The owner legacy path (no `signerPubHex`)
// must be UNCHANGED.
// ──────────────────────────────────────────────────────────────────────

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

/** deps WITH the grants dep wired (mirrors the apps/com call site). */
function depsWithGrants(storage: InMemoryStorage) {
  return {
    ...deps(storage),
    grants: {
      storage: storage.deviceCapabilityGrants,
      identities: storage.deviceIdentities,
      usernames: storage.usernames,
    },
  };
}

/** Mint a DeviceCapabilityGrant for `device` under USERNAME via the real
 *  mint handler (same storage `requireDeviceScope` reads), so revocation +
 *  expiry behave exactly as in production. */
async function mintDeviceGrant(
  storage: InMemoryStorage,
  device: Keypair,
  opts: {
    scopes: DeviceScope[];
    deviceId?: string;
    grantId?: string;
    issuedAt?: number;
    expiresAt?: number;
  },
): Promise<string> {
  const issuedAt = opts.issuedAt ?? Date.now();
  const expiresAt = opts.expiresAt ?? issuedAt + 90 * 24 * 3_600_000;
  const grantId = opts.grantId ?? `grant-${Math.random().toString(36).slice(2)}`;
  const deviceId = opts.deviceId ?? bytesToHex(device.publicKey.slice(0, 16));
  await storage.deviceIdentities.put({
    accountId: USERNAME,
    deviceId,
    devicePubHex: bytesToHex(device.publicKey),
    platformClass: null,
    createdAt: issuedAt,
    lastSeenAt: issuedAt,
    revokedAt: null,
  });
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: USERNAME,
    deviceId,
    devicePubKey: device.publicKey,
    scopes: opts.scopes,
    issuedAt,
    expiresAt,
  };
  const sig = signDeviceCapabilityGrant(grant, harryIrk);
  const r = await handleMintDeviceGrant(
    {
      storage: storage.deviceCapabilityGrants,
      identities: storage.deviceIdentities,
      usernames: storage.usernames,
    },
    {
      grant: {
        grantId,
        username: USERNAME,
        deviceId: grant.deviceId,
        devicePubKey: bytesToHex(device.publicKey),
        scopes: opts.scopes,
        issuedAt,
        expiresAt,
      },
      signature: bytesToHex(sig),
    },
  );
  expect(r.status).toBe(200);
  return grantId;
}

/** A ServerRevocation body signed by `signer` (a device key), carrying
 *  `signerPubHex`. */
function deviceRevokeBody(signer: Keypair, overrides: Partial<ServerRevocation> = {}) {
  const claim: ServerRevocation = {
    userId: USERNAME,
    revokedServerId: DOMAIN,
    reason: "decommissioned",
    issuedAt: Date.now(),
    ...overrides,
  };
  const sig = signRevocation(claim, signer);
  return {
    request: {
      userId: claim.userId,
      revokedServerId: claim.revokedServerId,
      reason: claim.reason,
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(sig),
    signerPubHex: bytesToHex(signer.publicKey),
  };
}

describe("POST /api/server-registry/revoke — device-authorized path (signerPubHex)", () => {
  it("owner legacy path (no signerPubHex) still returns 200 — unchanged", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    // grants wired, but the body omits signerPubHex → owner-IRK path.
    const { body } = revokeBody();
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(200);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);
  });

  it("owner IRK presented as a device signer is rejected without an active device grant", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const body = deviceRevokeBody(harryIrk);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("device WITH an active revoke-others grant → 200", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["browse", "revoke-others"] });

    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(200);
    expect((r.body as { reason: string }).reason).toBe("decommissioned");
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);

    // Audit row landed under the user.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.find((e) => e.eventKind === "server-revoked")).toBeDefined();
  });

  it("device WITH the admin superset grant (no explicit revoke-others) → 200", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["admin"] });

    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(200);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);
  });

  it("device WITHOUT a grant → 403, server untouched", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey(); // never granted anything

    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/not authorized/i);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
    // No audit row.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.find((e) => e.eventKind === "server-revoked")).toBeUndefined();
  });

  it("device with a grant lacking revoke-others/admin (e.g. browse only) → 403", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["browse", "install-service"] });

    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("device whose grant was REVOKED → 403", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    const grantId = await mintDeviceGrant(storage, device, {
      scopes: ["revoke-others"],
    });
    // Revoke the grant (mirrors handleRevokeDeviceGrant's effect on the row).
    await storage.deviceCapabilityGrants.revoke(grantId, Date.now());

    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("device with an EXPIRED grant → 403", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    const mintAt = Date.now();
    // Mint a grant that is valid NOW (the mint handler rejects an
    // already-expired grant) but expires shortly after.
    await mintDeviceGrant(storage, device, {
      scopes: ["revoke-others"],
      issuedAt: mintAt,
      expiresAt: mintAt + 5_000,
    });

    // Advance the handler's clock past the grant's expiry. The same clock
    // must drive BOTH the replay window (deps.now) AND requireDeviceScope's
    // expiry check (deps.grants.now), and the revocation issuedAt must sit
    // inside the replay window relative to that clock.
    const later = mintAt + 10_000;
    const grantsDeps = {
      storage: storage.deviceCapabilityGrants,
      identities: storage.deviceIdentities,
      usernames: storage.usernames,
      now: () => later,
    };
    const body = deviceRevokeBody(device, { issuedAt: later });
    const r = await handleRevokeServer(
      { ...deps(storage), grants: grantsDeps, now: () => later },
      body,
    );
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("forged signerPubHex (envelope signed by a DIFFERENT key) → 403 invalid signature", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["revoke-others"] });

    // Build a body claiming the granted device's pubkey but sign it with a
    // DIFFERENT key (the attacker has the granted pubkey but not its private
    // half). The sig check under signerPubHex must fail BEFORE any grant
    // lookup matters.
    const attacker = makeKey();
    const claim: ServerRevocation = {
      userId: USERNAME,
      revokedServerId: DOMAIN,
      reason: "decommissioned",
      issuedAt: Date.now(),
    };
    const sig = signRevocation(claim, attacker);
    const body = {
      request: {
        userId: claim.userId,
        revokedServerId: claim.revokedServerId,
        reason: claim.reason,
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
      signerPubHex: bytesToHex(device.publicKey), // forged — not attacker's key
    };
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/signature/i);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("malformed signerPubHex (not 32-byte hex) → 400", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["revoke-others"] });
    const body = { ...deviceRevokeBody(device), signerPubHex: "deadbeef" };
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/signerPubHex/i);
  });

  it("signerPubHex present but grants dep NOT wired → 403 (fail-closed, no owner fallback)", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    const device = makeKey();
    await mintDeviceGrant(storage, device, { scopes: ["revoke-others"] });
    // deps() omits `grants`.
    const body = deviceRevokeBody(device);
    const r = await handleRevokeServer(deps(storage), body);
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });

  it("device grant for the WRONG user does not authorize (requireDeviceScope username check)", async () => {
    const storage = await setUpClaimedHarry();
    await seedServer(storage);
    // Claim a second user 'bob' and grant bob's device revoke-others under bob.
    const bobUmk = { seed: new Uint8Array(32).fill(77) };
    const bobIrk = deriveIRK(bobUmk);
    await handleUsernameClaim(
      { storage: storage.usernames },
      {
        request: {
          username: "bob",
          irkPub: bytesToHex(bobIrk.publicKey),
          issuedAt: Date.now(),
        },
        signature: bytesToHex(
          signClaimUsername(
            { username: "bob", irkPub: bobIrk.publicKey, issuedAt: Date.now() },
            bobIrk,
          ),
        ),
      },
    );
    const bobDevice = makeKey();
    const grant: DeviceCapabilityGrant = {
      grantId: "bob-grant",
      username: "bob",
      deviceId: bytesToHex(bobDevice.publicKey.slice(0, 16)),
      devicePubKey: bobDevice.publicKey,
      scopes: ["revoke-others"],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 3_600_000,
    };
    await handleMintDeviceGrant(
      {
        storage: storage.deviceCapabilityGrants,
        identities: storage.deviceIdentities,
        usernames: storage.usernames,
      },
      {
        grant: {
          grantId: grant.grantId,
          username: "bob",
          deviceId: grant.deviceId,
          devicePubKey: bytesToHex(bobDevice.publicKey),
          scopes: ["revoke-others"],
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
        },
        signature: bytesToHex(signDeviceCapabilityGrant(grant, bobIrk)),
      },
    );

    // bob's device signs a revocation of harry's server (userId=harry).
    const body = deviceRevokeBody(bobDevice);
    const r = await handleRevokeServer(depsWithGrants(storage), body);
    expect(r.status).toBe(403);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeUndefined();
  });
});
