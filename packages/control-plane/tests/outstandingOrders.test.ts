import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { InMemoryStorage, type AuthCodeRecord } from "@flagship/storage";
import { handleListOutstandingOrders } from "../src/outstandingOrders.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function keypair(seed: number) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

const harry = keypair(1);
const mallory = keypair(2);
const NOW = 1_700_000_000_000;

const TAG = "flagship/outstanding-orders/v1";
function signList(kp: { privateKey: Uint8Array }, username: string, issuedAt: number): string {
  const bytes = new TextEncoder().encode([TAG, username, issuedAt].join("|"));
  return bytesToHex(ed.sign(bytes, kp.privateKey));
}

async function setUp() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: "harry",
    irkPubHex: bytesToHex(harry.publicKey),
    claimedAt: NOW - 100_000,
  });
  return storage;
}

function authCode(
  serial: string,
  serverName: string,
  overrides: Partial<AuthCodeRecord> = {},
): AuthCodeRecord {
  return {
    serial,
    username: "harry",
    serverName,
    serverDomain: `${serverName}.harry.flagship.services`,
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: bytesToHex(harry.publicKey),
    userSignatureHex: "00".repeat(64),
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 3_600_000,
    status: "active",
    recordedAt: NOW - 10_000,
    ...overrides,
  };
}

function body(kp = harry, username = "harry", issuedAt = NOW) {
  return {
    request: { username, issuedAt },
    signature: signList(kp, username, issuedAt),
  };
}

const deps = (storage: InMemoryStorage) => ({
  authCodes: storage.authCodes,
  usernames: storage.usernames,
  provisionStatus: storage.provisionStatus,
  now: () => NOW,
});

describe("POST /api/users/:u/outstanding-orders", () => {
  it("lists active, unexpired orders for a valid IRK signature", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("AAAAAAAA", "home1"));
    await storage.authCodes.put(authCode("BBBBBBBB", "home2"));

    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    expect(r.status).toBe(200);
    const out = r.body as { orders: Array<{ serial: string; serverName: string; fqdn: string; phase: string | null }> };
    expect(out.orders.map((o) => o.serial).sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
    const home2 = out.orders.find((o) => o.serverName === "home2");
    expect(home2?.fqdn).toBe("home2.harry.flagship.services");
    expect(home2?.phase).toBeNull();
  });

  it("joins the latest provisioning phase by serial", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("AAAAAAAA", "home2"));
    await storage.provisionStatus.putProvisionStatus("AAAAAAAA", {
      phase: "registering",
      ts: NOW - 5_000,
    });

    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    const out = r.body as { orders: Array<{ serial: string; phase: string | null }> };
    expect(out.orders[0]?.phase).toBe("registering");
  });

  it("403 when signed by a different IRK than the registered one", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("AAAAAAAA", "home1"));
    const r = await handleListOutstandingOrders(
      deps(storage),
      "harry",
      body(mallory),
    );
    expect(r.status).toBe(403);
  });

  it("excludes USED codes (a box that already registered)", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("USEDCODE1", "home1", { status: "used", usedAt: NOW - 1_000 }));
    await storage.authCodes.put(authCode("LIVECODE1", "home2"));
    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    const out = r.body as { orders: Array<{ serial: string }> };
    expect(out.orders.map((o) => o.serial)).toEqual(["LIVECODE1"]);
  });

  it("excludes REVOKED codes (a cancelled order)", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("REVOKED01", "home1", { status: "revoked", revokedAt: NOW - 1_000 }));
    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    const out = r.body as { orders: unknown[] };
    expect(out.orders).toHaveLength(0);
  });

  it("excludes EXPIRED codes", async () => {
    const storage = await setUp();
    await storage.authCodes.put(authCode("EXPIRED01", "home1", { expiresAt: NOW - 1 }));
    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    const out = r.body as { orders: unknown[] };
    expect(out.orders).toHaveLength(0);
  });

  it("403 when the signed username doesn't match the path", async () => {
    const storage = await setUp();
    // Sign for "harry" but request a different path user.
    const r = await handleListOutstandingOrders(deps(storage), "someoneelse", body());
    expect(r.status).toBe(403);
  });

  it("404 when the username isn't registered", async () => {
    const storage = new InMemoryStorage();
    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    expect(r.status).toBe(404);
  });

  it("403 on a stale request", async () => {
    const storage = await setUp();
    const r = await handleListOutstandingOrders(
      deps(storage),
      "harry",
      body(harry, "harry", NOW - 10 * 60_000),
    );
    expect(r.status).toBe(403);
  });

  it("400 on a malformed body", async () => {
    const storage = await setUp();
    const r = await handleListOutstandingOrders(deps(storage), "harry", { request: {} });
    expect(r.status).toBe(400);
  });

  it("does not leak another account's orders", async () => {
    const storage = await setUp();
    await storage.usernames.put({
      username: "mallory",
      irkPubHex: bytesToHex(mallory.publicKey),
      claimedAt: NOW - 100_000,
    });
    await storage.authCodes.put(authCode("HARRYS001", "home1"));
    await storage.authCodes.put(
      authCode("MALLORY01", "evil", { username: "mallory" }),
    );
    const r = await handleListOutstandingOrders(deps(storage), "harry", body());
    const out = r.body as { orders: Array<{ serial: string }> };
    expect(out.orders.map((o) => o.serial)).toEqual(["HARRYS001"]);
  });
});
