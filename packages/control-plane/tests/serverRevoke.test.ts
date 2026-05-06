import { describe, expect, it } from "vitest";
import { ed, signServerRevokeBySelf, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleServerRevokeBySelf } from "../src/serverRevoke.js";

const HOST = "home.alice.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function setup(identity: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.servers.put({
    serverDomain: HOST,
    username: "alice",
    identityPubKeyHex: bytesToHex(identity.publicKey),
    registeredAt: 1,
  });
  return s;
}

function makeBody(identity: Keypair, reason = "phone said so", issuedAt = Date.now()) {
  const sig = signServerRevokeBySelf({ serverId: HOST, reason, issuedAt }, identity);
  return {
    request: { serverId: HOST, reason, issuedAt },
    signature: bytesToHex(sig),
  };
}

describe("handleServerRevokeBySelf", () => {
  it("revokes on a valid signed request", async () => {
    const identity = makeKey();
    const storage = await setup(identity);
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers },
      HOST,
      makeBody(identity),
    );
    expect(r.status).toBe(200);
    const got = await storage.servers.get(HOST);
    expect(got?.revokedAt).toBeGreaterThan(0);
    expect(got?.revocationReason).toBe("phone said so");
  });

  it("idempotent: a second revoke returns 200 with alreadyRevoked=true (no error)", async () => {
    const identity = makeKey();
    const storage = await setup(identity);
    await handleServerRevokeBySelf(
      { servers: storage.servers },
      HOST,
      makeBody(identity),
    );
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers },
      HOST,
      makeBody(identity, "second time"),
    );
    expect(r.status).toBe(200);
    const body = r.body as { alreadyRevoked?: boolean };
    expect(body.alreadyRevoked).toBe(true);
  });

  it("rejects an attacker's signature (403) — server stays alive", async () => {
    const real = makeKey();
    const attacker = makeKey();
    const storage = await setup(real);
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers },
      HOST,
      makeBody(attacker),
    );
    expect(r.status).toBe(403);
    const got = await storage.servers.get(HOST);
    expect(got?.revokedAt).toBeUndefined();
  });

  it("rejects host/serverId mismatch (403)", async () => {
    const identity = makeKey();
    const storage = await setup(identity);
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers },
      "home.bob.flagship.services",
      makeBody(identity),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a stale issuedAt (403)", async () => {
    const identity = makeKey();
    const storage = await setup(identity);
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers, maxAgeMs: 1000 },
      HOST,
      makeBody(identity, "stale", Date.now() - 60_000),
    );
    expect(r.status).toBe(403);
  });

  it("404 on an unknown server", async () => {
    const identity = makeKey();
    const storage = new InMemoryStorage();
    const r = await handleServerRevokeBySelf(
      { servers: storage.servers },
      HOST,
      makeBody(identity),
    );
    expect(r.status).toBe(404);
  });
});
