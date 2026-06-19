/**
 * Route-wiring tests for the service-access capability-invite endpoints
 * (docs/service-access-gating.md): create / redeem / revoke / list. Targets
 * `tryControlPlane` over a REAL D1-over-sqlite binding so the dispatch +
 * status codes (incl. the registered-IRK gate + the first-bind redeem) are
 * exercised end to end. Deep functional coverage lives in
 * packages/control-plane/tests/serviceInvites.test.ts.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signServiceInviteCreateQuery,
  signServiceInviteListQuery,
  type CreateServiceInvite,
  type Keypair,
  type RedeemServiceInvite,
  type ServiceInviteCreateQuery,
  type ServiceInviteListQuery,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const NOW = Date.now();

const authorUmk = { seed: new Uint8Array(32).fill(11) };
const friendUmk = { seed: new Uint8Array(32).fill(22) };
const authorIrk = deriveIRK(authorUmk);
const authorAid = deriveAccountId(authorUmk);
const authorDevice = deriveIRK(authorUmk);
const friendAid = deriveAccountId(friendUmk);
const householdKey = deriveHouseholdKey(authorUmk);
const SECRET = new Uint8Array(32).fill(7);
const SECRET_HASH = serviceInviteSecretHash(SECRET);

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function envWithAlice(): Promise<{ env: ControlPlaneEnv; close: () => void }> {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
  return { env: { DB: sqlite as unknown as D1Database }, close: () => sqlite.close() };
}

function createPayload() {
  const inviteId = serviceInviteId(authorAid.publicKey, authorDevice.publicKey, 0);
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: authorAid.publicKey,
    serviceRef: "alice-notes",
    secretHash: SECRET_HASH,
    encryptedBundle: sealInviteBundle({ name: "Alex" }, householdKey, inviteId),
    issuedAt: NOW,
  };
  const sig = signCreateServiceInvite(create, authorIrk);
  return {
    inviteId,
    body: {
      request: {
        inviteId,
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

/** Build a signed list/revoked-since URL (the owner-signed query, v2 §C2). */
function signedListUrl(scope: "list" | "revoked-since", cursor = 0): string {
  const query: ServiceInviteListQuery = {
    username: "alice",
    authorAID: hex(authorAid.publicKey),
    scope,
    cursor: scope === "list" ? 0 : cursor,
    issuedAt: NOW,
  };
  const sig = hex(signServiceInviteListQuery(query, authorIrk));
  const base = scope === "list" ? "service-invites" : "service-invites/revoked-since";
  return `${ORIGIN}/api/users/alice/${base}?authorAID=${query.authorAID}&scope=${scope}&cursor=${query.cursor}&issuedAt=${query.issuedAt}&sig=${sig}`;
}

describe("service-invite routes — dispatch over real D1", () => {
  it("create → redeem(first-bind) → list → reflects the bind", async () => {
    const { env, close } = await envWithAlice();
    try {
      const { body: createBody } = createPayload();
      const created = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites`, {
          method: "POST",
          body: JSON.stringify(createBody),
        }),
        env,
      );
      expect(created!.status).toBe(200);

      // redeem (friend AID-signed)
      const redeem: RedeemServiceInvite = {
        secretHash: SECRET_HASH,
        visitorAID: friendAid.publicKey,
        redeemedAt: NOW,
      };
      const aidSig = signRedeemServiceInvite(redeem, friendAid);
      const redeemed = await tryControlPlane(
        new Request(`${ORIGIN}/api/service-invites/redeem`, {
          method: "POST",
          body: JSON.stringify({
            secretHash: SECRET_HASH,
            visitorAID: hex(friendAid.publicKey),
            aidSig: hex(aidSig),
            redeemedAt: NOW,
          }),
        }),
        env,
      );
      expect(redeemed!.status).toBe(200);
      const rb = (await redeemed!.json()) as { firstBind: boolean; boundAID: string };
      expect(rb.firstBind).toBe(true);
      expect(rb.boundAID).toBe(hex(friendAid.publicKey));

      // list (owner-SIGNED — v2 §C2)
      const listed = await tryControlPlane(
        new Request(signedListUrl("list"), { method: "GET" }),
        env,
      );
      expect(listed!.status).toBe(200);
      const lb = (await listed!.json()) as { invites: { boundAID: string | null }[] };
      expect(lb.invites).toHaveLength(1);
      expect(lb.invites[0]!.boundAID).toBe(hex(friendAid.publicKey));

      // an UNSIGNED list is rejected (the open graph dump is closed)
      const unsigned = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites?authorAID=${hex(authorAid.publicKey)}`, {
          method: "GET",
        }),
        env,
      );
      expect(unsigned!.status).toBe(400);
    } finally {
      close();
    }
  });

  it("revoke → revoked-since route reflects the revocation (owner-signed)", async () => {
    const { env, close } = await envWithAlice();
    try {
      const { inviteId, body: createBody } = createPayload();
      await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites`, {
          method: "POST",
          body: JSON.stringify(createBody),
        }),
        env,
      );
      const redeem: RedeemServiceInvite = { secretHash: SECRET_HASH, visitorAID: friendAid.publicKey, redeemedAt: NOW };
      await tryControlPlane(
        new Request(`${ORIGIN}/api/service-invites/redeem`, {
          method: "POST",
          body: JSON.stringify({
            secretHash: SECRET_HASH,
            visitorAID: hex(friendAid.publicKey),
            aidSig: hex(signRedeemServiceInvite(redeem, friendAid)),
            redeemedAt: NOW,
          }),
        }),
        env,
      );
      const { signRevokeServiceInvite } = await import("@flagship/protocol");
      await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites/revoke`, {
          method: "POST",
          body: JSON.stringify({
            request: { inviteId, issuedAt: NOW },
            signature: hex(signRevokeServiceInvite({ inviteId, issuedAt: NOW }, authorIrk)),
          }),
        }),
        env,
      );
      const since = await tryControlPlane(
        new Request(signedListUrl("revoked-since", 0), { method: "GET" }),
        env,
      );
      expect(since!.status).toBe(200);
      const sb = (await since!.json()) as {
        revoked: { inviteId: string; boundAIDs: string[] }[];
        cursor: number;
      };
      expect(sb.revoked).toHaveLength(1);
      expect(sb.revoked[0]!.inviteId).toBe(inviteId);
      expect(sb.revoked[0]!.boundAIDs).toEqual([hex(friendAid.publicKey)]);
    } finally {
      close();
    }
  });

  it("revoke route denies a subsequent redeem (403)", async () => {
    const { env, close } = await envWithAlice();
    try {
      const { inviteId, body: createBody } = createPayload();
      await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites`, {
          method: "POST",
          body: JSON.stringify(createBody),
        }),
        env,
      );
      // revoke (author IRK-signed)
      const { signRevokeServiceInvite } = await import("@flagship/protocol");
      const sig = signRevokeServiceInvite({ inviteId, issuedAt: NOW }, authorIrk);
      const revoked = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites/revoke`, {
          method: "POST",
          body: JSON.stringify({ request: { inviteId, issuedAt: NOW }, signature: hex(sig) }),
        }),
        env,
      );
      expect(revoked!.status).toBe(200);

      const redeem: RedeemServiceInvite = { secretHash: SECRET_HASH, visitorAID: friendAid.publicKey, redeemedAt: NOW };
      const aidSig = signRedeemServiceInvite(redeem, friendAid);
      const denied = await tryControlPlane(
        new Request(`${ORIGIN}/api/service-invites/redeem`, {
          method: "POST",
          body: JSON.stringify({
            secretHash: SECRET_HASH,
            visitorAID: hex(friendAid.publicKey),
            aidSig: hex(aidSig),
            redeemedAt: NOW,
          }),
        }),
        env,
      );
      expect(denied!.status).toBe(403);
    } finally {
      close();
    }
  });

  it("redeem with a malformed body → 400 (dispatch reached)", async () => {
    const { env, close } = await envWithAlice();
    try {
      const r = await tryControlPlane(
        new Request(`${ORIGIN}/api/service-invites/redeem`, {
          method: "POST",
          body: JSON.stringify({ visitorAID: "nope" }),
        }),
        env,
      );
      expect(r!.status).toBe(400);
    } finally {
      close();
    }
  });

  it("create under an unregistered username → 404", async () => {
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database };
      const { body } = createPayload();
      const r = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/ghost/service-invites`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        env,
      );
      expect(r!.status).toBe(404);
    } finally {
      sqlite.close();
    }
  });

  it("GET /service-invites/:inviteId/create → returns {create, createSig} for a box STK-signed query", async () => {
    const sqlite = createSqliteD1();
    const storage = new D1Storage(sqlite as unknown as D1Database);
    await storage.usernames.put({ username: "alice", irkPubHex: hex(authorIrk.publicKey), claimedAt: 1 });
    const stk: Keypair = deriveIRK({ seed: new Uint8Array(32).fill(150) });
    const serverDomain = "home.alice.flagship.services";
    await storage.servers.put({
      serverDomain,
      username: "alice",
      identityPubKeyHex: hex(stk.publicKey),
      registeredAt: 1,
    });
    const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database };
    try {
      const { inviteId, body: createBody } = createPayload();
      await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/service-invites`, { method: "POST", body: JSON.stringify(createBody) }),
        env,
      );
      const query: ServiceInviteCreateQuery = { username: "alice", inviteId, serverDomain, issuedAt: NOW };
      const sig = hex(signServiceInviteCreateQuery(query, stk));
      const url = `${ORIGIN}/api/users/alice/service-invites/${inviteId}/create?serverDomain=${encodeURIComponent(serverDomain)}&issuedAt=${NOW}&sig=${sig}`;
      const res = await tryControlPlane(new Request(url, { method: "GET" }), env);
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as { create: { inviteId: string; serviceRef: string }; createSig: string };
      expect(body.create.inviteId).toBe(inviteId);
      expect(body.create.serviceRef).toBe("alice-notes");
      expect(body.createSig).toMatch(/^[0-9a-f]{128}$/);

      // A query NOT signed by the registered STK is rejected (403).
      const wrong = deriveIRK({ seed: new Uint8Array(32).fill(151) });
      const badSig = hex(signServiceInviteCreateQuery(query, wrong));
      const badUrl = `${ORIGIN}/api/users/alice/service-invites/${inviteId}/create?serverDomain=${encodeURIComponent(serverDomain)}&issuedAt=${NOW}&sig=${badSig}`;
      const denied = await tryControlPlane(new Request(badUrl, { method: "GET" }), env);
      expect(denied!.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });
});
