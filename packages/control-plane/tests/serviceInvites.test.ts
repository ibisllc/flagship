/**
 * .com service-access capability-invite handlers (docs/service-access-gating.md).
 *
 * Exercises the full create / redeem / revoke / list surface against the
 * InMemory storage with REAL signatures: create + revoke are author-IRK-signed
 * and gated on the username's registered IRK; redeem is friend-AID-signed and
 * runs the first-bind / same-AID-idempotent / reject-different-AID path.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleCreateServiceInvite,
  handleRedeemServiceInvite,
  handleRevokeServiceInvite,
  handleListServiceInvites,
} from "../src/serviceInvites.js";

const NOW = 1_770_000_000_000;

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const authorUmk = { seed: new Uint8Array(32).fill(11) };
const friendUmk = { seed: new Uint8Array(32).fill(22) };
const authorIrk = deriveIRK(authorUmk);
const authorAid = deriveAccountId(authorUmk);
const authorDevice = deriveIRK(authorUmk);
const friendAid = deriveAccountId(friendUmk);
const householdKey = deriveHouseholdKey(authorUmk);

const SECRET = new Uint8Array(32).fill(7);
const SECRET_HASH = serviceInviteSecretHash(SECRET);

async function freshDeps() {
  const storage = new InMemoryStorage();
  // Register the author's account so create/revoke can gate on its IRK.
  await storage.usernames.put({
    username: "alice",
    irkPubHex: hex(authorIrk.publicKey),
    claimedAt: 1,
  });
  return { invites: storage.serviceInvites, usernames: storage.usernames, now: () => NOW };
}

function createEnvelope(overrides: Partial<CreateServiceInvite> = {}) {
  const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: authorAid.publicKey,
    serviceRef: "alice-notes",
    secretHash: SECRET_HASH,
    encryptedBundle: sealInviteBundle({ name: "Alex" }, householdKey, inviteId),
    issuedAt: NOW,
    ...overrides,
  };
  const sig = signCreateServiceInvite(create, authorIrk);
  return {
    create,
    body: {
      request: {
        inviteId: create.inviteId,
        authorAID: hex(create.authorAID),
        serviceRef: create.serviceRef,
        secretHash: create.secretHash,
        encryptedBundle: create.encryptedBundle,
        issuedAt: create.issuedAt,
      },
      signature: hex(sig),
    },
  };
}

function redeemBody(aid = friendAid, signer = friendAid, at = NOW) {
  const redeem: RedeemServiceInvite = {
    secretHash: SECRET_HASH,
    visitorAID: aid.publicKey,
    redeemedAt: at,
  };
  const sig = signRedeemServiceInvite(redeem, signer);
  return {
    secretHash: redeem.secretHash,
    visitorAID: hex(redeem.visitorAID),
    aidSig: hex(sig),
    redeemedAt: redeem.redeemedAt,
  };
}

function revokeBody(inviteId: string, at = NOW) {
  const revoke: RevokeServiceInvite = { inviteId, issuedAt: at };
  const sig = signRevokeServiceInvite(revoke, authorIrk);
  return { request: { inviteId, issuedAt: at }, signature: hex(sig) };
}

describe("handleCreateServiceInvite", () => {
  it("creates an invite with a valid author-IRK signature", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(200);
    expect((res.body as { created: boolean }).created).toBe(true);
    expect(await deps.invites.get(body.request.inviteId)).toBeDefined();
  });

  it("rejects a bad signature (403)", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    body.signature = "00".repeat(64);
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(403);
  });

  it("rejects a signature from a non-account IRK (403)", async () => {
    const deps = await freshDeps();
    const { create } = createEnvelope();
    const stranger = deriveIRK(friendUmk);
    const sig = signCreateServiceInvite(create, stranger);
    const body = {
      request: {
        inviteId: create.inviteId,
        authorAID: hex(create.authorAID),
        serviceRef: create.serviceRef,
        secretHash: create.secretHash,
        encryptedBundle: create.encryptedBundle,
        issuedAt: create.issuedAt,
      },
      signature: hex(sig),
    };
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(403);
  });

  it("rejects a stale request (403)", async () => {
    const deps = await freshDeps();
    const { create } = createEnvelope({ issuedAt: NOW - 10 * 60_000 });
    const sig = signCreateServiceInvite(create, authorIrk);
    const body = {
      request: {
        inviteId: create.inviteId,
        authorAID: hex(create.authorAID),
        serviceRef: create.serviceRef,
        secretHash: create.secretHash,
        encryptedBundle: create.encryptedBundle,
        issuedAt: create.issuedAt,
      },
      signature: hex(sig),
    };
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(403);
  });

  it("404s for an unregistered username", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    const res = await handleCreateServiceInvite(deps, "nobody", body);
    expect(res.status).toBe(404);
  });

  it("409 on a duplicate inviteId clash (different secret)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    // same id, different serviceRef + secret → must re-sign to a valid sig
    const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
    const create: CreateServiceInvite = {
      inviteId,
      authorAID: authorAid.publicKey,
      serviceRef: "alice-secret",
      secretHash: serviceInviteSecretHash(new Uint8Array(32).fill(8)),
      encryptedBundle: sealInviteBundle({ name: "X" }, householdKey, inviteId),
      issuedAt: NOW,
    };
    const body = {
      request: {
        inviteId,
        authorAID: hex(create.authorAID),
        serviceRef: create.serviceRef,
        secretHash: create.secretHash,
        encryptedBundle: create.encryptedBundle,
        issuedAt: create.issuedAt,
      },
      signature: hex(signCreateServiceInvite(create, authorIrk)),
    };
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(409);
  });

  it("rejects a malformed body (400)", async () => {
    const deps = await freshDeps();
    const res = await handleCreateServiceInvite(deps, "alice", { request: {}, signature: "x" });
    expect(res.status).toBe(400);
  });
});

describe("handleRedeemServiceInvite", () => {
  it("first redeem binds the friend AID + returns the bundle ciphertext", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);

    const res = await handleRedeemServiceInvite(deps, redeemBody());
    expect(res.status).toBe(200);
    const b = res.body as {
      firstBind: boolean;
      serviceRef: string;
      boundAID: string;
      encryptedBundle: string;
    };
    expect(b.firstBind).toBe(true);
    expect(b.serviceRef).toBe("alice-notes");
    expect(b.boundAID).toBe(hex(friendAid.publicKey));
    expect(b.encryptedBundle).toBe(body.request.encryptedBundle);
  });

  it("re-redeem by the SAME AID is idempotent (firstBind:false)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    await handleRedeemServiceInvite(deps, redeemBody());
    const again = await handleRedeemServiceInvite(deps, redeemBody(friendAid, friendAid, NOW + 1000));
    expect(again.status).toBe(200);
    expect((again.body as { firstBind: boolean }).firstBind).toBe(false);
  });

  it("redeem by a DIFFERENT AID after binding is 409", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    await handleRedeemServiceInvite(deps, redeemBody());
    const other = deriveAccountId({ seed: new Uint8Array(32).fill(33) });
    const res = await handleRedeemServiceInvite(deps, redeemBody(other, other));
    expect(res.status).toBe(409);
  });

  it("rejects a redeem whose AID sig is by a DIFFERENT key (forged visitorAID, 403)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    // claim the friend's visitorAID but sign with an attacker's AID
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(99) });
    const res = await handleRedeemServiceInvite(deps, redeemBody(friendAid, attacker));
    expect(res.status).toBe(403);
  });

  it("404s for an unknown secret", async () => {
    const deps = await freshDeps();
    const body = redeemBody();
    body.secretHash = "ff".repeat(32);
    // re-sign over the new secretHash so the AID sig is internally valid
    const redeem: RedeemServiceInvite = {
      secretHash: body.secretHash,
      visitorAID: friendAid.publicKey,
      redeemedAt: NOW,
    };
    body.aidSig = hex(signRedeemServiceInvite(redeem, friendAid));
    const res = await handleRedeemServiceInvite(deps, body);
    expect(res.status).toBe(404);
  });
});

describe("handleRevokeServiceInvite + denial", () => {
  it("revokes a created invite then denies its redeem", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);

    const rev = await handleRevokeServiceInvite(deps, "alice", revokeBody(body.request.inviteId));
    expect(rev.status).toBe(200);

    const denied = await handleRedeemServiceInvite(deps, redeemBody());
    expect(denied.status).toBe(403);
  });

  it("revoke AFTER a bind denies the same AID's re-redeem", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);
    await handleRedeemServiceInvite(deps, redeemBody());

    await handleRevokeServiceInvite(deps, "alice", revokeBody(body.request.inviteId));
    const denied = await handleRedeemServiceInvite(deps, redeemBody(friendAid, friendAid, NOW + 1000));
    expect(denied.status).toBe(403);
  });

  it("rejects revoke with a bad IRK signature (403)", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);
    const rb = revokeBody(body.request.inviteId);
    rb.signature = "00".repeat(64);
    const res = await handleRevokeServiceInvite(deps, "alice", rb);
    expect(res.status).toBe(403);
  });

  it("404s revoke of an unknown invite", async () => {
    const deps = await freshDeps();
    const res = await handleRevokeServiceInvite(deps, "alice", revokeBody("nope"));
    expect(res.status).toBe(404);
  });
});

describe("handleListServiceInvites", () => {
  it("lists an author's invites (metadata only — no secret)", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);
    const res = await handleListServiceInvites(deps, "alice", hex(authorAid.publicKey));
    expect(res.status).toBe(200);
    const invites = (res.body as { invites: unknown[] }).invites;
    expect(invites).toHaveLength(1);
    expect(JSON.stringify(invites)).not.toContain(hex(SECRET));
  });

  it("requires an authorAID query param (400)", async () => {
    const deps = await freshDeps();
    const res = await handleListServiceInvites(deps, "alice", null);
    expect(res.status).toBe(400);
  });
});
