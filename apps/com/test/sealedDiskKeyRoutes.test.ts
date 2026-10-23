/**
 * The disk key `.com` holds sealed to the account IRK is read only with the
 * account's read token (a device or the IRK), and the box-sealed lease only
 * with that box's own STK token: an anonymous caller collects neither.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  deriveIRK,
  ed,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const HOST = "home.alice.flagship.services";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const stkSeed = new Uint8Array(32).fill(9);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const stk = hex(ed.getPublicKey(stkSeed));
const SEALED = "ab".repeat(80);

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: HOST, username: "alice", identityPubKeyHex: stk, registeredAt: 1 });
  await storage.luksKeys.putSealed({ serverDomain: HOST, sealedKeyHex: SEALED, sealedAt: 2 });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, close: () => sqlite.close() };
}

async function mint(env: ControlPlaneEnv, body: unknown): Promise<string> {
  const r = await tryControlPlane(
    new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  expect(r!.status).toBe(200);
  return ((await r!.json()) as { token: string }).token;
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

function boxBody() {
  const box = { username: "alice", serverDomain: HOST, stkPubHex: stk, issuedAt: Date.now(), nonceHex: hex(crypto.getRandomValues(new Uint8Array(16))) };
  return { box, signature: signBoxReadTokenRequest(box, (m) => ed.sign(m, stkSeed)) };
}

const get = (env: ControlPlaneEnv, path: string, token?: string) =>
  tryControlPlane(new Request(`${ORIGIN}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}), env);

describe("sealed disk key routes", () => {
  it("refuses an anonymous read of the sealed disk key and answers the account's IRK token", async () => {
    const { env, close } = await setup();
    try {
      const anon = await get(env, `/api/server/${HOST}/sealed-luks-key`);
      expect(anon!.status).toBe(401);
      expect(await anon!.text()).not.toContain(SEALED);
      const ok = await get(env, `/api/server/${HOST}/sealed-luks-key`, await mint(env, irkBody()));
      expect(ok!.status).toBe(200);
      expect(ok!.headers.get("cache-control")).toBe("private, no-store");
      expect(((await ok!.json()) as { sealedKey: string }).sealedKey).toBe(SEALED);
    } finally {
      close();
    }
  });

  it("refuses the box's own token for the disk key deposit", async () => {
    const { env, close } = await setup();
    try {
      expect((await get(env, `/api/server/${HOST}/sealed-luks-key`, await mint(env, boxBody())))!.status).toBe(401);
    } finally {
      close();
    }
  });

  it("releases the box-sealed lease only to that box's STK token", async () => {
    const { env, close } = await setup();
    try {
      expect((await get(env, `/api/server/${HOST}/unlock-key/lease-v2`))!.status).toBe(401);
      expect((await get(env, `/api/server/${HOST}/unlock-key/lease-v2`, await mint(env, irkBody())))!.status).toBe(401);
      // With the box's token the read goes through (no lease on file here, so 404).
      expect((await get(env, `/api/server/${HOST}/unlock-key/lease-v2`, await mint(env, boxBody())))!.status).toBe(404);
    } finally {
      close();
    }
  });
});
