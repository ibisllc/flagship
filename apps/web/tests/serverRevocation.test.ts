import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  deriveSTK,
  signRevocation,
  type ServerRevocation,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryServerRegistry,
  authLookupFromRegistry,
} from "../src/routes/serverRegistry.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const harryStk = deriveSTK(deriveSWK(harryUmk, "srv-1"));

const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSignedRevocation(over: Partial<ServerRevocation> = {}, signer = harryIrk) {
  const rev: ServerRevocation = {
    userId: over.userId ?? "harry",
    revokedServerId: over.revokedServerId ?? "srv-1",
    reason: over.reason ?? "stolen",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      userId: rev.userId,
      revokedServerId: rev.revokedServerId,
      reason: rev.reason,
      issuedAt: rev.issuedAt,
    },
    signature: bytesToHex(signRevocation(rev, signer)),
  };
}

function makeApp(registry: InMemoryServerRegistry, opts: { onRevoked?: () => void } = {}) {
  void opts;
  const app = buildServer({
    serverRegistry: registry,
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  return app;
}

function seedRegistry() {
  const registry = new InMemoryServerRegistry();
  registry.put({
    userId: "harry",
    serverId: "srv-1",
    stkPub: harryStk.publicKey,
    registeredAt: Date.now() - 1000,
  });
  return registry;
}

describe("/api/server-registry/revoke", () => {
  it("revokes a server signed by its rightful owner", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      payload: buildSignedRevocation(),
    });
    expect(r.statusCode).toBe(200);
    expect(registry.get("srv-1")?.revokedAt).toBeTypeOf("number");
    expect(registry.get("srv-1")?.revocationReason).toBe("stolen");
  });

  it("revoked servers no longer authenticate at the tunnel hub", () => {
    const registry = seedRegistry();
    expect(authLookupFromRegistry(registry)("srv-1")).not.toBeNull();
    registry.revoke("srv-1", "stolen", Date.now());
    expect(authLookupFromRegistry(registry)("srv-1")).toBeNull();
  });

  it("rejects a revocation signed by a different user (cross-user attack)", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      payload: buildSignedRevocation({ userId: "sarah" }, sarahIrk),
    });
    // Sarah's signature is valid, but srv-1 is owned by harry.
    expect(r.statusCode).toBe(403);
    expect(registry.get("srv-1")?.revokedAt).toBeUndefined();
  });

  it("rejects a request whose signature was made by a different IRK than userId claims", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      // userId says harry but signed by sarah's IRK
      payload: buildSignedRevocation({ userId: "harry" }, sarahIrk),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects an invalid revocation reason with 400", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const payload = {
      request: { userId: "harry", revokedServerId: "srv-1", reason: "borrowed", issuedAt: Date.now() },
      signature: "0".repeat(128),
    };
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects revocations of unknown servers with 404", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      payload: buildSignedRevocation({ revokedServerId: "ghost" }),
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects stale revocations (issuedAt outside the replay window)", async () => {
    const registry = seedRegistry();
    const app = makeApp(registry);
    const r = await app.inject({
      method: "POST",
      url: "/api/server-registry/revoke",
      payload: buildSignedRevocation({ issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });
});
