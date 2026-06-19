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
  signServiceVisitProof,
  verifyServiceVisitProof,
  signKnockAuthorization,
  verifyKnockAuthorization,
  type CreateServiceInvite,
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
  visit: { issuedAt: number; sigHex: string };
  knock: { pageId: string; issuedAt: number; sigHex: string };
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

  it("createInvite POSTs the IRK-signed envelope .com verifies + returns a /invite#<secret> link", async () => {
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
        authorDevicePub: authorIrk.publicKey,
        counter: 0,
        serviceRef: VECTORS.serviceRef,
        bundle: { name: "Alex" },
        householdKey: deriveHouseholdKey(authorUmk),
        umk: authorUmk.seed,
        signWithIrk: signIrk(authorIrk.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => VECTORS.create.issuedAt, randomBytes: () => fixedSecret },
    );
    expect(calls[0]!.url).toBe(`${COM}/api/users/alice/service-invites`);
    expect(r.inviteId).toBe(VECTORS.inviteId);
    expect(r.secretHex).toBe(VECTORS.secretHex);
    expect(r.link).toBe(`${POD}/invite#${VECTORS.secretHex}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.request.authorAID).toBe(VECTORS.derived.authorAidPubHex);
    expect(body.request.secretHash).toBe(VECTORS.secretHash);
    // The signature .com receives is over the create canonical bytes (the pinned form differs only in encryptedBundle).
    const create: CreateServiceInvite = {
      inviteId: body.request.inviteId,
      authorAID: hexToBytes(body.request.authorAID),
      serviceRef: body.request.serviceRef,
      secretHash: body.request.secretHash,
      encryptedBundle: body.request.encryptedBundle,
      issuedAt: body.request.issuedAt,
    };
    const sig = hexToBytes(body.signature);
    expect(verifyCreateServiceInvite(create, sig, authorIrk.publicKey)).toBe(true);
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
    // The AID sig the box receives is exactly the pinned redeem signature.
    expect(captured!.body.aidSig).toBe(VECTORS.redeem.sigHex);
    const redeem = { secretHash: VECTORS.secretHash, visitorAID: friendAid.publicKey, redeemedAt: VECTORS.redeem.redeemedAt };
    expect(verifyRedeemServiceInvite(redeem, hexToBytes(captured!.body.aidSig), friendAid.publicKey)).toBe(true);

    // 409 maps to a friendly "already linked" error.
    const f409 = async () => ({ ok: false, status: 409, text: async () => "" }) as Response;
    await expect(
      si.redeemInvite(
        { baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: friendUmk.seed, signWithAccountId: signAid(friendAid.privateKey) },
        { fetch: f409 as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "409" });
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

  it("locked webapp guards (no umk / signer) on create + redeem + set-mode + authorize", async () => {
    const si = await loadServiceInvite();
    await expect(si.createInvite({ comBase: COM, username: "alice", podBaseUrl: POD, authorAID: authorAid.publicKey, authorDevicePub: authorIrk.publicKey, counter: 0, serviceRef: "x", bundle: { name: "y" }, householdKey: deriveHouseholdKey(authorUmk), umk: null, signWithIrk: null })).rejects.toThrow(/unlock/i);
    await expect(si.redeemInvite({ baseUrl: POD, secretHex: VECTORS.secretHex, visitorAID: friendAid.publicKey, umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
    await expect(si.setServiceAccessMode({ baseUrl: POD, serviceRef: "x", mode: "open", umk: null, signWithIrk: null })).rejects.toThrow(/unlock/i);
    await expect(si.authorizeKnock({ serverId: VECTORS.serverId, serviceRef: "x", pageId: "p", svc: "s", visitorAID: friendAid.publicKey, umk: null, signWithAccountId: null })).rejects.toThrow(/unlock/i);
  });

  it("inviteSecretFromLocation parses a /invite#<secret> landing (and rejects other paths)", async () => {
    const si = await loadServiceInvite();
    expect(si.inviteSecretFromLocation({ pathname: "/invite", hash: `#${VECTORS.secretHex}` })).toBe(VECTORS.secretHex);
    expect(si.inviteSecretFromLocation({ pathname: "/invite/", hash: `#k=${VECTORS.secretHex}` })).toBe(VECTORS.secretHex);
    expect(si.inviteSecretFromLocation({ pathname: "/home", hash: `#${VECTORS.secretHex}` })).toBeNull();
    expect(si.inviteSecretFromLocation({ pathname: "/invite", hash: "#nothex" })).toBeNull();
  });
});
