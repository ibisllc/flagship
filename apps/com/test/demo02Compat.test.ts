/**
 * The 0.2 investor demo (owner decision 2026-11-02, RELEASE-0.3-JOURNAL.md): a demo account used with the 0.2
 * store apps (iOS 1.1 build 5, Android versionCode 9) and its 0.2 box (release dbdf2e08) must keep working against
 * the 0.3 `.com`. These replay the 0.2 clients' requests as they send them (no read token, no PQ fields) and pin
 * what they get. A real account is the control: there 0.3's stricter rules apply.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database, type DemoUserRecord } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { deriveIRK, ed } from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const CONTROL = "control-secret";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const DEMO_BOX = hex(ed.getPublicKey(new Uint8Array(32).fill(9)));
const REAL_BOX = hex(ed.getPublicKey(new Uint8Array(32).fill(10)));
const DEMO_HOST = "home.demo02.flagship.services";
const REAL_HOST = "home.alice.flagship.services";

function demoRow(username: string): DemoUserRecord {
  return {
    username, idempotencyKey: `key-${username}`, snapshotId: null, isoR2Key: null, ttlIdleMinutes: 60, region: "r", size: "s",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: DEMO_HOST, lastActivityAt: 1, state: "ready",
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  };
}

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  for (const u of ["demo02", "alice"]) await storage.usernames.put({ username: u, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.demoUsers.insert(demoRow("demo02"));
  await storage.servers.put({ serverDomain: DEMO_HOST, username: "demo02", identityPubKeyHex: DEMO_BOX, registeredAt: 1 });
  await storage.servers.put({ serverDomain: REAL_HOST, username: "alice", identityPubKeyHex: REAL_BOX, registeredAt: 1 });
  const env: ControlPlaneEnv = {
    DB: sqlite as unknown as D1Database,
    ACCOUNT_READ_TOKEN_SECRET: "route-secret",
    SERVICES_CONTROL_SECRET: CONTROL,
    SERVING_REVOCATION_SEED: "11".repeat(32),
  };
  return { env, close: () => sqlite.close() };
}

const call = async (env: ControlPlaneEnv, method: string, path: string, headers: Record<string, string> = {}) =>
  (await tryControlPlane(new Request(`${ORIGIN}${path}`, { method, headers }), env, { stream: { sleep: async () => {} } }))!;

describe("0.2 demo clients against the 0.3 .com", () => {
  it("Home: the 0.2 app reads pods, stream and device grants with no read token", async () => {
    const { env, close } = await setup();
    try {
      const pods = await call(env, "GET", "/api/users/demo02/pods");
      expect(pods.status).toBe(200);
      const body = (await pods.json()) as { pods?: Array<{ serverDomain?: string; fqdn?: string }> };
      expect(JSON.stringify(body)).toContain(DEMO_HOST);
      expect((await call(env, "GET", "/api/users/demo02/stream")).status).toBe(200);
      expect((await call(env, "GET", "/api/users/demo02/device-grants")).status).toBe(200);
      // Control: a real account needs its token.
      expect((await call(env, "GET", "/api/users/alice/pods")).status).toBe(401);
    } finally {
      close();
    }
  });

  it("the demo's 0.2 box gets no \"needs an update\" on /pods: Flagship updates it itself", async () => {
    const { env, close } = await setup();
    try {
      const storage = new D1Storage(env.DB as D1Database);
      // A 0.2 heartbeat: no boxLevel beside the signed report.
      const report = { serverDomain: DEMO_HOST, certSha256: null, certValidUntil: 1_900_000_000_000, certIssuer: null, appsServed: [], nonce: "00".repeat(16), issuedAt: 1 };
      await storage.daemonStatus.put({
        serverDomain: DEMO_HOST, certSha256: null, certValidUntil: 1_900_000_000_000, certIssuer: null,
        servicesServedJson: "[]", lastReported: Date.now(), reportJson: JSON.stringify(report), signatureHex: "00".repeat(64),
      });
      const body = (await (await call(env, "GET", "/api/users/demo02/pods")).json()) as { pods: Array<{ updateRequired?: unknown }> };
      expect(body.pods).toHaveLength(1);
      expect(body.pods[0]?.updateRequired).toBeUndefined();
    } finally {
      close();
    }
  });

  it("the 0.2 box's tokenless deposit reads still pass on a demo account (a real account's get 401)", async () => {
    const { env, close } = await setup();
    try {
      for (const d of ["pairing-deposit", "swk-deposit", "cgk-deposit", "entitlement-deposit"]) {
        expect((await call(env, "GET", `/api/server/${DEMO_HOST}/${d}`)).status, d).not.toBe(401);
        expect((await call(env, "GET", `/api/server/${REAL_HOST}/${d}`)).status, d).toBe(401);
      }
    } finally {
      close();
    }
  });

  it("the 0.2 phone's tokenless sealed-luks-key read passes on a demo account (a real account's gets 401)", async () => {
    const { env, close } = await setup();
    try {
      expect((await call(env, "GET", `/api/server/${DEMO_HOST}/sealed-luks-key`)).status).toBe(404);
      expect((await call(env, "GET", `/api/server/${REAL_HOST}/sealed-luks-key`)).status).toBe(401);
    } finally {
      close();
    }
  });

  it("apps over HTTPS: the relay's record lets a demo box that pins no admin key (0.2) be judged under .com's key", async () => {
    const { env, close } = await setup();
    try {
      const auth = { authorization: `Bearer ${CONTROL}` };
      const demo = (await (await call(env, "GET", `/api/internal/serving/demo02/${DEMO_BOX}`, auth)).json()) as Record<string, unknown>;
      expect(demo.adminKeyHeldByCom).toBe(true);
      const real = (await (await call(env, "GET", `/api/internal/serving/alice/${REAL_BOX}`, auth)).json()) as Record<string, unknown>;
      expect(real.adminKeyHeldByCom).toBeUndefined();
    } finally {
      close();
    }
  });

  it("known break, kept on purpose: a 0.2 box can't renew its certificate through DNS-01 (410)", async () => {
    const { env, close } = await setup();
    try {
      const r = await call(env, "POST", "/api/dns-01/publish", { "content-type": "application/json" });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { code: string }).code).toBe("dns01-retired");
    } finally {
      close();
    }
  });
});
