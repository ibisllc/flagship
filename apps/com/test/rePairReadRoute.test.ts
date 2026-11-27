/**
 * Security report F3: GET /api/users/<u>/re-pair answers only the account's own
 * devices and servers (a read token, as /pods), and a demo account reads without one.
 * The pending row carries the initiate's signatures, which a stranger could otherwise
 * replay; anonymous callers get the same 401 /pods gives.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database, type DemoUserRecord } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  deriveIRK,
  ed,
  signAccountDirectoryRequest,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const HOST = "home.alice.flagship.services";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const stkSeed = new Uint8Array(32).fill(9);
const deviceSeed = new Uint8Array(32).fill(7);
const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const stk = hex(ed.getPublicKey(stkSeed));
const devicePub = hex(ed.getPublicKey(deviceSeed));
const PROOF = { issuedAt: 1_000, newIrkSignature: "cd".repeat(64), oldIrkSignature: "ef".repeat(64) };

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  for (const u of ["alice", "bob", "demo-ann"]) {
    await storage.usernames.put({ username: u, irkPubHex: hex(irk.publicKey), claimedAt: 1, ...(u === "demo-ann" ? { isDemo: true } : {}) });
    await storage.pendingRePairs.initiate({
      username: u, newIrkPubHex: "aa".repeat(32), oldIrkPubHex: hex(irk.publicKey),
      initiatedAt: 10, completesAt: 20, proof: PROOF,
    });
  }
  const demo: DemoUserRecord = {
    username: "demo-ann", idempotencyKey: "k", snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "r", size: "s",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state: "ready",
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  };
  await storage.demoUsers.insert(demo);
  await storage.servers.put({ serverDomain: HOST, username: "alice", identityPubKeyHex: stk, registeredAt: 1 });
  await storage.deviceIdentities.put({
    accountId: "alice", deviceId: DEVICE_ID, devicePubHex: devicePub, platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null,
  });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, storage, close: () => sqlite.close() };
}

async function mint(env: ControlPlaneEnv, init: { body: unknown; headers?: Record<string, string> }): Promise<string> {
  const r = await tryControlPlane(
    new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify(init.body),
    }),
    env,
  );
  expect(r!.status).toBe(200);
  return ((await r!.json()) as { token: string }).token;
}

function irkMint() {
  const now = Date.now();
  const claim = {
    username: "alice", endpointLabel: ACCOUNT_READ_TOKEN_LABEL, phoneIrkPub: irk.publicKey,
    issuedAt: now, expiresAt: now + 60_000, nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  return { body: { auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) }, authSignature: hex(signDeviceEndpointClaim(claim, irk)) } };
}

function boxMint() {
  const box = { username: "alice", serverDomain: HOST, stkPubHex: stk, issuedAt: Date.now(), nonceHex: hex(crypto.getRandomValues(new Uint8Array(16))) };
  return { body: { box, signature: signBoxReadTokenRequest(box, (m) => ed.sign(m, stkSeed)) } };
}

function deviceMint() {
  const requestId = hex(crypto.getRandomValues(new Uint8Array(16)));
  const issuedAt = Date.now();
  const request = {
    accountId: "alice", deviceId: DEVICE_ID, signerPubHex: devicePub, method: "POST",
    path: "/api/accounts/alice/read-token", requestId, issuedAt,
  };
  return {
    body: {},
    headers: {
      "x-flagship-device-id": DEVICE_ID,
      "x-flagship-device-pub": devicePub,
      "x-flagship-request-id": requestId,
      "x-flagship-issued-at": String(issuedAt),
      "x-flagship-signature": signAccountDirectoryRequest(request, { publicKey: ed.getPublicKey(deviceSeed), privateKey: deviceSeed }),
    },
  };
}

const get = (env: ControlPlaneEnv, user: string, token?: string) =>
  tryControlPlane(new Request(`${ORIGIN}/api/users/${user}/re-pair`, token ? { headers: { authorization: `Bearer ${token}` } } : {}), env);

describe("GET /api/users/<u>/re-pair is an account read (security report F3)", () => {
  it("refuses an anonymous caller with /pods's 401 and none of the row", async () => {
    const { env, close } = await setup();
    try {
      const anon = await get(env, "alice");
      expect(anon!.status).toBe(401);
      expect(anon!.headers.get("cache-control")).toBe("private, no-store");
      const text = await anon!.text();
      expect(text).not.toContain("aa".repeat(32));
      expect(text).not.toContain(PROOF.newIrkSignature);
      const pods = await tryControlPlane(new Request(`${ORIGIN}/api/users/alice/pods`), env);
      expect(pods!.status).toBe(401);
      expect(JSON.parse(text)).toEqual(await pods!.json());
    } finally {
      close();
    }
  });

  it("refuses a token for another account and a garbage token", async () => {
    const { env, close } = await setup();
    try {
      expect((await get(env, "alice", "not-a-token"))!.status).toBe(401);
      const token = await mint(env, irkMint());
      expect((await get(env, "alice", token))!.status).toBe(200);
      expect((await get(env, "bob", token))!.status).toBe(401);
    } finally {
      close();
    }
  });

  it("answers the box's own STK token with the proof the box verifies", async () => {
    const { env, close } = await setup();
    try {
      const r = await get(env, "alice", await mint(env, boxMint()));
      expect(r!.status).toBe(200);
      expect(r!.headers.get("cache-control")).toBe("private, no-store");
      const { pending } = (await r!.json()) as { pending: Record<string, unknown> };
      expect(pending.newIrkPub).toBe("aa".repeat(32));
      expect(pending.proof).toEqual(PROOF);
    } finally {
      close();
    }
  });

  it("answers a device token with what the clients read", async () => {
    const { env, close } = await setup();
    try {
      const r = await get(env, "alice", await mint(env, deviceMint()));
      expect(r!.status).toBe(200);
      const { pending } = (await r!.json()) as { pending: Record<string, unknown> };
      for (const k of ["newIrkPub", "oldIrkPub", "initiatedAt", "completesAt", "objectedAt", "vetoedBy"]) expect(pending).toHaveProperty(k);
    } finally {
      close();
    }
  });

  it("refuses a device token once the device is revoked", async () => {
    const { env, storage, close } = await setup();
    try {
      const token = await mint(env, deviceMint());
      await storage.deviceIdentities.revoke("alice", DEVICE_ID, 5);
      // The token names the removed device, so .com tells it so (it then erases the account's keys).
      const r = (await get(env, "alice", token))!;
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code?: string }).code).toBe("device-removed");
    } finally {
      close();
    }
  });

  it("answers a demo account without a token, as /pods does", async () => {
    const { env, close } = await setup();
    try {
      const r = await get(env, "demo-ann");
      expect(r!.status).toBe(200);
      expect(((await r!.json()) as { pending: { newIrkPub: string } }).pending.newIrkPub).toBe("aa".repeat(32));
    } finally {
      close();
    }
  });
});
