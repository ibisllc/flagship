// Service access gating — webapp crypto-mirror interop with @flagship/protocol.
//
// Verifies the browser-shipping modules (keystore.js AID/household + the new
// lib/serviceInvite.js canonical-bytes + AEAD bundle) produce BYTE-IDENTICAL
// results to @flagship/protocol, AND match the cross-platform pinned vector
// fixture (packages/protocol/tests/fixtures/serviceAccessGating.vectors.json),
// so the later iOS / Android mirrors verify against the same bytes.
//
// We dynamic-import the exact files we serve to clients (the dist == what the
// production webapp loads). Both modules avoid IndexedDB / window at load, so
// they import clean in Node.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  ed,
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  openInviteBundle,
  signCreateServiceInvite,
  verifyCreateServiceInvite,
  signRedeemServiceInvite,
  verifyRedeemServiceInvite,
  signRevokeServiceInvite,
  verifyRevokeServiceInvite,
  signSetServiceAccessMode,
  verifySetServiceAccessMode,
  signRemoveServiceAllow,
  verifyRemoveServiceAllow,
  signServiceVisitProof,
  verifyServiceVisitProof,
  signKnockAuthorization,
  verifyKnockAuthorization,
  deriveContactAccountId,
  signAcceptServiceInvite,
  verifyAcceptServiceInvite,
  randomServiceInviteId,
  verifyServiceInviteListQuery,
  type CreateServiceInvite,
  type AcceptServiceInvite,
} from "@flagship/protocol";

function webappPath(...p: string[]) {
  return pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href;
}
async function loadKeystore() {
  return import(webappPath("keystore.js"));
}
async function loadServiceInvite() {
  return import(webappPath("lib", "serviceInvite.js"));
}

const VECTORS = JSON.parse(
  readFileSync(
    resolve(__dirname, "..", "..", "..", "packages", "protocol", "tests", "fixtures", "serviceAccessGating.vectors.json"),
    "utf8",
  ),
) as {
  seeds: { authorUmkSeedHex: string; friendUmkSeedHex: string };
  derived: {
    authorAidPubHex: string;
    authorIrkPubHex: string;
    authorDevicePubHex: string;
    friendAidPubHex: string;
    householdKeyHex: string;
  };
  secretHex: string;
  secretHash: string;
  inviteId: string;
  inviteIdCounter1: string;
  serviceRef: string;
  serverId: string;
  create: { encryptedBundlePlaceholder: string; issuedAt: number; sigHex: string };
  redeem: { redeemedAt: number; sigHex: string };
  revoke: { issuedAt: number; sigHex: string };
  setAccessMode: { mode: "restricted"; issuedAt: number; sigHex: string };
  removeAllow: { aid: string; issuedAt: number; sigHex: string };
  visit: { issuedAt: number; sigHex: string };
  knock: { pageId: string; issuedAt: number; sigHex: string };
  // v2 gating (Wave 3)
  contactAid: { authorAidPubHex: string; contactAidPubHex: string };
  accept: { inviteId: string; serviceRef: string; acceptedAt: number; sigHex: string };
  createMaxN: {
    inviteId: string;
    encryptedBundlePlaceholder: string;
    issuedAt: number;
    maxRedemptions: number;
    expiresAt: number;
    sigHex: string;
  };
  createAid: { inviteId: string; encryptedBundlePlaceholder: string; issuedAt: number; sigHex: string };
  revokeAid: { issuedAt: number; sigHex: string };
  bundle: { name: string; photo?: string };
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const authorUmk = { seed: hexToBytes(VECTORS.seeds.authorUmkSeedHex) };
const friendUmk = { seed: hexToBytes(VECTORS.seeds.friendUmkSeedHex) };

// ──────────────────────────────────────────────────────────────────────
// keystore.js — AID + household key mirror @flagship/protocol byte-for-byte.
// ──────────────────────────────────────────────────────────────────────
describe("webapp keystore — AID + household interop with @flagship/protocol", () => {
  it("deriveAccountIdFromSeed public key matches @flagship/protocol deriveAccountId", async () => {
    const k = await loadKeystore();
    const aid = await k.deriveAccountIdFromSeed(authorUmk.seed);
    expect(bytesToHex(aid.publicKey)).toBe(bytesToHex(deriveAccountId(authorUmk).publicKey));
    expect(bytesToHex(aid.publicKey)).toBe(VECTORS.derived.authorAidPubHex);
  });

  it("the friend AID matches the protocol + the pinned vector", async () => {
    const k = await loadKeystore();
    const aid = await k.deriveAccountIdFromSeed(friendUmk.seed);
    expect(bytesToHex(aid.publicKey)).toBe(bytesToHex(deriveAccountId(friendUmk).publicKey));
    expect(bytesToHex(aid.publicKey)).toBe(VECTORS.derived.friendAidPubHex);
  });

  it("the AID is DISTINCT from the IRK derived from the same seed", async () => {
    const k = await loadKeystore();
    const aid = await k.deriveAccountIdFromSeed(authorUmk.seed);
    const irk = await k.deriveIrkFromSeed(authorUmk.seed);
    expect(bytesToHex(aid.publicKey)).not.toBe(bytesToHex(irk.publicKey));
    // And the IRK matches the protocol (sanity that the vector's device key == author IRK).
    expect(bytesToHex(irk.publicKey)).toBe(VECTORS.derived.authorIrkPubHex);
  });

  it("deriveHouseholdKeyFromSeed matches @flagship/protocol deriveHouseholdKey", async () => {
    const k = await loadKeystore();
    const hh = await k.deriveHouseholdKeyFromSeed(authorUmk.seed);
    expect(bytesToHex(hh)).toBe(bytesToHex(deriveHouseholdKey(authorUmk)));
    expect(bytesToHex(hh)).toBe(VECTORS.derived.householdKeyHex);
    expect(hh.length).toBe(32);
  });

  it("deriveContactAccountIdFromSeed (v2) matches @flagship/protocol + the pinned contactAid vector", async () => {
    const k = await loadKeystore();
    const authorAidPub = hexToBytes(VECTORS.contactAid.authorAidPubHex);
    // The friend's PER-AUTHOR pseudonym over the AUTHOR's AID.
    const contact = await k.deriveContactAccountIdFromSeed(friendUmk.seed, authorAidPub);
    expect(bytesToHex(contact.publicKey)).toBe(
      bytesToHex(deriveContactAccountId(friendUmk, authorAidPub).publicKey),
    );
    expect(bytesToHex(contact.publicKey)).toBe(VECTORS.contactAid.contactAidPubHex);
    // It is DISTINCT from the friend's GLOBAL AID (the whole privacy point).
    const globalAid = await k.deriveAccountIdFromSeed(friendUmk.seed);
    expect(bytesToHex(contact.publicKey)).not.toBe(bytesToHex(globalAid.publicKey));
    // UNLINKABLE: a different author → a different contact id for the SAME friend.
    const otherAuthor = await k.deriveAccountIdFromSeed(authorUmk.seed); // same vector author here, so use friend-as-author for a 2nd
    const otherContact = await k.deriveContactAccountIdFromSeed(friendUmk.seed, globalAid.publicKey);
    expect(bytesToHex(otherContact.publicKey)).not.toBe(bytesToHex(contact.publicKey));
    void otherAuthor;
  });
});

// ──────────────────────────────────────────────────────────────────────
// lib/serviceInvite.js — inviteId / secretHash / bundle mirror.
// ──────────────────────────────────────────────────────────────────────
describe("webapp serviceInvite — inviteId + secretHash + bundle", () => {
  it("serviceInviteId matches the protocol + the pinned vectors (counters 0 and 1)", async () => {
    const si = await loadServiceInvite();
    const authorAid = deriveAccountId(authorUmk).publicKey;
    const device = deriveIRK(authorUmk).publicKey;
    expect(await si.serviceInviteId(authorAid, device, 0)).toBe(
      serviceInviteId(authorAid, device, 0),
    );
    expect(await si.serviceInviteId(authorAid, device, 0)).toBe(VECTORS.inviteId);
    expect(await si.serviceInviteId(authorAid, device, 1)).toBe(VECTORS.inviteIdCounter1);
  });

  it("serviceInviteSecretHash matches the protocol + the pinned vector", async () => {
    const si = await loadServiceInvite();
    expect(await si.serviceInviteSecretHash(hexToBytes(VECTORS.secretHex))).toBe(VECTORS.secretHash);
    expect(await si.serviceInviteSecretHash(hexToBytes(VECTORS.secretHex))).toBe(
      serviceInviteSecretHash(hexToBytes(VECTORS.secretHex)),
    );
  });

  it("the webapp can OPEN a bundle sealed by @flagship/protocol (cross-impl AEAD)", async () => {
    const si = await loadServiceInvite();
    const householdKey = deriveHouseholdKey(authorUmk);
    const sealed = sealInviteBundle(VECTORS.bundle, householdKey, VECTORS.inviteId);
    expect(await si.openInviteBundle(sealed, householdKey, VECTORS.inviteId)).toEqual(VECTORS.bundle);
  });

  it("@flagship/protocol can OPEN a bundle the webapp sealed (the reverse direction)", async () => {
    const si = await loadServiceInvite();
    const householdKey = deriveHouseholdKey(authorUmk);
    const sealed = await si.sealInviteBundle({ name: "Bo" }, householdKey, VECTORS.inviteId);
    expect(openInviteBundle(sealed, householdKey, VECTORS.inviteId)).toEqual({ name: "Bo" });
  });

  it("a bundle is AAD-bound to the inviteId — opening under another invite fails", async () => {
    const si = await loadServiceInvite();
    const householdKey = deriveHouseholdKey(authorUmk);
    const sealed = await si.sealInviteBundle({ name: "Alex" }, householdKey, VECTORS.inviteId);
    await expect(si.openInviteBundle(sealed, householdKey, VECTORS.inviteIdCounter1)).rejects.toThrow();
  });

  it("a different account's household key cannot open the bundle", async () => {
    const si = await loadServiceInvite();
    const householdKey = deriveHouseholdKey(authorUmk);
    const otherKey = deriveHouseholdKey(friendUmk);
    const sealed = await si.sealInviteBundle({ name: "Alex" }, householdKey, VECTORS.inviteId);
    await expect(si.openInviteBundle(sealed, otherKey, VECTORS.inviteId)).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// lib/serviceInvite.js — canonical bytes verify under @flagship/protocol AND
// reproduce the pinned cross-platform signatures.
// ──────────────────────────────────────────────────────────────────────
describe("webapp serviceInvite — canonical bytes + cross-platform signatures", () => {
  const authorAid = deriveAccountId(authorUmk);
  const authorIrk = deriveIRK(authorUmk);
  const friendAid = deriveAccountId(friendUmk);

  it("create: webapp bytes verify under protocol AND reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const create: CreateServiceInvite = {
      inviteId: VECTORS.inviteId,
      authorAID: authorAid.publicKey,
      serviceRef: VECTORS.serviceRef,
      secretHash: VECTORS.secretHash,
      encryptedBundle: VECTORS.create.encryptedBundlePlaceholder,
      issuedAt: VECTORS.create.issuedAt,
    };
    const bytes = si.canonicalCreateBytes(create);
    // 1) protocol signs, webapp bytes verify under the author IRK pub
    const protoSig = signCreateServiceInvite(create, authorIrk);
    expect(ed.verify(protoSig, bytes, authorIrk.publicKey)).toBe(true);
    // 2) webapp bytes signed with the IRK reproduce the PINNED cross-platform sig
    expect(bytesToHex(ed.sign(bytes, authorIrk.privateKey))).toBe(VECTORS.create.sigHex);
    // 3) protocol's verifier accepts the webapp-produced signature
    expect(verifyCreateServiceInvite(create, ed.sign(bytes, authorIrk.privateKey), authorIrk.publicKey)).toBe(true);
  });

  it("redeem: AID-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const redeem = { secretHash: VECTORS.secretHash, visitorAID: friendAid.publicKey, redeemedAt: VECTORS.redeem.redeemedAt };
    const bytes = si.canonicalRedeemBytes(redeem);
    expect(ed.verify(signRedeemServiceInvite(redeem, friendAid), bytes, friendAid.publicKey)).toBe(true);
    expect(bytesToHex(ed.sign(bytes, friendAid.privateKey))).toBe(VECTORS.redeem.sigHex);
    expect(verifyRedeemServiceInvite(redeem, ed.sign(bytes, friendAid.privateKey), friendAid.publicKey)).toBe(true);
  });

  it("revoke: IRK-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const revoke = { inviteId: VECTORS.inviteId, issuedAt: VECTORS.revoke.issuedAt };
    const bytes = si.canonicalRevokeBytes(revoke);
    expect(ed.verify(signRevokeServiceInvite(revoke, authorIrk), bytes, authorIrk.publicKey)).toBe(true);
    expect(bytesToHex(ed.sign(bytes, authorIrk.privateKey))).toBe(VECTORS.revoke.sigHex);
    expect(verifyRevokeServiceInvite(revoke, ed.sign(bytes, authorIrk.privateKey), authorIrk.publicKey)).toBe(true);
  });

  it("set-access-mode: owner-IRK-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const order = { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, mode: VECTORS.setAccessMode.mode, issuedAt: VECTORS.setAccessMode.issuedAt };
    const bytes = si.canonicalSetAccessModeBytes(order);
    expect(ed.verify(signSetServiceAccessMode(order, authorIrk), bytes, authorIrk.publicKey)).toBe(true);
    expect(bytesToHex(ed.sign(bytes, authorIrk.privateKey))).toBe(VECTORS.setAccessMode.sigHex);
    expect(verifySetServiceAccessMode(order, ed.sign(bytes, authorIrk.privateKey), authorIrk.publicKey)).toBe(true);
  });

  it("remove-allow: owner-IRK-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const order = { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, aid: VECTORS.removeAllow.aid, issuedAt: VECTORS.removeAllow.issuedAt };
    // The pinned AID IS the friend's AID pub (the bound principal pruned).
    expect(VECTORS.removeAllow.aid).toBe(VECTORS.derived.friendAidPubHex);
    const bytes = si.canonicalRemoveServiceAllowBytes(order);
    expect(ed.verify(signRemoveServiceAllow(order, authorIrk), bytes, authorIrk.publicKey)).toBe(true);
    expect(bytesToHex(ed.sign(bytes, authorIrk.privateKey))).toBe(VECTORS.removeAllow.sigHex);
    expect(verifyRemoveServiceAllow(order, ed.sign(bytes, authorIrk.privateKey), authorIrk.publicKey)).toBe(true);
  });

  it("visit proof: AID-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const visit = { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, visitorAID: friendAid.publicKey, issuedAt: VECTORS.visit.issuedAt };
    const bytes = si.canonicalVisitBytes(visit);
    expect(ed.verify(signServiceVisitProof(visit, friendAid), bytes, friendAid.publicKey)).toBe(true);
    expect(bytesToHex(ed.sign(bytes, friendAid.privateKey))).toBe(VECTORS.visit.sigHex);
    expect(verifyServiceVisitProof(visit, ed.sign(bytes, friendAid.privateKey), friendAid.publicKey)).toBe(true);
  });

  it("knock authorization: AID-signed bytes verify + reproduce the pinned sig", async () => {
    const si = await loadServiceInvite();
    const knock = {
      serverId: VECTORS.serverId,
      serviceRef: VECTORS.serviceRef,
      pageId: VECTORS.knock.pageId,
      visitorAID: friendAid.publicKey,
      issuedAt: VECTORS.knock.issuedAt,
    };
    const bytes = si.canonicalKnockBytes(knock);
    // 1) protocol signs, webapp bytes verify under the friend AID pub
    expect(ed.verify(signKnockAuthorization(knock, friendAid), bytes, friendAid.publicKey)).toBe(true);
    // 2) webapp bytes signed with the friend AID reproduce the PINNED cross-platform sig
    expect(bytesToHex(ed.sign(bytes, friendAid.privateKey))).toBe(VECTORS.knock.sigHex);
    // 3) protocol's verifier accepts the webapp-produced signature
    expect(verifyKnockAuthorization(knock, ed.sign(bytes, friendAid.privateKey), friendAid.publicKey)).toBe(true);
    // 4) the webapp's signKnockAuthorization helper (injected AID signer) emits the SAME pinned sig
    const signAidLocal = (priv: Uint8Array) => async (_umk: Uint8Array, b: Uint8Array) => ed.sign(b, priv);
    const sig = await si.signKnockAuthorization(
      { ...knock, umk: friendUmk.seed },
      signAidLocal(friendAid.privateKey),
    );
    expect(bytesToHex(sig)).toBe(VECTORS.knock.sigHex);
  });

  // ── v2 gating (Wave 3) — AID-signed create/revoke, accept loop, group caps ──

  it("createAid: the create bytes signed by the AUTHOR AID reproduce the pinned createAid sig", async () => {
    const si = await loadServiceInvite();
    const create: CreateServiceInvite = {
      inviteId: VECTORS.createAid.inviteId,
      authorAID: authorAid.publicKey,
      serviceRef: VECTORS.serviceRef,
      secretHash: VECTORS.secretHash,
      encryptedBundle: VECTORS.createAid.encryptedBundlePlaceholder,
      issuedAt: VECTORS.createAid.issuedAt,
    };
    const bytes = si.canonicalCreateBytes(create);
    // Same pre-image as the v1 `create` vector — only the signer differs (AID vs IRK).
    expect(bytes).toEqual(si.canonicalCreateBytes({ ...create }));
    expect(bytesToHex(ed.sign(bytes, authorAid.privateKey))).toBe(VECTORS.createAid.sigHex);
    // The protocol verifier accepts the AID-signed create against the author AID pub.
    expect(verifyCreateServiceInvite(create, ed.sign(bytes, authorAid.privateKey), authorAid.publicKey)).toBe(true);
    // The keystore's AID signer (what createInvite calls) emits the SAME pinned sig.
    const k = await loadKeystore();
    expect(bytesToHex(await k.signWithAccountId(authorUmk.seed, bytes))).toBe(VECTORS.createAid.sigHex);
  });

  it("revokeAid: the revoke bytes signed by the AUTHOR AID reproduce the pinned revokeAid sig", async () => {
    const si = await loadServiceInvite();
    const revoke = { inviteId: VECTORS.inviteId, issuedAt: VECTORS.revokeAid.issuedAt };
    const bytes = si.canonicalRevokeBytes(revoke);
    expect(bytesToHex(ed.sign(bytes, authorAid.privateKey))).toBe(VECTORS.revokeAid.sigHex);
    expect(verifyRevokeServiceInvite(revoke, ed.sign(bytes, authorAid.privateKey), authorAid.publicKey)).toBe(true);
    const k = await loadKeystore();
    expect(bytesToHex(await k.signWithAccountId(authorUmk.seed, bytes))).toBe(VECTORS.revokeAid.sigHex);
  });

  it("createMaxN: the GROUP create (maxN + exp appended) reproduces the pinned sig (IRK-signed)", async () => {
    const si = await loadServiceInvite();
    const create: CreateServiceInvite = {
      inviteId: VECTORS.createMaxN.inviteId,
      authorAID: authorAid.publicKey,
      serviceRef: VECTORS.serviceRef,
      secretHash: VECTORS.secretHash,
      encryptedBundle: VECTORS.createMaxN.encryptedBundlePlaceholder,
      issuedAt: VECTORS.createMaxN.issuedAt,
      maxRedemptions: VECTORS.createMaxN.maxRedemptions,
      expiresAt: VECTORS.createMaxN.expiresAt,
    };
    const bytes = si.canonicalCreateBytes(create);
    // Group caps ARE in the signed bytes → the sig differs from the no-caps create.
    expect(bytes).not.toEqual(
      si.canonicalCreateBytes({ ...create, maxRedemptions: undefined, expiresAt: undefined }),
    );
    expect(bytesToHex(ed.sign(bytes, authorIrk.privateKey))).toBe(VECTORS.createMaxN.sigHex);
    expect(verifyCreateServiceInvite(create, ed.sign(bytes, authorIrk.privateKey), authorIrk.publicKey)).toBe(true);
    // A no-caps create signs byte-identically to the v1 create vector (backward-compat).
    const v1Bytes = si.canonicalCreateBytes({
      inviteId: VECTORS.inviteId,
      authorAID: authorAid.publicKey,
      serviceRef: VECTORS.serviceRef,
      secretHash: VECTORS.secretHash,
      encryptedBundle: VECTORS.create.encryptedBundlePlaceholder,
      issuedAt: VECTORS.create.issuedAt,
    });
    expect(bytesToHex(ed.sign(v1Bytes, authorIrk.privateKey))).toBe(VECTORS.create.sigHex);
  });

  it("accept: the friend's CONTACT-AID acceptance reproduces the pinned accept sig", async () => {
    const si = await loadServiceInvite();
    const k = await loadKeystore();
    const authorAidPub = hexToBytes(VECTORS.contactAid.authorAidPubHex);
    const contact = await k.deriveContactAccountIdFromSeed(friendUmk.seed, authorAidPub);
    expect(bytesToHex(contact.publicKey)).toBe(VECTORS.contactAid.contactAidPubHex);
    const accept: AcceptServiceInvite = {
      inviteId: VECTORS.accept.inviteId,
      serviceRef: VECTORS.accept.serviceRef,
      contactAID: contact.publicKey,
      acceptedAt: VECTORS.accept.acceptedAt,
    };
    const bytes = si.canonicalAcceptBytes(accept);
    // 1) protocol signs, webapp bytes verify under the contact AID pub
    const protoContact = deriveContactAccountId(friendUmk, authorAidPub);
    expect(ed.verify(signAcceptServiceInvite(accept, protoContact), bytes, contact.publicKey)).toBe(true);
    // 2) webapp bytes signed with the contact AID reproduce the PINNED sig
    expect(bytesToHex(ed.sign(bytes, protoContact.privateKey))).toBe(VECTORS.accept.sigHex);
    // 3) protocol's verifier accepts the webapp-produced signature
    expect(verifyAcceptServiceInvite(accept, ed.sign(bytes, protoContact.privateKey), contact.publicKey)).toBe(true);
    // 4) the webapp's signAcceptServiceInvite helper (injected contact signer) emits the SAME pinned sig
    const sig = await si.signAcceptServiceInvite(
      { ...accept, authorAID: authorAidPub, umk: friendUmk.seed },
      k.signWithContactAccountId,
    );
    expect(bytesToHex(sig)).toBe(VECTORS.accept.sigHex);
  });

  it("randomServiceInviteId is a fresh 64-hex id each call", async () => {
    const si = await loadServiceInvite();
    const a = si.randomServiceInviteId();
    const b = si.randomServiceInviteId();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    // Mirrors the protocol shape.
    expect(randomServiceInviteId()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects separator/control injection in serviceRef at build time", async () => {
    const si = await loadServiceInvite();
    expect(() =>
      si.canonicalSetAccessModeBytes({ serverId: VECTORS.serverId, serviceRef: "a|b", mode: "open", issuedAt: 1 }),
    ).toThrow();
    expect(() => si.canonicalSetAccessModeBytes({ serverId: VECTORS.serverId, serviceRef: "x", mode: "weird", issuedAt: 1 })).toThrow();
    // The knock builder guards its signed fields too (separator + control chars).
    expect(() =>
      si.canonicalKnockBytes({ serverId: VECTORS.serverId, serviceRef: "x", pageId: "a|b", visitorAID: friendAid.publicKey, issuedAt: 1 }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// lib/serviceInvite.js — wire helpers (POST shapes + the friend redeem).
// ──────────────────────────────────────────────────────────────────────
describe("webapp serviceInvite — wire helpers", () => {
  const authorAid = deriveAccountId(authorUmk);
  const authorIrk = deriveIRK(authorUmk);
  const friendAid = deriveAccountId(friendUmk);
  const COM = "https://flagshipserver.com";
  const POD = "https://home.alice.flagship.services";

  const signIrk = (priv: Uint8Array) => async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, priv);
  const signAid = (priv: Uint8Array) => async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, priv);

  it("createInvite (v2) POSTs the AUTHOR-AID-signed envelope .com verifies + returns the v2 link + retained create", async () => {
    const si = await loadServiceInvite();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ created: true }) } as Response;
    };
    const fixedSecret = new Uint8Array(32).fill(7);
    const r = await si.createInvite(
      {
        comBase: COM,
        username: "alice",
        podBaseUrl: POD,
        authorAID: authorAid.publicKey,
        inviteId: VECTORS.inviteId, // pin the id so the sig is deterministic
        serviceRef: VECTORS.serviceRef,
        bundle: { name: "Alex" },
        householdKey: deriveHouseholdKey(authorUmk),
        umk: authorUmk.seed,
        signWithAccountId: signAid(authorAid.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.create.issuedAt, randomBytes: () => fixedSecret },
    );
    expect(calls[0]!.url).toBe(`${COM}/api/users/alice/service-invites`);
    expect(r.inviteId).toBe(VECTORS.inviteId);
    expect(r.secretHex).toBe(VECTORS.secretHex);
    // The v2 share-link carries the author AID + inviteId in the fragment.
    expect(r.link).toBe(`${POD}/invite#k=${VECTORS.secretHex}&a=${VECTORS.derived.authorAidPubHex}&i=${VECTORS.inviteId}`);
    // The author RETAINS the signed create (to finalize a manual acceptance later).
    expect(r.create.inviteId).toBe(VECTORS.inviteId);
    expect(r.createSig).toMatch(/^[0-9a-f]{128}$/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.request.authorAID).toBe(VECTORS.derived.authorAidPubHex);
    expect(body.request.secretHash).toBe(VECTORS.secretHash);
    // The signature .com receives verifies over the create canonical bytes under the AUTHOR AID.
    const create: CreateServiceInvite = {
      inviteId: body.request.inviteId,
      authorAID: hexToBytes(body.request.authorAID),
      serviceRef: body.request.serviceRef,
      secretHash: body.request.secretHash,
      encryptedBundle: body.request.encryptedBundle,
      issuedAt: body.request.issuedAt,
    };
    const sig = hexToBytes(body.signature);
    expect(verifyCreateServiceInvite(create, sig, authorAid.publicKey)).toBe(true);
    // The retained create + createSig verify together (what /api/service-access/accept re-checks).
    expect(verifyCreateServiceInvite({ ...create, encryptedBundle: r.create.encryptedBundle }, hexToBytes(r.createSig), authorAid.publicKey)).toBe(true);
  });

  it("createInvite (group tier) signs maxRedemptions+expiresAt + forwards approvalMode (unsigned policy)", async () => {
    const si = await loadServiceInvite();
    let captured: { body: any } | null = null;
    const f = async (_url: string, init: RequestInit) => {
      captured = { body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ created: true }) } as Response;
    };
    const r = await si.createInvite(
      {
        comBase: COM,
        username: "alice",
        podBaseUrl: POD,
        authorAID: authorAid.publicKey,
        inviteId: VECTORS.createMaxN.inviteId,
        serviceRef: VECTORS.serviceRef,
        bundle: { name: "Chess club" },
        householdKey: deriveHouseholdKey(authorUmk),
        maxRedemptions: VECTORS.createMaxN.maxRedemptions,
        expiresAt: VECTORS.createMaxN.expiresAt,
        approvalMode: "auto",
        umk: authorUmk.seed,
        signWithAccountId: signAid(authorAid.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.createMaxN.issuedAt, randomBytes: () => new Uint8Array(32).fill(7) },
    );
    // maxN/exp are in the SIGNED request; approvalMode is the .com policy field.
    expect(captured!.body.request.maxRedemptions).toBe(VECTORS.createMaxN.maxRedemptions);
    expect(captured!.body.request.expiresAt).toBe(VECTORS.createMaxN.expiresAt);
    expect(captured!.body.request.approvalMode).toBe("auto");
    const create: CreateServiceInvite = {
      inviteId: captured!.body.request.inviteId,
      authorAID: hexToBytes(captured!.body.request.authorAID),
      serviceRef: captured!.body.request.serviceRef,
      secretHash: captured!.body.request.secretHash,
      encryptedBundle: captured!.body.request.encryptedBundle,
      issuedAt: captured!.body.request.issuedAt,
      maxRedemptions: captured!.body.request.maxRedemptions,
      expiresAt: captured!.body.request.expiresAt,
    };
    expect(verifyCreateServiceInvite(create, hexToBytes(captured!.body.signature), authorAid.publicKey)).toBe(true);
    expect(r.approvalMode).toBe("auto");
  });

  it("createInvite without an explicit id mints a random 128-bit id (v2 §M2 — no device fingerprint)", async () => {
    const si = await loadServiceInvite();
    const f = async () => ({ ok: true, json: async () => ({ created: true }) } as Response);
    const mk = () =>
      si.createInvite(
        {
          comBase: COM, username: "alice", podBaseUrl: POD, authorAID: authorAid.publicKey,
          serviceRef: VECTORS.serviceRef, bundle: { name: "X" }, householdKey: deriveHouseholdKey(authorUmk),
          umk: authorUmk.seed, signWithAccountId: signAid(authorAid.privateKey),
        },
        { fetch: f as unknown as typeof fetch },
      );
    const a = await mk();
    const b = await mk();
    expect(a.inviteId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.inviteId).not.toBe(b.inviteId);
  });

  it("redeemInvite sends the raw secret + an AID sig the box/.com verify, and maps 409", async () => {
    const si = await loadServiceInvite();
    let captured: { url: string; body: any } | null = null;
    const f = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, status: 200, json: async () => ({ redeemed: true, serviceRef: VECTORS.serviceRef, boundAID: VECTORS.derived.friendAidPubHex, firstBind: true }) } as Response;
    };
    const r = await si.redeemInvite(
      {
        baseUrl: POD,
        secretHex: VECTORS.secretHex,
        visitorAID: friendAid.publicKey,
        umk: friendUmk.seed,
        signWithAccountId: signAid(friendAid.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.redeem.redeemedAt },
    );
    expect(captured!.url).toBe(`${POD}/api/service-invites/redeem`);
    expect(captured!.body.secret).toBe(VECTORS.secretHex);
    expect(captured!.body.visitorAID).toBe(VECTORS.derived.friendAidPubHex);
    expect(r.firstBind).toBe(true);
    expect(r.serviceRef).toBe(VECTORS.serviceRef);
    // AUTO-approve return shape.
    expect(r.pending).toBe(false);
    expect(r.approvalMode).toBe("auto");
    // The AID sig the box receives is exactly the pinned redeem signature.
    expect(captured!.body.aidSig).toBe(VECTORS.redeem.sigHex);
    const redeem = { secretHash: VECTORS.secretHash, visitorAID: friendAid.publicKey, redeemedAt: VECTORS.redeem.redeemedAt };
    expect(verifyRedeemServiceInvite(redeem, hexToBytes(captured!.body.aidSig), friendAid.publicKey)).toBe(true);

    // 409 maps to a friendly "already linked" error; 410 to expired/limit.
    const f409 = async () => ({ ok: false, status: 409, text: async () => "" }) as Response;
    await expect(
      si.redeemInvite(
        { baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: friendUmk.seed, signWithAccountId: signAid(friendAid.privateKey) },
        { fetch: f409 as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "409" });
    const f410 = async () => ({ ok: false, status: 410, text: async () => "" }) as Response;
    await expect(
      si.redeemInvite(
        { baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: friendUmk.seed, signWithAccountId: signAid(friendAid.privateKey) },
        { fetch: f410 as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "410" });
  });

  it("redeemInvite surfaces the MANUAL-approve {pending} state (no bind yet)", async () => {
    const si = await loadServiceInvite();
    const f = async () =>
      ({ ok: true, status: 200, json: async () => ({ pending: true, approvalMode: "manual", serviceRef: VECTORS.serviceRef }) }) as Response;
    const r = await si.redeemInvite(
      { baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: friendUmk.seed, signWithAccountId: signAid(friendAid.privateKey) },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.redeem.redeemedAt },
    );
    expect(r.pending).toBe(true);
    expect(r.approvalMode).toBe("manual");
    expect(r.serviceRef).toBe(VECTORS.serviceRef);
    expect(r.boundAID).toBeUndefined();
  });

  it("setServiceAccessMode POSTs to the box's pinned pipe with the owner-IRK envelope", async () => {
    const si = await loadServiceInvite();
    let captured: { url: string; body: any } | null = null;
    const f = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ ok: true, mode: "restricted" }) } as Response;
    };
    const r = await si.setServiceAccessMode(
      { baseUrl: POD, serviceRef: VECTORS.serviceRef, mode: "restricted", umk: authorUmk.seed, signWithIrk: signIrk(authorIrk.privateKey) },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.setAccessMode.issuedAt },
    );
    expect(captured!.url).toBe(`${POD}/api/service-access`);
    expect(captured!.body.request).toEqual({ serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, mode: "restricted", issuedAt: VECTORS.setAccessMode.issuedAt });
    expect(captured!.body.signature).toBe(VECTORS.setAccessMode.sigHex);
    expect(r.mode).toBe("restricted");
  });

  it("removeServiceAllow POSTs the owner-IRK prune to the box's allow-remove endpoint", async () => {
    const si = await loadServiceInvite();
    let captured: { url: string; body: any } | null = null;
    const f = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ ok: true, removed: true }) } as Response;
    };
    const r = await si.removeServiceAllow(
      { baseUrl: POD, serviceRef: VECTORS.serviceRef, aid: VECTORS.removeAllow.aid, umk: authorUmk.seed, signWithIrk: signIrk(authorIrk.privateKey) },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.removeAllow.issuedAt },
    );
    expect(captured!.url).toBe(`${POD}/api/service-access/allow-remove`);
    expect(captured!.body.request).toEqual({ serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, aid: VECTORS.removeAllow.aid, issuedAt: VECTORS.removeAllow.issuedAt });
    // The sig the box receives is exactly the pinned remove-allow signature.
    expect(captured!.body.signature).toBe(VECTORS.removeAllow.sigHex);
    const order = { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, aid: VECTORS.removeAllow.aid, issuedAt: VECTORS.removeAllow.issuedAt };
    expect(verifyRemoveServiceAllow(order, hexToBytes(captured!.body.signature), authorIrk.publicKey)).toBe(true);
    expect(r.removed).toBe(true);
    // An uppercase AID is lowercased before signing (matches the box's parse).
    let cap2: { body: any } | null = null;
    const f2 = async (_url: string, init: RequestInit) => {
      cap2 = { body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ ok: true, removed: false }) } as Response;
    };
    await si.removeServiceAllow(
      { baseUrl: POD, serviceRef: VECTORS.serviceRef, aid: VECTORS.removeAllow.aid.toUpperCase(), umk: authorUmk.seed, signWithIrk: signIrk(authorIrk.privateKey) },
      { fetch: f2 as unknown as typeof fetch, now: () => VECTORS.removeAllow.issuedAt },
    );
    expect(cap2!.body.request.aid).toBe(VECTORS.removeAllow.aid);
    expect(cap2!.body.signature).toBe(VECTORS.removeAllow.sigHex);
  });

  it("buildVisitHeader is base64(JSON{proof,sig}) the box can parse + verify", async () => {
    const si = await loadServiceInvite();
    const header = await si.buildVisitHeader(
      { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, visitorAID: friendAid.publicKey, umk: friendUmk.seed, signWithAccountId: signAid(friendAid.privateKey) },
      { now: () => VECTORS.visit.issuedAt },
    );
    const obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(obj.proof.serverId).toBe(VECTORS.serverId);
    expect(obj.proof.visitorAID).toBe(VECTORS.derived.friendAidPubHex);
    expect(obj.sig).toBe(VECTORS.visit.sigHex);
    const visit = { serverId: VECTORS.serverId, serviceRef: VECTORS.serviceRef, visitorAID: friendAid.publicKey, issuedAt: VECTORS.visit.issuedAt };
    expect(verifyServiceVisitProof(visit, hexToBytes(obj.sig), friendAid.publicKey)).toBe(true);
  });

  it("authorizeKnock POSTs the AID-signed authorization to the box + returns the secretId on 200", async () => {
    const si = await loadServiceInvite();
    const SECRET = "a".repeat(64);
    let captured: { url: string; body: any } | null = null;
    const f = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorized: true,
          secretId: SECRET,
          serviceRef: VECTORS.serviceRef,
          browserAgent: "Mozilla/5.0 (TestBrowser)",
          startedAt: VECTORS.knock.issuedAt,
          expiresAt: VECTORS.knock.issuedAt + 43_200_000,
        }),
      } as Response;
    };
    const r = await si.authorizeKnock(
      {
        serverId: VECTORS.serverId,
        serviceRef: VECTORS.serviceRef,
        pageId: VECTORS.knock.pageId,
        svc: "notes",
        visitorAID: friendAid.publicKey,
        umk: friendUmk.seed,
        signWithAccountId: signAid(friendAid.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.knock.issuedAt },
    );
    expect(captured!.url).toBe(`https://${VECTORS.serverId}/api/service-access/knock/authorize`);
    expect(captured!.body.authorization).toEqual({
      serverId: VECTORS.serverId,
      serviceRef: VECTORS.serviceRef,
      pageId: VECTORS.knock.pageId,
      visitorAID: VECTORS.derived.friendAidPubHex,
      issuedAt: VECTORS.knock.issuedAt,
    });
    // The sig the box receives is exactly the pinned knock signature.
    expect(captured!.body.sig).toBe(VECTORS.knock.sigHex);
    const knock = {
      serverId: VECTORS.serverId,
      serviceRef: VECTORS.serviceRef,
      pageId: VECTORS.knock.pageId,
      visitorAID: friendAid.publicKey,
      issuedAt: VECTORS.knock.issuedAt,
    };
    expect(verifyKnockAuthorization(knock, hexToBytes(captured!.body.sig), friendAid.publicKey)).toBe(true);
    expect(r.secretId).toBe(SECRET);
    expect(r.serverId).toBe(VECTORS.serverId);
    expect(r.svc).toBe("notes");
    expect(r.browserAgent).toBe("Mozilla/5.0 (TestBrowser)");
  });

  it("authorizeKnock maps 401/403/404 to clear messages", async () => {
    const si = await loadServiceInvite();
    const base = {
      serverId: VECTORS.serverId,
      serviceRef: VECTORS.serviceRef,
      pageId: VECTORS.knock.pageId,
      visitorAID: friendAid.publicKey,
      umk: friendUmk.seed,
      signWithAccountId: signAid(friendAid.privateKey),
    };
    const resp = (status: number) => async () => ({ ok: false, status, text: async () => "" }) as Response;
    await expect(si.authorizeKnock(base, { fetch: resp(401) as unknown as typeof fetch })).rejects.toMatchObject({ code: "401" });
    await expect(si.authorizeKnock(base, { fetch: resp(403) as unknown as typeof fetch })).rejects.toMatchObject({ code: "403" });
    await expect(si.authorizeKnock(base, { fetch: resp(404) as unknown as typeof fetch })).rejects.toMatchObject({ code: "404" });
  });

  it("sessionStatus + closeSession POST the secretId in the BODY (never the URL)", async () => {
    const si = await loadServiceInvite();
    const SECRET = "b".repeat(64);
    let statusCap: { url: string; body: any } | null = null;
    const fStatus = async (url: string, init: RequestInit) => {
      statusCap = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, status: 200, json: async () => ({ status: "online" }) } as Response;
    };
    const status = await si.sessionStatus({ serverId: VECTORS.serverId, secretId: SECRET }, { fetch: fStatus as unknown as typeof fetch });
    expect(statusCap!.url).toBe(`https://${VECTORS.serverId}/api/service-access/session/status`);
    expect(statusCap!.url).not.toContain(SECRET); // never in the URL
    expect(statusCap!.body).toEqual({ secretId: SECRET });
    expect(status).toBe("online");

    // 429 → dedicated code so the caller keeps the last-known status.
    const f429 = async () => ({ ok: false, status: 429, text: async () => "" }) as Response;
    await expect(si.sessionStatus({ serverId: VECTORS.serverId, secretId: SECRET }, { fetch: f429 as unknown as typeof fetch })).rejects.toMatchObject({ code: "429" });

    let closeCap: { url: string; body: any } | null = null;
    const fClose = async (url: string, init: RequestInit) => {
      closeCap = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, status: 200, json: async () => ({ closed: true }) } as Response;
    };
    const closed = await si.closeSession({ serverId: VECTORS.serverId, secretId: SECRET }, { fetch: fClose as unknown as typeof fetch });
    expect(closeCap!.url).toBe(`https://${VECTORS.serverId}/api/service-access/session/close`);
    expect(closeCap!.body).toEqual({ secretId: SECRET });
    expect(closed.closed).toBe(true);
  });

  it("parseAccessDeepLink parses a flagship://access link (tolerating pasted whitespace) + rejects junk", async () => {
    const si = await loadServiceInvite();
    const link = `flagship://access?server=${encodeURIComponent(VECTORS.serverId)}&svc=notes&ref=${encodeURIComponent(VECTORS.serviceRef)}&page=${VECTORS.knock.pageId}`;
    expect(si.parseAccessDeepLink(`  \n${link}\t `)).toEqual({
      serverId: VECTORS.serverId,
      svc: "notes",
      serviceRef: VECTORS.serviceRef,
      pageId: VECTORS.knock.pageId,
    });
    expect(si.serviceUrlFromDeepLink(si.parseAccessDeepLink(link))).toBe(`https://notes.${VECTORS.serverId}`);
    // Wrong scheme / missing required fields / not a link → null.
    expect(si.parseAccessDeepLink("https://example.com/?server=x&ref=y&page=z")).toBeNull();
    expect(si.parseAccessDeepLink("flagship://access?server=x&svc=s")).toBeNull(); // no ref/page
    expect(si.parseAccessDeepLink("nonsense")).toBeNull();
    expect(si.parseAccessDeepLink("")).toBeNull();
  });

  it("locked webapp guards (no umk / signer) on create + redeem + list + set-mode + authorize", async () => {
    const si = await loadServiceInvite();
    await expect(si.createInvite({ comBase: COM, username: "alice", podBaseUrl: POD, authorAID: authorAid.publicKey, serviceRef: "x", bundle: { name: "y" }, householdKey: deriveHouseholdKey(authorUmk), umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
    await expect(si.redeemInvite({ baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
    await expect(si.listInvites({ comBase: COM, username: "alice", authorAID: authorAid.publicKey, householdKey: deriveHouseholdKey(authorUmk), umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
    await expect(si.revokeInvite({ comBase: COM, username: "alice", inviteId: VECTORS.inviteId, umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
    await expect(si.setServiceAccessMode({ baseUrl: POD, serviceRef: "x", mode: "open", umk: null, signWithIrk: null })).rejects.toThrow(/unlock/i);
    await expect(si.removeServiceAllow({ baseUrl: POD, serviceRef: "x", aid: VECTORS.removeAllow.aid, umk: null, signWithIrk: null })).rejects.toThrow(/unlock/i);
    await expect(si.authorizeKnock({ serverId: VECTORS.serverId, serviceRef: "x", pageId: "p", svc: "s", visitorAID: friendAid.publicKey, umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
  });

  it("listInvites (v2 §C2) AID-signs the query .com verifies + surfaces group fields", async () => {
    const si = await loadServiceInvite();
    let captured: { url: string } | null = null;
    const f = async (url: string) => {
      captured = { url };
      return {
        ok: true,
        json: async () => ({
          invites: [
            { inviteId: VECTORS.inviteId, serviceRef: VECTORS.serviceRef, encryptedBundle: "00", boundAID: null, maxRedemptions: 10, expiresAt: 1700009999999, redemptions: 3, boundAIDs: ["aa".repeat(32)], approvalMode: "auto" },
          ],
        }),
      } as Response;
    };
    const rows = await si.listInvites(
      { comBase: COM, username: "Alice", authorAID: authorAid.publicKey, householdKey: deriveHouseholdKey(authorUmk), serviceRef: VECTORS.serviceRef, umk: authorUmk.seed, signWithAccountId: signAid(authorAid.privateKey) },
      { fetch: f as unknown as typeof fetch, now: () => 1700002222222 },
    );
    const u = new URL(captured!.url);
    expect(u.pathname).toBe("/api/users/Alice/service-invites");
    expect(u.searchParams.get("authorAID")).toBe(VECTORS.derived.authorAidPubHex);
    expect(u.searchParams.get("scope")).toBe("list");
    expect(u.searchParams.get("cursor")).toBe("0");
    expect(u.searchParams.get("issuedAt")).toBe("1700002222222");
    // The sig verifies under the AUTHOR AID over the LOWERCASED username canonical bytes.
    const query = { username: "alice", authorAID: VECTORS.derived.authorAidPubHex, scope: "list" as const, cursor: 0, issuedAt: 1700002222222 };
    const bytes = si.canonicalListQueryBytes(query);
    expect(verifyServiceInviteListQuery(query, hexToBytes(u.searchParams.get("sig")!), authorAid.publicKey)).toBe(true);
    void bytes;
    // The row surfaces the v2 group fields the UI renders ("k/N").
    expect(rows[0]!.maxRedemptions).toBe(10);
    expect(rows[0]!.redemptions).toBe(3);
    expect(rows[0]!.boundAIDs).toEqual(["aa".repeat(32)]);
    expect(rows[0]!.approvalMode).toBe("auto");
  });

  it("MANUAL accept loop: friend emits the contact-AID acceptance reply; author parses + submits it", async () => {
    const si = await loadServiceInvite();
    const k = await loadKeystore();
    const authorAidPub = hexToBytes(VECTORS.contactAid.authorAidPubHex);
    const contact = await k.deriveContactAccountIdFromSeed(friendUmk.seed, authorAidPub);
    // FRIEND emits the acceptance reply (contact-AID signed) — symmetric link/code.
    const acceptSig = await si.signAcceptServiceInvite(
      { inviteId: VECTORS.accept.inviteId, serviceRef: VECTORS.accept.serviceRef, contactAID: contact.publicKey, authorAID: authorAidPub, acceptedAt: VECTORS.accept.acceptedAt, umk: friendUmk.seed },
      k.signWithContactAccountId,
    );
    expect(bytesToHex(acceptSig)).toBe(VECTORS.accept.sigHex);
    const reply = si.buildAcceptReply(
      { inviteId: VECTORS.accept.inviteId, serviceRef: VECTORS.accept.serviceRef, contactAID: bytesToHex(contact.publicKey), acceptedAt: VECTORS.accept.acceptedAt },
      bytesToHex(acceptSig),
    );
    expect(reply.startsWith("flagship-accept:")).toBe(true);
    // AUTHOR parses the reply (tolerating pasted whitespace).
    const parsed = si.parseAcceptReply(`  \n${reply}\t `);
    expect(parsed.accept.inviteId).toBe(VECTORS.accept.inviteId);
    expect(parsed.accept.contactAID).toBe(VECTORS.contactAid.contactAidPubHex);
    expect(parsed.acceptSig).toBe(VECTORS.accept.sigHex);
    // The acceptance verifies under the contact AID (what the box re-checks).
    const accept: AcceptServiceInvite = {
      inviteId: parsed.accept.inviteId,
      serviceRef: parsed.accept.serviceRef,
      contactAID: hexToBytes(parsed.accept.contactAID),
      acceptedAt: parsed.accept.acceptedAt,
    };
    expect(verifyAcceptServiceInvite(accept, hexToBytes(parsed.acceptSig), contact.publicKey)).toBe(true);
    // AUTHOR submits {accept, acceptSig, create, createSig} to ITS box's accept endpoint.
    let captured: { url: string; body: any } | null = null;
    const f = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, status: 200, json: async () => ({ bound: true, serviceRef: VECTORS.serviceRef, boundAID: VECTORS.contactAid.contactAidPubHex }) } as Response;
    };
    const create = { inviteId: VECTORS.accept.inviteId, authorAID: VECTORS.contactAid.authorAidPubHex, serviceRef: VECTORS.serviceRef, secretHash: VECTORS.secretHash, encryptedBundle: "00", issuedAt: VECTORS.create.issuedAt };
    const createSig = bytesToHex(ed.sign(si.canonicalCreateBytes({ ...create, authorAID: authorAidPub }), authorAid.privateKey));
    const r = await si.submitAccept(
      { baseUrl: POD, accept: parsed.accept, acceptSig: parsed.acceptSig, create, createSig },
      { fetch: f as unknown as typeof fetch },
    );
    expect(captured!.url).toBe(`${POD}/api/service-access/accept`);
    expect(captured!.body.accept.contactAID).toBe(VECTORS.contactAid.contactAidPubHex);
    expect(captured!.body.acceptSig).toBe(VECTORS.accept.sigHex);
    expect(captured!.body.create.inviteId).toBe(VECTORS.accept.inviteId);
    expect(captured!.body.createSig).toBe(createSig);
    expect(r.bound).toBe(true);
    expect(r.boundAID).toBe(VECTORS.contactAid.contactAidPubHex);
    // A bad / non-acceptance reply parses to null.
    expect(si.parseAcceptReply("flagship-accept:!!notbase64!!")).toBeNull();
    expect(si.parseAcceptReply("nonsense")).toBeNull();
  });

  it("inviteSecretFromLocation + inviteContextFromLocation parse v1 + v2 /invite landings", async () => {
    const si = await loadServiceInvite();
    // v1 bare secret.
    expect(si.inviteSecretFromLocation({ pathname: "/invite", hash: `#${VECTORS.secretHex}` })).toBe(VECTORS.secretHex);
    expect(si.inviteSecretFromLocation({ pathname: "/invite/", hash: `#k=${VECTORS.secretHex}` })).toBe(VECTORS.secretHex);
    expect(si.inviteSecretFromLocation({ pathname: "/home", hash: `#${VECTORS.secretHex}` })).toBeNull();
    expect(si.inviteSecretFromLocation({ pathname: "/invite", hash: "#nothex" })).toBeNull();
    // v1 context — secret only.
    expect(si.inviteContextFromLocation({ pathname: "/invite", hash: `#${VECTORS.secretHex}` })).toEqual({
      secret: VECTORS.secretHex,
      authorAID: null,
      inviteId: null,
    });
    // v2 context — carries the author AID + inviteId from the fragment.
    const v2Hash = `#k=${VECTORS.secretHex}&a=${VECTORS.derived.authorAidPubHex}&i=${VECTORS.inviteId}`;
    expect(si.inviteContextFromLocation({ pathname: "/invite", hash: v2Hash })).toEqual({
      secret: VECTORS.secretHex,
      authorAID: VECTORS.derived.authorAidPubHex,
      inviteId: VECTORS.inviteId,
    });
    // buildInviteLink round-trips both forms.
    expect(si.buildInviteLink("https://home.alice.flagship.services", VECTORS.secretHex)).toBe(
      `https://home.alice.flagship.services/invite#${VECTORS.secretHex}`,
    );
    expect(
      si.buildInviteLink("https://home.alice.flagship.services", VECTORS.secretHex, {
        authorAID: hexToBytes(VECTORS.derived.authorAidPubHex),
        inviteId: VECTORS.inviteId,
      }),
    ).toBe(`https://home.alice.flagship.services/invite${v2Hash}`);
  });
});
