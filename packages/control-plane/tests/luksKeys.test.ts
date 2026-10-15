import { describe, expect, it } from "vitest";
import { ed, signPutSealedLuksKey, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetSealedLuksKey, handlePutSealedLuksKey } from "../src/luksKeys.js";

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";

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

async function setup(opts: { irk: Keypair; identity: Keypair }): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(opts.irk.publicKey),
    claimedAt: 1,
  });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.identity.publicKey),
    registeredAt: 2,
  });
  return s;
}

describe("LUKS sealed key", () => {
  it("server stores sealed key with valid identity sig and gets it back", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const sealedKey = new Uint8Array(48);
    crypto.getRandomValues(sealedKey);
    const issuedAt = Date.now();
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, identity);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(200);

    const got = await handleGetSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
    );
    expect(got.status).toBe(200);
    expect((got.body as { sealedKey: string }).sealedKey).toBe(bytesToHex(sealedKey));
  });

  it("rejects an attacker's signature (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, identity });
    const issuedAt = Date.now();
    const sealedKey = new Uint8Array(8);
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, attacker);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects mismatched host vs serverId (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const sealedKey = new Uint8Array(8);
    const issuedAt = Date.now();
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, identity);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      "home.bob.flagship.services",
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });
});
