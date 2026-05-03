import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  deriveSTK,
  signRegisterServer,
  type RegisterServer,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryServerRegistry,
  authLookupFromRegistry,
} from "../src/routes/serverRegistry.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const harrySwk = deriveSWK(harryUmk, "srv-1");
const harryStk = deriveSTK(harrySwk);

const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeApp(extra: { registry?: InMemoryServerRegistry } = {}) {
  const registry = extra.registry ?? new InMemoryServerRegistry();
  const app = buildServer({
    serverRegistry: registry,
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  return { app, registry };
}

describe("serverRegistry route — IRK-signed server registration", () => {
  function buildSignedRegistration(
    over: Partial<RegisterServer> & { signWith?: typeof harryIrk } = {},
  ) {
    const reg: RegisterServer = {
      userId: over.userId ?? "harry",
      serverId: over.serverId ?? "srv-1",
      stkPub: over.stkPub ?? harryStk.publicKey,
      issuedAt: over.issuedAt ?? Date.now(),
    };
    const sig = signRegisterServer(reg, over.signWith ?? harryIrk);
    return {
      request: {
        userId: reg.userId,
        serverId: reg.serverId,
        stkPub: bytesToHex(reg.stkPub),
        issuedAt: reg.issuedAt,
      },
      signature: bytesToHex(sig),
    };
  }

  it("accepts a valid registration and stores it", async () => {
    const { app, registry } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload: buildSignedRegistration(),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(registry.get("srv-1")?.userId).toBe("harry");
    expect(registry.get("srv-1")?.stkPub).toEqual(harryStk.publicKey);
  });

  it("rejects an unknown user", async () => {
    const { app } = makeApp();
    const payload = buildSignedRegistration({ userId: "ghost" });
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload,
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects when the signature was made by a different IRK (cross-user)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      // userId says harry but signed by sarah's IRK — server must reject
      payload: buildSignedRegistration({ userId: "harry", signWith: sarahIrk }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects requests with an issuedAt outside the replay window", async () => {
    const { app } = makeApp();
    const stale = buildSignedRegistration({ issuedAt: Date.now() - 6 * 60_000 });
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload: stale,
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/stale/);
  });

  it("rejects re-registration of an existing serverId by a different user", async () => {
    const registry = new InMemoryServerRegistry();
    registry.put({
      userId: "harry",
      serverId: "srv-1",
      stkPub: harryStk.publicKey,
      registeredAt: Date.now(),
    });
    const { app } = makeApp({ registry });
    const payload = buildSignedRegistration({ userId: "sarah", signWith: sarahIrk });
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload,
    });
    expect(r.statusCode).toBe(409);
  });

  it("allows the same user to update their own server's STK pubkey", async () => {
    const registry = new InMemoryServerRegistry();
    registry.put({
      userId: "harry",
      serverId: "srv-1",
      stkPub: new Uint8Array(32).fill(0xaa),
      registeredAt: Date.now() - 1000,
    });
    const { app } = makeApp({ registry });
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload: buildSignedRegistration(),
    });
    expect(r.statusCode).toBe(200);
    expect(registry.get("srv-1")?.stkPub).toEqual(harryStk.publicKey);
  });

  it("rejects malformed bodies (400)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload: { request: { userId: 1 }, signature: "x" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("GET /api/server-registry/:serverId returns the registration", async () => {
    const { app } = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/server-registry/register",
      payload: buildSignedRegistration(),
    });
    const r = await app.inject({ method: "GET", url: "/api/server-registry/srv-1" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.userId).toBe("harry");
    expect(body.stkPub).toBe(bytesToHex(harryStk.publicKey));
    expect(body.revoked).toBe(null);
  });

  it("GET unknown serverId returns 404", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api/server-registry/nope" });
    expect(r.statusCode).toBe(404);
  });
});

describe("authLookupFromRegistry", () => {
  it("returns the STK pubkey for a registered server", () => {
    const reg = new InMemoryServerRegistry();
    reg.put({ userId: "harry", serverId: "srv-1", stkPub: harryStk.publicKey, registeredAt: Date.now() });
    expect(authLookupFromRegistry(reg)("srv-1")).toEqual(harryStk.publicKey);
  });

  it("returns null for an unknown server (tunnel HELLO is rejected)", () => {
    expect(authLookupFromRegistry(new InMemoryServerRegistry())("ghost")).toBeNull();
  });

  it("returns null for a revoked server (so the thief cannot reconnect)", () => {
    const reg = new InMemoryServerRegistry();
    reg.put({ userId: "harry", serverId: "srv-1", stkPub: harryStk.publicKey, registeredAt: Date.now() });
    reg.revoke("srv-1", "stolen", Date.now());
    expect(authLookupFromRegistry(reg)("srv-1")).toBeNull();
  });
});
