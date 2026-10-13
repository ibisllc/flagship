/**
 * .com share relay (docs/share-a-server.md §6.2) end to end over InMemory
 * storage with real signatures: offer → read with the link token → accept →
 * owner list → unlock deposit → leave / revoke → ends for the box → inbox.
 */
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveShareInboxKey,
  deriveShareMemberKey,
  shareSha256Hex,
  shareTokenFromSecret,
  shareTokenHash,
  signServerShareLeave,
  signServerShareList,
  signServerShareOffer,
  signServerShareRevoke,
  signServerShareUnlock,
  signShareInboxRequest,
  SHARE_OFFER_TTL_MS,
  type Keypair,
  type ServerShareOffer,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleAcceptServerShare,
  handleCreateServerShare,
  handleGetServerShare,
  handleLeaveServerShare,
  handleListServerShares,
  handleRevokeServerShare,
  handleServerShareEnds,
  handleServerShareUnlock,
  handleShareInbox,
  SHARE_INBOX_CAP,
} from "../src/serverShares.js";

const NOW = 1_770_000_000_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const S = "home.alice.flagship.services";
const owner = deriveIRK({ seed: new Uint8Array(32).fill(11) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(99) });
const memberUmk = { seed: new Uint8Array(32).fill(22) };
const SHARE = "ab".repeat(16);
const member = deriveShareMemberKey(memberUmk, SHARE);
const secret = new Uint8Array(32).fill(7);
const token = shareTokenFromSecret(secret);
const OFFER_HEX = "01".repeat(40);
const OWNER_HEX = "02".repeat(40);

async function deps() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: "alice", irkPubHex: hex(owner.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: "cd".repeat(32), registeredAt: 1 });
  return {
    d: { shares: storage.serverShares, usernames: storage.usernames, servers: storage.servers, now: () => NOW },
    storage,
  };
}

function offerBody(over: Partial<ServerShareOffer> = {}, signer: Keypair = owner) {
  const offer: ServerShareOffer = {
    username: "alice",
    serverDomain: S,
    shareId: SHARE,
    tokenHash: shareTokenHash(token),
    offerSha256: shareSha256Hex(OFFER_HEX),
    ownerSha256: shareSha256Hex(OWNER_HEX),
    expiresAt: NOW + SHARE_OFFER_TTL_MS,
    issuedAt: NOW,
    ...over,
  };
  return { offer, signature: hex(signServerShareOffer(offer, signer)), offerHex: OFFER_HEX, ownerHex: OWNER_HEX };
}

async function offered() {
  const x = await deps();
  const r = await handleCreateServerShare(x.d, "alice", offerBody());
  expect(r.status).toBe(200);
  return x;
}

describe("offer", () => {
  it("stores an owner-signed offer", async () => {
    const { d } = await offered();
    const g = await handleGetServerShare(d, SHARE, token);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ shareId: SHARE, serverDomain: S, state: "offered", offer: OFFER_HEX, acceptance: null, unlock: false });
  });

  it("refuses a signer that isn't the owner, a stale or tampered offer, and someone else's server", async () => {
    const { d, storage } = await deps();
    expect((await handleCreateServerShare(d, "alice", offerBody({}, stranger))).status).toBe(403);
    expect((await handleCreateServerShare(d, "alice", offerBody({ issuedAt: NOW - 10 * 60_000 }))).status).toBe(403);
    expect((await handleCreateServerShare(d, "alice", { ...offerBody(), offerHex: "03".repeat(40) })).status).toBe(403);
    await storage.servers.put({ serverDomain: "x.bob.flagship.services", username: "bob", identityPubKeyHex: "ef".repeat(32), registeredAt: 1 });
    expect((await handleCreateServerShare(d, "alice", offerBody({ serverDomain: "x.bob.flagship.services" }))).status).toBe(404);
    expect((await handleCreateServerShare(d, "alice", offerBody({ username: "bob" }))).status).toBe(403);
  });

  it("refuses a reused share id", async () => {
    const { d } = await offered();
    expect((await handleCreateServerShare(d, "alice", offerBody())).status).toBe(409);
  });
});

describe("link token", () => {
  it("reads nothing without the right token", async () => {
    const { d } = await offered();
    expect((await handleGetServerShare(d, SHARE, null)).status).toBe(404);
    expect((await handleGetServerShare(d, SHARE, "00".repeat(32))).status).toBe(404);
  });

  it("takes one acceptance only", async () => {
    const { d } = await offered();
    expect((await handleAcceptServerShare(d, SHARE, token, { acceptance: "aa".repeat(30) })).status).toBe(200);
    expect((await handleAcceptServerShare(d, SHARE, token, { acceptance: "bb".repeat(30) })).status).toBe(409);
    expect((await handleAcceptServerShare(d, SHARE, "00".repeat(32), { acceptance: "bb" })).status).toBe(404);
    expect((await handleGetServerShare(d, SHARE, token)).body).toMatchObject({ state: "accepted", acceptance: "aa".repeat(30) });
  });

  it("expires an unaccepted link", async () => {
    const { d } = await offered();
    const later = { ...d, now: () => NOW + SHARE_OFFER_TTL_MS + 1 };
    expect((await handleGetServerShare(later, SHARE, token)).status).toBe(410);
    expect((await handleAcceptServerShare(later, SHARE, token, { acceptance: "aa" })).status).toBe(410);
  });
});

describe("owner list", () => {
  it("lists the owner's shares for an owner signature only", async () => {
    const { d } = await offered();
    const list = { username: "alice", issuedAt: NOW };
    const r = await handleListServerShares(d, "alice", { list, signature: hex(signServerShareList(list, owner)) });
    expect(r.status).toBe(200);
    expect((r.body as { shares: unknown[] }).shares).toHaveLength(1);
    expect((r.body as { shares: Array<{ owner: string }> }).shares[0]!.owner).toBe(OWNER_HEX);
    expect((await handleListServerShares(d, "alice", { list, signature: hex(signServerShareList(list, stranger)) })).status).toBe(403);
  });
});

describe("unlock at boot", () => {
  const sealed = "cd".repeat(80);
  const deposit = (issuedAt = NOW, sealedSha256 = shareSha256Hex(sealed)) => ({
    serverDomain: S,
    shareId: SHARE,
    memberPubHex: hex(member.publicKey),
    sealedSha256,
    issuedAt,
  });

  it("puts and withdraws the member's copy with the owner's signature", async () => {
    const { d, storage } = await offered();
    const u = deposit();
    expect((await handleServerShareUnlock(d, "alice", SHARE, { unlock: u, signature: hex(signServerShareUnlock(u, stranger)), sealedKey: sealed })).status).toBe(403);
    expect((await handleServerShareUnlock(d, "alice", SHARE, { unlock: u, signature: hex(signServerShareUnlock(u, owner)), sealedKey: "ee" })).status).toBe(403);
    expect((await handleServerShareUnlock(d, "alice", SHARE, { unlock: u, signature: hex(signServerShareUnlock(u, owner)), sealedKey: sealed })).status).toBe(200);
    expect(await storage.serverShares.unlockForMember(S, hex(member.publicKey))).toMatchObject({ sealedKeyHex: sealed });
    expect((await handleServerShareUnlock(d, "alice", SHARE, { unlock: u, signature: hex(signServerShareUnlock(u, owner)), sealedKey: sealed })).status).toBe(409);
    const off = deposit(NOW + 1, "off");
    expect((await handleServerShareUnlock(d, "alice", SHARE, { unlock: off, signature: hex(signServerShareUnlock(off, owner)) })).status).toBe(200);
    expect(await storage.serverShares.unlockForMember(S, hex(member.publicKey))).toBeNull();
  });
});

describe("ending a share", () => {
  it("lets the owner revoke and hands the signed revoke to the box", async () => {
    const { d } = await offered();
    const revoke = { serverDomain: S, shareId: SHARE, issuedAt: NOW };
    expect((await handleRevokeServerShare(d, "alice", SHARE, { revoke, signature: hex(signServerShareRevoke(revoke, stranger)) })).status).toBe(403);
    const sig = hex(signServerShareRevoke(revoke, owner));
    expect((await handleRevokeServerShare(d, "alice", SHARE, { revoke, signature: sig })).status).toBe(200);
    const ends = await handleServerShareEnds(d, S, 0);
    expect((ends.body as { ends: unknown[] }).ends).toEqual([{ shareId: SHARE, kind: "revoke", endedAt: NOW, revoke, signature: sig }]);
    expect((await handleGetServerShare(d, SHARE, token)).body).toMatchObject({ state: "ended", endKind: "revoke" });
    expect((await handleAcceptServerShare(d, SHARE, token, { acceptance: "aa" })).status).toBe(410);
  });

  it("lets the member leave with its per-share key and drops its boot copy", async () => {
    const { d, storage } = await offered();
    await storage.serverShares.putUnlock({ shareId: SHARE, serverDomain: S, memberPubHex: hex(member.publicKey), sealedKeyHex: "aa", depositJson: "{}", signatureHex: "bb", issuedAt: 1 });
    const leave = { serverDomain: S, shareId: SHARE, memberPubHex: hex(member.publicKey), issuedAt: NOW };
    const other = deriveShareMemberKey({ seed: new Uint8Array(32).fill(23) }, SHARE);
    const forged = { ...leave, memberPubHex: hex(other.publicKey) };
    expect((await handleLeaveServerShare(d, SHARE, token, { leave: forged, signature: hex(signServerShareLeave(forged, other)) })).status).toBe(403);
    expect((await handleLeaveServerShare(d, SHARE, null, { leave, signature: hex(signServerShareLeave(leave, member)) })).status).toBe(404);
    expect((await handleLeaveServerShare(d, SHARE, token, { leave, signature: hex(signServerShareLeave(leave, member)) })).status).toBe(200);
    expect(await storage.serverShares.getUnlock(SHARE)).toBeNull();
    expect(((await handleServerShareEnds(d, S, 0)).body as { ends: Array<{ kind: string }> }).ends[0]!.kind).toBe("leave");
  });
});

describe("inbox", () => {
  const inbox = deriveShareInboxKey(memberUmk);
  const pub = hex(inbox.publicKey);
  const req = (op: "put" | "list" | "delete", entryId: string, ct = "") => {
    const request = { inboxPubHex: pub, op, entryId, ctSha256: ct ? shareSha256Hex(ct) : "", issuedAt: NOW };
    return { request, signature: hex(signShareInboxRequest(request, inbox)), ...(ct ? { ct } : {}) };
  };

  it("puts, lists and deletes entries signed by the inbox key", async () => {
    const { d } = await deps();
    expect((await handleShareInbox(d, req("put", "a1".repeat(16), "beef"))).status).toBe(200);
    const listed = await handleShareInbox(d, req("list", ""));
    expect((listed.body as { entries: Array<{ ct: string }> }).entries.map((e) => e.ct)).toEqual(["beef"]);
    expect((await handleShareInbox(d, req("delete", "a1".repeat(16)))).status).toBe(200);
    expect(((await handleShareInbox(d, req("list", ""))).body as { entries: unknown[] }).entries).toEqual([]);
  });

  it("refuses another key's signature and a swapped entry", async () => {
    const { d } = await deps();
    const r = req("put", "a1".repeat(16), "beef");
    expect((await handleShareInbox(d, { ...r, signature: hex(signShareInboxRequest(r.request, member)) })).status).toBe(403);
    expect((await handleShareInbox(d, { ...r, ct: "dead" })).status).toBe(403);
    expect(SHARE_INBOX_CAP).toBeGreaterThan(10);
  });
});

describe("owner list with an admin root pinned", () => {
  it("still takes the IRK, since it only reads ciphertext", async () => {
    const storage = new InMemoryStorage();
    const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(12) });
    await storage.usernames.put({ username: "alice", irkPubHex: hex(owner.publicKey), adminRootPubHex: hex(adminRoot.publicKey), claimedAt: 1 });
    await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: "cd".repeat(32), registeredAt: 1 });
    const d = { shares: storage.serverShares, usernames: storage.usernames, servers: storage.servers, now: () => NOW };
    const list = { username: "alice", issuedAt: NOW };
    expect((await handleListServerShares(d, "alice", { list, signature: hex(signServerShareList(list, owner)) })).status).toBe(200);
    // Creating a share still needs the admin root.
    expect((await handleCreateServerShare(d, "alice", offerBody())).status).toBe(403);
    expect((await handleCreateServerShare(d, "alice", offerBody({}, adminRoot))).status).toBe(200);
  });
});
