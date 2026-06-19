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
  type CreateServiceInvite,
  type RedeemServiceInvite,
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

      // list (author-owned)
      const listed = await tryControlPlane(
        new Request(
          `${ORIGIN}/api/users/alice/service-invites?authorAID=${hex(authorAid.publicKey)}`,
          { method: "GET" },
        ),
        env,
      );
      expect(listed!.status).toBe(200);
      const lb = (await listed!.json()) as { invites: { boundAID: string | null }[] };
      expect(lb.invites).toHaveLength(1);
      expect(lb.invites[0]!.boundAID).toBe(hex(friendAid.publicKey));
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
});
