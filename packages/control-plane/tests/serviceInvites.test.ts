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
  signServiceInviteCreateQuery,
  signServiceInviteListQuery,
  type CreateServiceInvite,
  type Keypair,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type ServiceInviteCreateQuery,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleCreateServiceInvite,
  handleFetchServiceInviteCreate,
  handleRedeemServiceInvite,
  handleRevokeServiceInvite,
  handleListServiceInvites,
  handleRevokedSinceServiceInvites,
  type ServiceInviteCreateFetchAuth,
  type ServiceInviteListAuth,
} from "../src/serviceInvites.js";

const NOW = 1_770_000_000_000;

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
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

/** Deps where the account also has a registered AID (dual-accept testing). */
async function freshDepsWithAid() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: "alice",
    irkPubHex: hex(authorIrk.publicKey),
    claimedAt: 1,
    aidPubHex: hex(authorAid.publicKey),
  });
  return { invites: storage.serviceInvites, usernames: storage.usernames, now: () => NOW };
}

/** A signed list/revoked-since query as URL-param strings (mirrors the route). */
function listAuth(
  scope: "list" | "revoked-since",
  signer: Keypair,
  opts: { cursor?: number; issuedAt?: number; authorAID?: Uint8Array } = {},
): ServiceInviteListAuth {
  const query: ServiceInviteListQuery = {
    username: "alice",
    authorAID: hex(opts.authorAID ?? authorAid.publicKey),
    scope,
    cursor: scope === "list" ? 0 : opts.cursor ?? 0,
    issuedAt: opts.issuedAt ?? NOW,
  };
  const sig = signServiceInviteListQuery(query, signer);
  return {
    authorAID: query.authorAID,
    scope: query.scope,
    cursor: String(query.cursor),
    issuedAt: String(query.issuedAt),
    sig: hex(sig),
  };
}

function createEnvelope(
  overrides: Partial<CreateServiceInvite> = {},
  opts: { signer?: Keypair; approvalMode?: "auto" | "manual" } = {},
) {
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
  const sig = signCreateServiceInvite(create, opts.signer ?? authorIrk);
  const request: Record<string, unknown> = {
    inviteId: create.inviteId,
    authorAID: hex(create.authorAID),
    serviceRef: create.serviceRef,
    secretHash: create.secretHash,
    encryptedBundle: create.encryptedBundle,
    issuedAt: create.issuedAt,
  };
  // v2 fields ride the request when set (maxRedemptions/expiresAt are in the
  // signed canonical bytes; approvalMode is an out-of-band policy field).
  if (create.maxRedemptions !== undefined) request.maxRedemptions = create.maxRedemptions;
  if (create.expiresAt !== undefined) request.expiresAt = create.expiresAt;
  if (opts.approvalMode !== undefined) request.approvalMode = opts.approvalMode;
  return { create, body: { request, signature: hex(sig) } };
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
      approvalMode: string;
      serviceRef: string;
      boundAID: string;
      encryptedBundle: string;
      create: { inviteId: string; serviceRef: string; secretHash: string; issuedAt: number };
      createSig: string;
    };
    expect(b.firstBind).toBe(true);
    expect(b.approvalMode).toBe("auto");
    expect(b.serviceRef).toBe("alice-notes");
    expect(b.boundAID).toBe(hex(friendAid.publicKey));
    expect(b.encryptedBundle).toBe(body.request.encryptedBundle);
    // v2 box-as-authority: the redeem hands the box the signed create so it can
    // verify the owner's authority itself (the create + sig round-trip exactly).
    expect(b.create.inviteId).toBe(body.request.inviteId);
    expect(b.create.serviceRef).toBe("alice-notes");
    expect(b.create.secretHash).toBe(SECRET_HASH);
    expect(b.create.issuedAt).toBe(NOW);
    expect(b.createSig).toBe(body.signature);
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

describe("handleListServiceInvites (owner-signed — v2 §C2)", () => {
  it("lists an author's invites for a valid IRK-signed query (metadata only)", async () => {
    const deps = await freshDeps();
    const { body } = createEnvelope();
    await handleCreateServiceInvite(deps, "alice", body);
    const res = await handleListServiceInvites(deps, "alice", listAuth("list", authorIrk));
    expect(res.status).toBe(200);
    const invites = (res.body as { invites: unknown[] }).invites;
    expect(invites).toHaveLength(1);
    expect(JSON.stringify(invites)).not.toContain(hex(SECRET));
  });

  it("accepts an AID-signed query (dual-accept) when the AID is registered", async () => {
    const deps = await freshDepsWithAid();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    const res = await handleListServiceInvites(deps, "alice", listAuth("list", authorAid));
    expect(res.status).toBe(200);
    expect((res.body as { invites: unknown[] }).invites).toHaveLength(1);
  });

  it("rejects an UNSIGNED list (no sig) — closes the open graph dump (400)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    const res = await handleListServiceInvites(deps, "alice", {
      authorAID: hex(authorAid.publicKey),
      scope: "list",
      cursor: "0",
      issuedAt: String(NOW),
      sig: null,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a query signed by a STRANGER key (403)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    const stranger = deriveIRK(friendUmk);
    const res = await handleListServiceInvites(deps, "alice", listAuth("list", stranger));
    expect(res.status).toBe(403);
  });

  it("rejects a stale signed query (403)", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    const res = await handleListServiceInvites(
      deps,
      "alice",
      listAuth("list", authorIrk, { issuedAt: NOW - 10 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });
});

describe("v2 — create persists caps + redeem enforces them", () => {
  it("create persists the signature + maxN/expiry/approvalMode", async () => {
    const deps = await freshDeps();
    const { body, create } = createEnvelope({ maxRedemptions: 3, expiresAt: NOW + 60_000 }, {
      approvalMode: "manual",
    });
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(200);
    const rec = (await deps.invites.get(create.inviteId))!;
    expect(rec.createSig).toBe(body.signature);
    expect(rec.createIssuedAt).toBe(NOW);
    expect(rec.maxRedemptions).toBe(3);
    expect(rec.expiresAt).toBe(NOW + 60_000);
    expect(rec.approvalMode).toBe("manual");
  });

  it("a GROUP invite binds multiple AIDs up to maxN then 409s 'invite is full'", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope({ maxRedemptions: 2 }).body);
    const a = await handleRedeemServiceInvite(deps, redeemBody(friendAid, friendAid));
    const other = deriveAccountId({ seed: new Uint8Array(32).fill(44) });
    const b = await handleRedeemServiceInvite(deps, redeemBody(other, other));
    const third = deriveAccountId({ seed: new Uint8Array(32).fill(55) });
    const c = await handleRedeemServiceInvite(deps, redeemBody(third, third));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(409);
  });

  it("an expired invite is gone (410) on redeem", async () => {
    const deps = await freshDeps();
    await handleCreateServiceInvite(deps, "alice", createEnvelope({ expiresAt: NOW - 1 }).body);
    const res = await handleRedeemServiceInvite(deps, redeemBody());
    expect(res.status).toBe(410);
  });

  it("MANUAL-approve redeem returns {pending} with NO bind", async () => {
    const deps = await freshDeps();
    const { body, create } = createEnvelope({}, { approvalMode: "manual" });
    await handleCreateServiceInvite(deps, "alice", body);
    const res = await handleRedeemServiceInvite(deps, redeemBody());
    expect(res.status).toBe(200);
    const b = res.body as { pending: boolean; approvalMode: string; createSig: string };
    expect(b.pending).toBe(true);
    expect(b.approvalMode).toBe("manual");
    expect(b.createSig).toBe(body.signature);
    // No bind happened.
    expect((await deps.invites.get(create.inviteId))!.boundAID).toBeNull();
  });

  it("create accepts an AID-signed envelope (dual-accept) when the AID is registered", async () => {
    const deps = await freshDepsWithAid();
    const { body } = createEnvelope({}, { signer: authorAid });
    const res = await handleCreateServiceInvite(deps, "alice", body);
    expect(res.status).toBe(200);
  });
});

describe("handleRevokedSinceServiceInvites (owner-signed poller)", () => {
  it("returns revoked invites + bound AIDs after the cursor; advances the cursor", async () => {
    const deps = await freshDeps();
    const { body, create } = createEnvelope({ maxRedemptions: 5 });
    await handleCreateServiceInvite(deps, "alice", body);
    await handleRedeemServiceInvite(deps, redeemBody(friendAid, friendAid));
    await handleRevokeServiceInvite(deps, "alice", revokeBody(create.inviteId));
    const res = await handleRevokedSinceServiceInvites(deps, "alice", listAuth("revoked-since", authorIrk));
    expect(res.status).toBe(200);
    const b = res.body as {
      revoked: { inviteId: string; serviceRef: string; boundAIDs: string[]; revokedAt: number }[];
      cursor: number;
    };
    expect(b.revoked).toHaveLength(1);
    expect(b.revoked[0]!.inviteId).toBe(create.inviteId);
    expect(b.revoked[0]!.boundAIDs).toEqual([hex(friendAid.publicKey)]);
    expect(b.cursor).toBe(NOW);
    // cursor at NOW excludes the just-revoked row
    const after = await handleRevokedSinceServiceInvites(
      deps,
      "alice",
      listAuth("revoked-since", authorIrk, { cursor: NOW }),
    );
    expect((after.body as { revoked: unknown[] }).revoked).toHaveLength(0);
  });

  it("rejects a poller query signed by a stranger (403)", async () => {
    const deps = await freshDeps();
    const stranger = deriveIRK(friendUmk);
    const res = await handleRevokedSinceServiceInvites(deps, "alice", listAuth("revoked-since", stranger));
    expect(res.status).toBe(403);
  });

  it("accepts a BOX STK-signed poll verified against the registered server", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    // Register a server for alice with a known STK identity pubkey.
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(123) });
    const serverDomain = "home.alice.flagship.services";
    await storage.servers.put({
      serverDomain,
      username: "alice",
      identityPubKeyHex: hex(stk.publicKey),
      registeredAt: 1,
    });
    const deps = {
      invites: storage.serviceInvites,
      usernames: storage.usernames,
      servers: storage.servers,
      now: () => NOW,
    };
    // Create + revoke an invite so revoked-since has a row.
    await handleCreateServiceInvite(deps, "alice", createEnvelope().body);
    const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
    await handleRevokeServiceInvite(deps, "alice", revokeBody(inviteId));
    // The box signs the query with its STK + presents serverDomain.
    const auth = { ...listAuth("revoked-since", stk), serverDomain };
    const res = await handleRevokedSinceServiceInvites(deps, "alice", auth);
    expect(res.status).toBe(200);
    expect((res.body as { revoked: unknown[] }).revoked).toHaveLength(1);
  });

  it("rejects a BOX STK-signed poll when the server belongs to a DIFFERENT user (403)", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(124) });
    const serverDomain = "home.bob.flagship.services";
    await storage.servers.put({
      serverDomain,
      username: "bob", // NOT alice
      identityPubKeyHex: hex(stk.publicKey),
      registeredAt: 1,
    });
    const deps = {
      invites: storage.serviceInvites,
      usernames: storage.usernames,
      servers: storage.servers,
      now: () => NOW,
    };
    const auth = { ...listAuth("revoked-since", stk), serverDomain };
    const res = await handleRevokedSinceServiceInvites(deps, "alice", auth);
    expect(res.status).toBe(403);
  });
});

describe("handleFetchServiceInviteCreate (box STK-signed, any-device finalize)", () => {
  const SERVER_DOMAIN = "home.alice.flagship.services";
  const INVITE_ID = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);

  /** alice + a registered server (STK identity) + one manual invite created. */
  async function depsWithServerAndInvite(stk: Keypair) {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    await storage.servers.put({
      serverDomain: SERVER_DOMAIN,
      username: "alice",
      identityPubKeyHex: hex(stk.publicKey),
      registeredAt: 1,
    });
    const deps = { invites: storage.serviceInvites, usernames: storage.usernames, servers: storage.servers, now: () => NOW };
    await handleCreateServiceInvite(deps, "alice", createEnvelope({}, { approvalMode: "manual" }).body);
    return deps;
  }

  /** A signed create-fetch query as URL-param strings (mirrors the route). */
  function fetchAuth(
    stk: Keypair,
    opts: { inviteId?: string; serverDomain?: string; issuedAt?: number } = {},
  ): ServiceInviteCreateFetchAuth {
    const query: ServiceInviteCreateQuery = {
      username: "alice",
      inviteId: (opts.inviteId ?? INVITE_ID).toLowerCase(),
      serverDomain: opts.serverDomain ?? SERVER_DOMAIN,
      issuedAt: opts.issuedAt ?? NOW,
    };
    return {
      serverDomain: query.serverDomain,
      issuedAt: String(query.issuedAt),
      sig: hex(signServiceInviteCreateQuery(query, stk)),
    };
  }

  it("returns {create, createSig} for a valid box STK-signed query", async () => {
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(200) });
    const deps = await depsWithServerAndInvite(stk);
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(stk));
    expect(res.status).toBe(200);
    const body = res.body as { create: { inviteId: string; serviceRef: string; secretHash: string; issuedAt: number }; createSig: string };
    expect(body.create.inviteId).toBe(INVITE_ID);
    expect(body.create.serviceRef).toBe("alice-notes");
    expect(body.create.secretHash).toBe(SECRET_HASH);
    expect(body.create.issuedAt).toBe(NOW);
    expect(body.createSig).toMatch(/^[0-9a-f]{128}$/);
  });

  it("the returned create + createSig verify as the owner's signed CreateServiceInvite", async () => {
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(201) });
    const deps = await depsWithServerAndInvite(stk);
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(stk));
    const body = res.body as { create: Record<string, unknown>; createSig: string };
    // Reconstruct the signed create + verify against the author's registered key.
    const create: CreateServiceInvite = {
      inviteId: body.create.inviteId as string,
      authorAID: hexBytes(body.create.authorAID as string),
      serviceRef: body.create.serviceRef as string,
      secretHash: body.create.secretHash as string,
      encryptedBundle: body.create.encryptedBundle as string,
      issuedAt: body.create.issuedAt as number,
    };
    const { verifyCreateServiceInvite } = await import("@flagship/protocol");
    expect(verifyCreateServiceInvite(create, hexBytes(body.createSig), authorIrk.publicKey)).toBe(true);
  });

  it("rejects (403) a query NOT signed by the registered server's STK", async () => {
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(202) });
    const deps = await depsWithServerAndInvite(stk);
    const wrong = deriveIRK({ seed: new Uint8Array(32).fill(203) });
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(wrong));
    expect(res.status).toBe(403);
  });

  it("rejects (403) when the server belongs to a DIFFERENT user", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(204) });
    await storage.servers.put({ serverDomain: "home.bob.flagship.services", username: "bob", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
    const deps = { invites: storage.serviceInvites, usernames: storage.usernames, servers: storage.servers, now: () => NOW };
    await handleCreateServiceInvite(deps, "alice", createEnvelope({}, { approvalMode: "manual" }).body);
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(stk, { serverDomain: "home.bob.flagship.services" }));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown inviteId", async () => {
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(205) });
    const deps = await depsWithServerAndInvite(stk);
    const otherId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 7);
    const res = await handleFetchServiceInviteCreate(deps, "alice", otherId, fetchAuth(stk, { inviteId: otherId }));
    expect(res.status).toBe(404);
  });

  it("rejects (403) a stale query", async () => {
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(206) });
    const deps = await depsWithServerAndInvite(stk);
    const stale = NOW - 10 * 60_000;
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(stk, { issuedAt: stale }));
    expect(res.status).toBe(403);
  });

  it("requires deps.servers (no STK path ⇒ 403)", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    const deps = { invites: storage.serviceInvites, usernames: storage.usernames, now: () => NOW };
    await handleCreateServiceInvite(deps, "alice", createEnvelope({}, { approvalMode: "manual" }).body);
    const stk = deriveIRK({ seed: new Uint8Array(32).fill(207) });
    const res = await handleFetchServiceInviteCreate(deps, "alice", INVITE_ID, fetchAuth(stk));
    expect(res.status).toBe(403);
  });
});
