import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRoutingReplayRing,
  handleRegisterRck,
} from "../src/routing.js";
import { handleServerReleaseName } from "../src/serverRevoke.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import {
  deriveIRK,
  ed,
  signClaimUsername,
  signRegisterRck,
  signReleaseServerName,
  type RegisterRck,
  type ReleaseServerName,
} from "@flagship/protocol";
import { InMemoryStorage, type AuthCodeRecord } from "@flagship/storage";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function freshKeypair(seed = 0) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

async function setUpClaimedHarry() {
  const storage = new InMemoryStorage();
  const claim = { username: "harry", irkPub: harryIrk.publicKey, issuedAt: Date.now() };
  const sig = signClaimUsername(claim, harryIrk);
  await handleUsernameClaim(
    { storage: storage.usernames },
    {
      request: {
        username: "harry",
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
  return storage;
}

const DOMAIN = "home.harry.flagship.services";

/** Register an RCK so the routing record exists (this is what "loses" the
 *  name after a failed install). */
async function seedRouting(storage: InMemoryStorage, rckSeed: number) {
  const rck = freshKeypair(rckSeed);
  const claim: RegisterRck = {
    username: "harry",
    subdomain: DOMAIN,
    rckPubKey: rck.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signRegisterRck(claim, harryIrk);
  const r = await handleRegisterRck(
    { routing: storage.routing, usernames: storage.usernames },
    {
      request: {
        username: claim.username,
        subdomain: claim.subdomain,
        rckPubKey: bytesToHex(claim.rckPubKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
  return { status: r.status, rck };
}

function activeAuthCode(serial: string): AuthCodeRecord {
  return {
    serial,
    username: "harry",
    serverName: "home",
    serverDomain: DOMAIN,
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: bytesToHex(harryIrk.publicKey),
    userSignatureHex: "00".repeat(64),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    status: "active",
    recordedAt: Date.now(),
  };
}

function releaseBody(irk = harryIrk, overrides: Partial<ReleaseServerName> = {}) {
  const claim: ReleaseServerName = {
    username: "harry",
    serverDomain: DOMAIN,
    issuedAt: Date.now(),
    ...overrides,
  };
  const sig = signReleaseServerName(claim, irk);
  return {
    body: {
      request: {
        username: claim.username,
        serverDomain: claim.serverDomain,
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
    routing: storage.routing,
    authCodes: storage.authCodes,
    servers: storage.servers,
    luksKeys: storage.luksKeys,
  };
}

beforeEach(() => __resetRoutingReplayRing());

describe("POST /api/server/release (cancel the server / free the name)", () => {
  it("releases the routing record, active auth-codes, and the server record", async () => {
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    await storage.authCodes.put(activeAuthCode("AC1"));
    await storage.authCodes.put(activeAuthCode("AC2"));
    await storage.servers.put({
      serverDomain: DOMAIN,
      username: "harry",
      identityPubKeyHex: "11".repeat(32),
      registeredAt: Date.now(),
    });

    const { body } = releaseBody();
    const r = await handleServerReleaseName(deps(storage), body);

    expect(r.status).toBe(200);
    const out = r.body as { authCodesRevoked: number; serverRevoked: boolean; routingReleased: boolean };
    expect(out.routingReleased).toBe(true);
    expect(out.authCodesRevoked).toBe(2);
    expect(out.serverRevoked).toBe(true);

    // Routing record is gone → the name is free again.
    expect(await storage.routing.get(DOMAIN)).toBeUndefined();
    // Both auth-codes are now revoked.
    expect((await storage.authCodes.get("AC1"))?.status).toBe("revoked");
    expect((await storage.authCodes.get("AC2"))?.status).toBe("revoked");
    // Server record is revoked.
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);
  });

  it("frees the name end-to-end: a fresh RCK can re-register after release", async () => {
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);

    // Sanity: a DIFFERENT RCK is blocked before release (the bug).
    const blocked = await seedRouting(storage, 2);
    expect(blocked.status).toBe(409);

    // Release the name.
    const { body } = releaseBody();
    expect((await handleServerReleaseName(deps(storage), body)).status).toBe(200);

    // Now a fresh RCK registers cleanly — the name was genuinely freed.
    const after = await seedRouting(storage, 3);
    expect(after.status).toBe(200);
    expect((await storage.routing.get(DOMAIN))?.rckPubKeyHex).toBe(
      bytesToHex(after.rck.publicKey),
    );
  });

  it("403 when signed by a different IRK than the registered one", async () => {
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    const { body } = releaseBody(malloryIrk);
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(403);
    // The name is untouched — an attacker cannot free someone else's name.
    expect(await storage.routing.get(DOMAIN)).toBeDefined();
  });

  it("400 when serverDomain is not under the signing username's namespace", async () => {
    const storage = await setUpClaimedHarry();
    // Mallory's-style domain, signed by harry → namespace mismatch.
    const { body } = releaseBody(harryIrk, {
      serverDomain: "home.mallory.flagship.services",
    });
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(400);
  });

  it("400 when the server label has a leading/trailing hyphen (RFC-1123 DNS label)", async () => {
    // Server names are a looser RFC-1123 DNS label than usernames:
    // interior hyphens are fine, but leading/trailing ones are not.
    const storage = await setUpClaimedHarry();
    const { body } = releaseBody(harryIrk, {
      serverDomain: "-home.harry.flagship.services",
    });
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(400);
  });

  it("does NOT reject an interior-hyphen server label on shape (looser than usernames)", async () => {
    // `media-server` is a valid server name. It isn't claimed here, so the
    // release fails for a DIFFERENT reason (name not under control) — the
    // point is the 400 is NOT a label-shape rejection.
    const storage = await setUpClaimedHarry();
    const { body } = releaseBody(harryIrk, {
      serverDomain: "media-server.harry.flagship.services",
    });
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.body?.error ?? "").not.toMatch(/server name must be|DNS label/i);
  });

  it("403 on a stale request", async () => {
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    const { body } = releaseBody(harryIrk, { issuedAt: Date.now() - 10 * 60_000 });
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(403);
  });

  it("404 when the username isn't registered", async () => {
    const storage = new InMemoryStorage(); // no claim
    const { body } = releaseBody();
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(404);
  });

  it("is idempotent: releasing an already-free name returns 200 with zero counts", async () => {
    const storage = await setUpClaimedHarry();
    // No routing / auth-codes / server seeded.
    const { body } = releaseBody();
    const r = await handleServerReleaseName(deps(storage), body);
    expect(r.status).toBe(200);
    const out = r.body as { authCodesRevoked: number; serverRevoked: boolean };
    expect(out.authCodesRevoked).toBe(0);
    expect(out.serverRevoked).toBe(false);
  });

  it("400 on a malformed body", async () => {
    const storage = await setUpClaimedHarry();
    const r = await handleServerReleaseName(deps(storage), { request: {} });
    expect(r.status).toBe(400);
  });

  // Decommission / delete-a-failed-server: the two shapes the phone deletes.

  it("decommissions a PENDING order: revokes the auth-code + frees the name (no server record)", async () => {
    // A pending order has a routing reservation + an active auth-code, but the
    // box never registered, so there's NO server record. Release must still
    // revoke the code + free the name, and serverRevoked is false (not an error).
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    await storage.authCodes.put(activeAuthCode("PENDING1"));

    const { body } = releaseBody();
    const r = await handleServerReleaseName(deps(storage), body);

    expect(r.status).toBe(200);
    const out = r.body as { authCodesRevoked: number; serverRevoked: boolean; routingReleased: boolean };
    expect(out.routingReleased).toBe(true);
    expect(out.authCodesRevoked).toBe(1);
    expect(out.serverRevoked).toBe(false);
    // The auth-code is dead → register rejects it (mid-install-safe; no resurrection).
    expect((await storage.authCodes.get("PENDING1"))?.status).toBe("revoked");
    expect(await storage.routing.get(DOMAIN)).toBeUndefined();
  });

  it("decommissions a REGISTERED-DEAD server: revokes the record + clears the sealed LUKS blob", async () => {
    // A box that registered during install but never came online: it has a
    // server record (and a sealed LUKS blob from the seal step) but no live
    // daemon. Release revokes the record + frees the name + clears the blob so
    // a reused name starts clean.
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    await storage.authCodes.put(activeAuthCode("DEAD1"));
    await storage.servers.put({
      serverDomain: DOMAIN,
      username: "harry",
      identityPubKeyHex: "22".repeat(32),
      registeredAt: Date.now(),
    });
    await storage.luksKeys.putSealed({
      serverDomain: DOMAIN,
      sealedKeyHex: "ab".repeat(48),
      sealedAt: Date.now(),
    });

    const { body } = releaseBody();
    const r = await handleServerReleaseName(deps(storage), body);

    expect(r.status).toBe(200);
    const out = r.body as { authCodesRevoked: number; serverRevoked: boolean };
    expect(out.authCodesRevoked).toBe(1);
    expect(out.serverRevoked).toBe(true);
    expect((await storage.servers.get(DOMAIN))?.revokedAt).toBeGreaterThan(0);
    // Sealed material is gone — a reused name doesn't inherit a stale blob.
    expect(await storage.luksKeys.getSealed(DOMAIN)).toBeUndefined();
  });

  it("stays idempotent + safe without the optional luksKeys dep", async () => {
    // Existing callers that don't wire luksKeys must behave exactly as before.
    const storage = await setUpClaimedHarry();
    await seedRouting(storage, 1);
    const { body } = releaseBody();
    const r = await handleServerReleaseName(
      {
        usernames: storage.usernames,
        routing: storage.routing,
        authCodes: storage.authCodes,
        servers: storage.servers,
      },
      body,
    );
    expect(r.status).toBe(200);
  });
});
