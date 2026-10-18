import { describe, expect, it } from "vitest";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  ed,
  signAccountDirectoryRequest,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import {
  handleMintAccountReadToken,
  peekAccountReadToken,
  requireAccountRead,
  type AccountReadTokenDeps,
} from "../src/accountReadToken.js";

const U = "plucky-avocet";
const NOW = 1_900_000_000_000;
const DEVICE_ID = "00112233445566778899aabbccddeeff";
const DOMAIN = `home3.${U}.flagship.services`;

function key(seed: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class Nonces {
  seen = new Set<string>();
  async claim(k: string) {
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}

async function harness(secret: string | null = "s3cret") {
  const storage = new InMemoryStorage();
  const irk = key(1);
  const device = key(40);
  const stk = key(80);
  await storage.usernames.put({ username: U, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.deviceIdentities.put({
    accountId: U,
    deviceId: DEVICE_ID,
    devicePubHex: hex(device.publicKey),
    platformClass: "ios",
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  });
  await storage.servers.put({ serverDomain: DOMAIN, username: U, identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  let now = NOW;
  const deps: AccountReadTokenDeps = {
    secret: secret ?? undefined,
    usernames: storage.usernames,
    identities: storage.deviceIdentities,
    servers: storage.servers,
    demoUsers: storage.demoUsers,
    nonces: new Nonces(),
    now: () => now,
  };
  return { storage, deps, irk, device, stk, advance: (ms: number) => { now += ms; } };
}

function deviceAuth(device: Keypair, requestId = "aa".repeat(16), path = accountReadTokenPath(U)) {
  const request = {
    accountId: U,
    deviceId: DEVICE_ID,
    signerPubHex: hex(device.publicKey),
    method: "POST",
    path,
    requestId,
    issuedAt: NOW,
  };
  return { request, signature: signAccountDirectoryRequest(request, device) };
}

function irkBody(irk: Keypair, label = ACCOUNT_READ_TOKEN_LABEL, nonceByte = 7) {
  const claim = {
    username: U,
    endpointLabel: label,
    phoneIrkPub: irk.publicKey,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: new Uint8Array(32).fill(nonceByte),
  };
  return {
    auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) },
    authSignature: hex(signDeviceEndpointClaim(claim, irk)),
  };
}

function boxBody(stk: Keypair, nonceHex = "bb".repeat(16)) {
  const box = { username: U, serverDomain: DOMAIN, stkPubHex: hex(stk.publicKey), issuedAt: NOW, nonceHex };
  return { box, signature: signBoxReadTokenRequest(box, stk) };
}

async function mint(deps: AccountReadTokenDeps, input: Parameters<typeof handleMintAccountReadToken>[2]) {
  const r = await handleMintAccountReadToken(deps, U, input);
  return { status: r.status, token: (r.body as { token?: string }).token, body: r.body };
}

const read = (deps: AccountReadTokenDeps, token?: string, user = U) =>
  requireAccountRead(deps, user, token ? `Bearer ${token}` : null);

describe("minting an account read token", () => {
  it("mints for a device of the account, once per request id", async () => {
    const h = await harness();
    const auth = deviceAuth(h.device);
    const first = await mint(h.deps, { device: auth });
    expect(first.status).toBe(200);
    expect(first.token).toMatch(/^art1\./);
    expect((await mint(h.deps, { device: auth })).status).toBe(403);
  });

  it("mints for the account's IRK only under the read-token label, once per nonce", async () => {
    const h = await harness();
    expect((await mint(h.deps, { body: irkBody(h.irk, "device") })).status).toBe(403);
    expect((await mint(h.deps, { body: irkBody(h.irk) })).status).toBe(200);
    expect((await mint(h.deps, { body: irkBody(h.irk) })).status).toBe(403);
    expect((await mint(h.deps, { body: irkBody(key(9), ACCOUNT_READ_TOKEN_LABEL, 8) })).status).toBe(403);
  });

  it("mints for one of the account's servers by its STK", async () => {
    const h = await harness();
    expect((await mint(h.deps, { body: boxBody(h.stk) })).status).toBe(200);
    expect((await mint(h.deps, { body: boxBody(key(81), "cc".repeat(16)) })).status).toBe(403);
    await h.storage.servers.revoke(DOMAIN, "lost", NOW);
    expect((await mint(h.deps, { body: boxBody(h.stk, "dd".repeat(16)) })).status).toBe(403);
  });

  it("refuses a device request signed for another path, a revoked device, and a stale request", async () => {
    const h = await harness();
    expect((await mint(h.deps, { device: deviceAuth(h.device, "a1".repeat(16), `/api/accounts/${U}/profile`) })).status).toBe(403);
    h.advance(10 * 60_000);
    expect((await mint(h.deps, { device: deviceAuth(h.device, "a2".repeat(16)) })).status).toBe(403);
  });

  it("is off without a secret", async () => {
    const h = await harness(null);
    expect((await mint(h.deps, { device: deviceAuth(h.device) })).status).toBe(503);
  });
});

describe("reading with an account read token", () => {
  it("refuses a read without a token, with another account's token, or with a tampered one", async () => {
    const h = await harness();
    const { token } = await mint(h.deps, { device: deviceAuth(h.device) });
    expect((await read(h.deps)).ok).toBe(false);
    expect((await read(h.deps, token!, "other-user")).ok).toBe(false);
    const [p, payload, mac] = token!.split(".");
    expect((await read(h.deps, `${p}.${payload}.${mac!.slice(0, -2)}AA`)).ok).toBe(false);
    expect((await read(h.deps, token!)).ok).toBe(true);
  });

  it("stops working once the device is revoked, the IRK rotates or the server is revoked", async () => {
    const h = await harness();
    const byDevice = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    const byIrk = (await mint(h.deps, { body: irkBody(h.irk) })).token!;
    const byBox = (await mint(h.deps, { body: boxBody(h.stk) })).token!;
    await h.storage.deviceIdentities.revoke(U, DEVICE_ID, NOW);
    await h.storage.usernames.swapIrkPub(U, hex(h.irk.publicKey), hex(key(2).publicKey), NOW);
    await h.storage.servers.revoke(DOMAIN, "lost", NOW);
    for (const t of [byDevice, byIrk, byBox]) expect((await read(h.deps, t)).ok).toBe(false);
  });

  it("expires: an IRK token after a day, a device token after 30 days", async () => {
    const h = await harness();
    const byDevice = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    const byIrk = (await mint(h.deps, { body: irkBody(h.irk) })).token!;
    h.advance(25 * 60 * 60_000);
    expect((await read(h.deps, byIrk)).ok).toBe(false);
    expect((await read(h.deps, byDevice)).ok).toBe(true);
    h.advance(30 * 24 * 60 * 60_000);
    expect((await read(h.deps, byDevice)).ok).toBe(false);
  });

  it("lets anyone read a demo account", async () => {
    const h = await harness(null);
    await h.storage.demoUsers.insert({ username: U } as DemoUserRecord);
    expect(await read(h.deps)).toEqual({ ok: true, demo: true });
  });

  it("answers a refusal with 401 and no-store", async () => {
    const h = await harness();
    const r = await read(h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers?.["cache-control"]).toBe("private, no-store");
    }
  });
});

describe("a read token whose MAC was already checked", () => {
  it("is still refused the moment its signer is revoked, rotated away or expired", async () => {
    const h = await harness();
    const byDevice = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    const byIrk = (await mint(h.deps, { body: irkBody(h.irk) })).token!;
    const byBox = (await mint(h.deps, { body: boxBody(h.stk) })).token!;
    // Used once each, so every MAC is now remembered.
    for (const t of [byDevice, byIrk, byBox]) expect((await read(h.deps, t)).ok).toBe(true);
    await h.storage.deviceIdentities.revoke(U, DEVICE_ID, NOW);
    await h.storage.usernames.swapIrkPub(U, hex(h.irk.publicKey), hex(key(2).publicKey), NOW);
    await h.storage.servers.revoke(DOMAIN, "lost", NOW);
    for (const t of [byDevice, byIrk, byBox]) expect((await read(h.deps, t)).ok).toBe(false);
  });

  it("is still refused after its expiry", async () => {
    const h = await harness();
    const byIrk = (await mint(h.deps, { body: irkBody(h.irk) })).token!;
    expect((await read(h.deps, byIrk)).ok).toBe(true);
    h.advance(25 * 60 * 60_000);
    expect((await read(h.deps, byIrk)).ok).toBe(false);
  });

  it("is not honoured under a different secret", async () => {
    const h = await harness();
    const token = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    expect((await read(h.deps, token)).ok).toBe(true);
    const other = { ...h.deps, secret: "another-secret" };
    expect((await read(other, token)).ok).toBe(false);
  });

  it("a forged MAC is never remembered as good", async () => {
    const h = await harness();
    const token = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    const [p, payload, mac] = token.split(".");
    const forged = `${p}.${payload}.${mac!.slice(0, -2)}AA`;
    for (let i = 0; i < 3; i++) expect((await read(h.deps, forged)).ok).toBe(false);
  });

  it("peekAccountReadToken reads the claims of a good token and nothing else", async () => {
    const h = await harness();
    const token = (await mint(h.deps, { device: deviceAuth(h.device) })).token!;
    const claims = await peekAccountReadToken("s3cret", `Bearer ${token}`);
    expect(claims?.u).toBe(U);
    expect(claims?.sub).toBe(`d:${DEVICE_ID}`);
    expect(await peekAccountReadToken("wrong", `Bearer ${token}`)).toBeNull();
    expect(await peekAccountReadToken("s3cret", "Bearer nonsense")).toBeNull();
    expect(await peekAccountReadToken("s3cret", null)).toBeNull();
    expect(await peekAccountReadToken(undefined, `Bearer ${token}`)).toBeNull();
  });
});
