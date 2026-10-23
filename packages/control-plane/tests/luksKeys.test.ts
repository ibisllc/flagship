import { describe, expect, it } from "vitest";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  ed,
  signAccountDirectoryRequest,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
  signPutSealedLuksKey,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { handleMintAccountReadToken, type AccountReadTokenDeps } from "../src/accountReadToken.js";
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
      readDeps(storage),
      HOST,
      `Bearer ${await irkToken(storage, irk)}`,
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

class Nonces {
  seen = new Set<string>();
  async claim(k: string) {
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}

const tokenDeps = new WeakMap<InMemoryStorage, AccountReadTokenDeps>();
function readTokenDeps(storage: InMemoryStorage): AccountReadTokenDeps {
  let d = tokenDeps.get(storage);
  if (!d) {
    d = {
      secret: "s3cret",
      usernames: storage.usernames,
      identities: storage.deviceIdentities,
      servers: storage.servers,
      demoUsers: storage.demoUsers,
      nonces: new Nonces(),
    };
    tokenDeps.set(storage, d);
  }
  return d;
}
const readDeps = (storage: InMemoryStorage) => ({
  servers: storage.servers,
  luksKeys: storage.luksKeys,
  readTokens: readTokenDeps(storage),
});

async function minted(storage: InMemoryStorage, input: Parameters<typeof handleMintAccountReadToken>[2], user = USERNAME) {
  const r = await handleMintAccountReadToken(readTokenDeps(storage), user, input);
  expect(r.status).toBe(200);
  return (r.body as { token: string }).token;
}

async function irkToken(storage: InMemoryStorage, irk: Keypair, user = USERNAME): Promise<string> {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const claim = {
    username: user,
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce,
  };
  return minted(storage, {
    body: {
      auth: { ...claim, phoneIrkPub: bytesToHex(irk.publicKey), nonce: bytesToHex(nonce) },
      authSignature: bytesToHex(signDeviceEndpointClaim(claim, irk)),
    },
  }, user);
}

async function deposit(storage: InMemoryStorage): Promise<string> {
  const sealed = "ab".repeat(48);
  await storage.luksKeys.putSealed({ serverDomain: HOST, sealedKeyHex: sealed, sealedAt: 3 });
  return sealed;
}

describe("downloading the sealed disk key", () => {
  it("refuses an anonymous caller, a junk token, and the same answer for a server with no deposit", async () => {
    const irk = makeKey();
    const storage = await setup({ irk, identity: makeKey() });
    const none = await handleGetSealedLuksKey(readDeps(storage), HOST, null);
    await deposit(storage);
    const anon = await handleGetSealedLuksKey(readDeps(storage), HOST, null);
    const junk = await handleGetSealedLuksKey(readDeps(storage), HOST, "Bearer art1.e30.AAAA");
    const unknown = await handleGetSealedLuksKey(readDeps(storage), "nope.alice.flagship.services", null);
    for (const r of [none, anon, junk, unknown]) {
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain("abab");
    }
    expect(anon.headers?.["cache-control"]).toBe("private, no-store");
  });

  it("answers the owner's device token (a phone or browser, also a new one after recovery)", async () => {
    const irk = makeKey();
    const device = makeKey();
    const storage = await setup({ irk, identity: makeKey() });
    const sealed = await deposit(storage);
    const deviceId = "00112233445566778899aabbccddeeff";
    await storage.deviceIdentities.put({
      accountId: USERNAME,
      deviceId,
      devicePubHex: bytesToHex(device.publicKey),
      platformClass: "ios",
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    });
    const request = {
      accountId: USERNAME,
      deviceId,
      signerPubHex: bytesToHex(device.publicKey),
      method: "POST",
      path: accountReadTokenPath(USERNAME),
      requestId: "aa".repeat(16),
      issuedAt: Date.now(),
    };
    const token = await minted(storage, { device: { request, signature: signAccountDirectoryRequest(request, device) } });
    const r = await handleGetSealedLuksKey(readDeps(storage), HOST, `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect((r.body as { sealedKey: string }).sealedKey).toBe(sealed);
  });

  it("answers the account's IRK token, the path a recovered account uses before any device key", async () => {
    const irk = makeKey();
    const storage = await setup({ irk, identity: makeKey() });
    await deposit(storage);
    const r = await handleGetSealedLuksKey(readDeps(storage), HOST, `Bearer ${await irkToken(storage, irk)}`);
    expect(r.status).toBe(200);
  });

  it("refuses a box's own read token: no server reads the account's disk deposit", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await deposit(storage);
    const nonceHex = "bb".repeat(16);
    const box = { username: USERNAME, serverDomain: HOST, stkPubHex: bytesToHex(identity.publicKey), issuedAt: Date.now(), nonceHex };
    const token = await minted(storage, { body: { box, signature: signBoxReadTokenRequest(box, identity) } });
    expect((await handleGetSealedLuksKey(readDeps(storage), HOST, `Bearer ${token}`)).status).toBe(401);
  });

  it("refuses another account's token", async () => {
    const irk = makeKey();
    const storage = await setup({ irk, identity: makeKey() });
    await deposit(storage);
    const mallory = makeKey();
    await storage.usernames.put({ username: "mallory", irkPubHex: bytesToHex(mallory.publicKey), claimedAt: 1 });
    const token = await irkToken(storage, mallory, "mallory");
    expect((await handleGetSealedLuksKey(readDeps(storage), HOST, `Bearer ${token}`)).status).toBe(401);
  });

  it("answers a demo account without a token, as /pods does", async () => {
    const irk = makeKey();
    const storage = await setup({ irk, identity: makeKey() });
    await deposit(storage);
    await storage.demoUsers.insert({ username: USERNAME } as DemoUserRecord);
    expect((await handleGetSealedLuksKey(readDeps(storage), HOST, null)).status).toBe(200);
  });
});
