/**
 * docs/account-gone.md: a signed-in client whose account no longer exists gets
 * one stable answer, `404 {error, code: "account-not-found"}`, from every
 * account route it calls on its own, before any auth check. A real account
 * and a demo account keep their normal answers.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { route, type RouteEnv } from "../src/route.js";
import { D1Storage, type D1Database, type DemoUserRecord } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { ACCOUNT_READ_TOKEN_LABEL, deriveIRK, signDeviceEndpointClaim } from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function demoRow(username: string, state: DemoUserRecord["state"]): DemoUserRecord {
  return {
    username, idempotencyKey: `key-${username}`, snapshotId: null, isoR2Key: null, ttlIdleMinutes: 60, region: "r", size: "s",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state,
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  };
}

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  for (const u of ["demo-ok", "demo-gone"]) {
    await storage.usernames.put({ username: u, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  }
  await storage.demoUsers.insert(demoRow("demo-ok", "ready"));
  await storage.demoUsers.insert(demoRow("demo-gone", "cleanup-only"));
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, sqlite, close: () => sqlite.close() };
}

function irkBody(username: string) {
  const now = Date.now();
  const claim = {
    username,
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

const call = (env: ControlPlaneEnv, method: string, path: string, headers: Record<string, string> = {}) =>
  tryControlPlane(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    }),
    env,
  );

const OWN_ROUTES: [string, string][] = [
  ["POST", "/api/accounts/{u}/read-token"],
  ["GET", "/api/users/{u}/pods"],
  ["GET", "/api/users/{u}/stream"],
  ["GET", "/api/users/{u}/audit"],
  ["GET", "/api/users/{u}/apps/aliases"],
  ["GET", "/api/users/{u}/apps/some-app/links"],
  ["GET", "/api/users/{u}/device-grants"],
  ["POST", "/api/users/{u}/device-grants"],
  ["POST", "/api/users/{u}/device-grants/revoke"],
  ["GET", "/api/accounts/{u}/profile"],
  ["PUT", "/api/accounts/{u}/profile"],
  ["GET", "/api/accounts/{u}/directory"],
  ["PUT", "/api/accounts/{u}/devices/aa/profile"],
  ["PUT", "/api/accounts/{u}/devices/aa/managed-profile"],
  ["GET", "/api/accounts/{u}/devices/aa/directory-key-grant"],
  ["DELETE", "/api/accounts/{u}/devices/aa"],
  ["POST", "/api/accounts/{u}/server-order"],
  ["POST", "/api/users/{u}/outstanding-orders"],
  ["GET", "/api/users/{u}"],
  ["GET", "/api/users/{u}/re-pair"],
  ["GET", "/api/users/{u}/trust-exceptions"],
  ["GET", "/api/users/{u}/service-invites"],
  ["POST", "/api/users/{u}/server-shares/list"],
  ["GET", "/api/users/{u}/watch-delegates"],
  ["GET", "/api/users/{u}/acme-account-keys"],
  ["GET", "/api/users/{u}/admin-root-rotations"],
];

describe("account-not-found", () => {
  it("every own-account route answers 404 account-not-found for a missing account", async () => {
    const { env, close } = await setup();
    try {
      for (const [method, tpl] of OWN_ROUTES) {
        const path = tpl.replace("{u}", "ghost");
        const r = await call(env, method, path, { authorization: "Bearer art1.stale.token" });
        expect(r, `${method} ${path}`).not.toBeNull();
        expect(r!.status, `${method} ${path}`).toBe(404);
        expect(await r!.json(), `${method} ${path}`).toEqual({
          error: "account-not-found",
          code: "account-not-found",
        });
        expect(r!.headers.get("cache-control")).toBe("private, no-store");
      }
    } finally {
      close();
    }
  });

  it("matches case-insensitively and names no other account", async () => {
    const { env, close } = await setup();
    try {
      const r = await call(env, "GET", "/api/users/Ghost/pods");
      const text = await r!.text();
      expect(r!.status).toBe(404);
      expect(text).not.toContain("alice");
      const real = await call(env, "GET", "/api/users/ALICE/pods");
      expect(real!.status).toBe(401);
    } finally {
      close();
    }
  });

  it("a real account keeps its normal answers", async () => {
    const { env, close } = await setup();
    try {
      expect((await call(env, "GET", "/api/users/alice/pods"))!.status).toBe(401);
      const minted = await call(env, "POST", "/api/accounts/alice/read-token");
      expect(minted!.status).toBe(403);
      const ok = await tryControlPlane(
        new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(irkBody("alice")),
        }),
        env,
      );
      expect(ok!.status).toBe(200);
      const { token } = (await ok!.json()) as { token: string };
      const auth = { authorization: `Bearer ${token}` };
      for (const p of ["pods", "stream", "audit", "device-grants"]) {
        const r = await call(env, "GET", `/api/users/alice/${p}`, auth);
        expect(r!.status, p).toBe(200);
      }
      expect((await call(env, "GET", "/api/users/alice/re-pair"))!.status).toBe(200);
      expect((await call(env, "GET", "/api/users/alice/trust-exceptions"))!.status).toBe(200);
    } finally {
      close();
    }
  });

  it("a demo account still reads without a token; a demo being cleaned up is gone", async () => {
    const { env, close } = await setup();
    try {
      expect((await call(env, "GET", "/api/users/demo-ok/pods"))!.status).toBe(200);
      expect((await call(env, "GET", "/api/users/demo-ok/stream"))!.status).toBe(200);
      const gone = await call(env, "GET", "/api/users/demo-gone/pods");
      expect(gone!.status).toBe(404);
      expect(((await gone!.json()) as { code: string }).code).toBe("account-not-found");
    } finally {
      close();
    }
  });

  it("leaves lookups other accounts make, and sign-in, as they were", async () => {
    const { env, close } = await setup();
    try {
      const cert = await call(env, "GET", "/api/users/ghost/pubkey-cert");
      expect(cert!.status).toBe(404);
      expect(await cert!.json()).toEqual({ error: "username not registered" });
      const resolve = await call(env, "GET", "/api/account/resolve/ghost");
      expect(resolve!.status).toBe(200);
      expect(((await resolve!.json()) as { kind: string }).kind).toBe("unknown");
      const check = await call(env, "POST", "/api/users/check");
      expect(check!.status).not.toBe(404);
    } finally {
      close();
    }
  });

  it("is served through the Worker entry as well", async () => {
    const { sqlite, close } = await setup();
    try {
      const env: RouteEnv = {
        SERVICES_BASE_URL: "https://flagship.services",
        ASSETS: { async fetch() { return new Response("asset"); } },
        DB: sqlite as unknown as D1Database,
        ACCOUNT_READ_TOKEN_SECRET: "route-secret",
      } as RouteEnv;
      const r = await route(new Request(`${ORIGIN}/api/users/ghost/pods`, { headers: { cookie: "flagship_preview=1" } }), env);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { code: string }).code).toBe("account-not-found");
    } finally {
      close();
    }
  });
});
