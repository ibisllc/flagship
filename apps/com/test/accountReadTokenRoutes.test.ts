/**
 * Route wiring for account read tokens (docs/account-read-token.md) over a
 * real D1-over-sqlite binding: the private reads refuse without a token,
 * the IRK mints one at /api/accounts/<u>/read-token, and it opens /pods.
 * The owner's server order (docs/server-order.md) posts at
 * /api/accounts/<u>/server-order and comes back on /pods.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  deriveIRK,
  ed,
  signDeviceEndpointClaim,
  signServerOrder,
  type ServerOrder,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const stk = hex(ed.getPublicKey(new Uint8Array(32).fill(9)));

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: stk, registeredAt: 1 });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, close: () => sqlite.close() };
}

function irkBody() {
  const now = Date.now();
  const claim = {
    username: "alice",
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: irk.publicKey,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  return {
    auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) },
    authSignature: hex(signDeviceEndpointClaim(claim, irk)),
  };
}

describe("account read token routes", () => {
  it("refuses /pods without a token, mints with the IRK, then reads", async () => {
    const { env, close } = await setup();
    try {
      const bare = await tryControlPlane(new Request(`${ORIGIN}/api/users/alice/pods`), env);
      expect(bare!.status).toBe(401);
      const minted = await tryControlPlane(
        new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(irkBody()),
        }),
        env,
      );
      expect(minted!.status).toBe(200);
      const { token } = (await minted!.json()) as { token: string };
      const pods = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/pods`, { headers: { authorization: `Bearer ${token}` } }),
        env,
      );
      expect(pods!.status).toBe(200);
      expect(pods!.headers.get("cache-control")).toBe("private, no-store");
      expect(((await pods!.json()) as { pods: unknown[] }).pods).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("stores the owner's server order and returns it on /pods", async () => {
    const { env, close } = await setup();
    try {
      const order: ServerOrder = { user: "alice", stks: [stk], issuedAt: Date.now(), nonce: "ab".repeat(32) };
      const posted = await tryControlPlane(
        new Request(`${ORIGIN}/api/accounts/alice/server-order`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order, signature: signServerOrder(order, irk) }),
        }),
        env,
      );
      expect(posted!.status).toBe(200);
      const minted = await tryControlPlane(
        new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(irkBody()),
        }),
        env,
      );
      const { token } = (await minted!.json()) as { token: string };
      const pods = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/pods`, { headers: { authorization: `Bearer ${token}` } }),
        env,
      );
      const body = (await pods!.json()) as { serverOrder: { order: ServerOrder } | null };
      expect(body.serverOrder?.order.stks).toEqual([stk]);
    } finally {
      close();
    }
  });
});
