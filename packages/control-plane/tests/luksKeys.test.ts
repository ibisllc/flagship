import { describe, expect, it } from "vitest";
import {
  ed,
  signConsumeUnlockKey,
  signDepositUnlockKey,
  signPutSealedLuksKey,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumeUnlockKey,
  handleDepositUnlockKey,
  handleGetSealedLuksKey,
  handlePutSealedLuksKey,
} from "../src/luksKeys.js";

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

describe("LUKS unlock-key flow", () => {
  it("phone deposits, server consumes once; second consume returns 404", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    crypto.getRandomValues(unlockKey);
    const expiresAt = Date.now() + 5 * 60_000;
    const issuedAt = Date.now();
    const depSig = signDepositUnlockKey(
      { serverId: HOST, unlockKey, expiresAt, issuedAt },
      irk,
    );
    const dep = await handleDepositUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, unlockKey: bytesToHex(unlockKey), expiresAt, issuedAt },
        signature: bytesToHex(depSig),
      },
    );
    expect(dep.status).toBe(200);

    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const consumeIssuedAt = Date.now();
    const cSig = signConsumeUnlockKey(
      { serverId: HOST, nonce, issuedAt: consumeIssuedAt },
      identity,
    );
    const res1 = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt: consumeIssuedAt },
        signature: bytesToHex(cSig),
      },
    );
    expect(res1.status).toBe(200);
    expect((res1.body as { unlockKey: string }).unlockKey).toBe(bytesToHex(unlockKey));

    // Second consume — should be 404 because the deposit was cleared.
    const nonce2 = new Uint8Array(32);
    crypto.getRandomValues(nonce2);
    const cSig2 = signConsumeUnlockKey(
      { serverId: HOST, nonce: nonce2, issuedAt: consumeIssuedAt },
      identity,
    );
    const res2 = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce2), issuedAt: consumeIssuedAt },
        signature: bytesToHex(cSig2),
      },
    );
    expect(res2.status).toBe(404);
  });

  it("phone deposit signed by a non-IRK key is rejected (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    const expiresAt = Date.now() + 5 * 60_000;
    const issuedAt = Date.now();
    const sig = signDepositUnlockKey(
      { serverId: HOST, unlockKey, expiresAt, issuedAt },
      attacker,
    );
    const res = await handleDepositUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, unlockKey: bytesToHex(unlockKey), expiresAt, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("expired deposit is treated as absent on consume (404)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 1; // 1ms — already past by the time we consume
    await storage.luksKeys.putUnlock({
      serverDomain: HOST,
      unlockKeyHex: bytesToHex(unlockKey),
      depositedAt: issuedAt,
      expiresAt,
    });
    // Wait long enough for expiration.
    await new Promise((r) => setTimeout(r, 5));
    const nonce = new Uint8Array(32);
    const consumeIssuedAt = Date.now();
    const sig = signConsumeUnlockKey(
      { serverId: HOST, nonce, issuedAt: consumeIssuedAt },
      identity,
    );
    const res = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt: consumeIssuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(404);
  });
});
