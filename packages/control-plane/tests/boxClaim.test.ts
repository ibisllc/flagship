/**
 * Retail box claims at `.com` (docs/retail-box-setup.md §4 step 8, §7.7, §15.1): the admin
 * device pre-registers the box key under the AuthCode, `/api/server/register` then admits only
 * that key (without burning the AuthCode on a refusal), the AuthCode stays single use, and the
 * remote-claim mailbox is blind and bounded.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signAuthCode,
  signAuthCodeAdmin,
  signBoxClaimKey,
  signServerRegister,
  type AuthCode,
  type BoxClaimKey,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import { InMemoryBoxClaimStorage, InMemoryStorage } from "@flagship/storage";
import { ADD_SERVER_ADMIN_ONLY_CODE } from "../src/adminAuthorityGate.js";
import { handleAuthCodeIssue } from "../src/authCode.js";
import {
  BOX_CLAIM_MAILBOX_MAX_PER_DIR,
  BOX_CLAIM_MAILBOX_TTL_MS,
  BOX_KEY_MISMATCH_CODE,
  BOX_KEY_TAKEN_CODE,
  handleBoxClaimKey,
  handleBoxClaimMailboxPost,
  handleBoxClaimMailboxRead,
} from "../src/boxClaim.js";
import { handleServerRegister } from "../src/serverRegister.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (byte: number): Keypair => {
  const priv = new Uint8Array(32).fill(byte);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const irk = key(0x11);
const admin = key(0x22);
const device = key(0x33);
const boxReal = key(0x44);
const boxRelay = key(0x55);
const NOW = 1_790_000_000_000;
const DOMAIN = "home.harry.flagship.services";
const SERIAL = "retail-claim-0001";

async function world(opts: { demo?: boolean } = {}) {
  const s = new InMemoryStorage();
  const boxClaims = new InMemoryBoxClaimStorage();
  await s.usernames.put({
    username: "harry",
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    ...(opts.demo ? { isDemo: true } : { adminRootPubHex: hex(admin.publicKey) }),
  });
  const c: AuthCode = {
    version: 1,
    serial: SERIAL,
    username: "harry",
    serverName: "home",
    serverDomain: DOMAIN,
    delegatedPubKey: key(0x66).publicKey,
    userPubKey: irk.publicKey,
    issuedAt: NOW,
    expiresAt: NOW + 3_600_000,
    ...(opts.demo ? {} : { adminRootPubKey: admin.publicKey }),
  };
  const r = await handleAuthCodeIssue(
    { storage: s.authCodes, usernames: s.usernames, grants: s.deviceCapabilityGrants, now: () => NOW },
    {
      code: { ...c, delegatedPubKey: hex(c.delegatedPubKey), userPubKey: hex(c.userPubKey), ...(c.adminRootPubKey ? { adminRootPubKey: hex(c.adminRootPubKey) } : {}) },
      signature: hex(signAuthCode(c, irk)),
      ...(opts.demo ? {} : { adminSignature: hex(signAuthCodeAdmin(c, admin)) }),
    } as never,
  );
  expect(r.status).toBe(200);
  const deps = { boxClaims, authCodes: s.authCodes, usernames: s.usernames, grants: s.deviceCapabilityGrants, now: () => NOW + 1_000 };
  return { s, boxClaims, c, deps };
}

function keyBody(k: Partial<BoxClaimKey>, signer: Keypair) {
  const full: BoxClaimKey = { username: "harry", serial: SERIAL, serverDomain: DOMAIN, stkPubHex: hex(boxReal.publicKey), issuedAt: NOW + 1_000, ...k };
  return { key: full, signature: hex(signBoxClaimKey(full, signer)) };
}

function registerBody(c: AuthCode, identity: Keypair) {
  const nonce = new Uint8Array(16).fill(9);
  const userSig = signAuthCode(c, irk);
  const req: ServerRegisterRequest = { authCode: c, authCodeUserSignature: userSig, serverIdentityPubKey: identity.publicKey, issuedAt: NOW + 2_000, nonce };
  return {
    request: {
      authCode: { ...c, delegatedPubKey: hex(c.delegatedPubKey), userPubKey: hex(c.userPubKey), ...(c.adminRootPubKey ? { adminRootPubKey: hex(c.adminRootPubKey) } : {}) },
      authCodeUserSignature: hex(userSig),
      serverIdentityPubKey: hex(identity.publicKey),
      issuedAt: NOW + 2_000,
      nonce: hex(nonce),
    },
    signature: hex(signServerRegister(req, identity)),
  };
}

const register = (w: Awaited<ReturnType<typeof world>>, identity: Keypair) =>
  handleServerRegister({ authCodes: w.s.authCodes, servers: w.s.servers, usernames: w.s.usernames, boxClaims: w.boxClaims, now: () => NOW + 2_000 }, registerBody(w.c, identity));

describe("box key pre-registration", () => {
  it("the admin root registers the receipt's key; the same key again is fine", async () => {
    const w = await world();
    const r = await handleBoxClaimKey(w.deps, keyBody({}, admin));
    expect(r).toMatchObject({ status: 200, body: { ok: true, stkPubHex: hex(boxReal.publicKey) } });
    expect((await handleBoxClaimKey(w.deps, keyBody({ issuedAt: NOW + 1_500 }, admin))).status).toBe(200);
    expect((await w.boxClaims.getKey(SERIAL))?.signerPubHex).toBe(hex(admin.publicKey));
  });

  it("the first key wins", async () => {
    const w = await world();
    await handleBoxClaimKey(w.deps, keyBody({}, admin));
    const r = await handleBoxClaimKey(w.deps, keyBody({ stkPubHex: hex(boxRelay.publicKey) }, admin));
    expect(r).toMatchObject({ status: 409, body: { code: BOX_KEY_TAKEN_CODE } });
  });

  it("only an admin device: the IRK and a plain device key are refused", async () => {
    const w = await world();
    for (const signer of [irk, device]) {
      expect(await handleBoxClaimKey(w.deps, keyBody({}, signer))).toMatchObject({ status: 403, body: { code: ADD_SERVER_ADMIN_ONLY_CODE } });
    }
    expect(await w.boxClaims.getKey(SERIAL)).toBe(null);
  });

  it("a demo account signs with its IRK", async () => {
    const w = await world({ demo: true });
    expect((await handleBoxClaimKey(w.deps, keyBody({}, irk))).status).toBe(200);
  });

  it("refuses a used, unknown, mismatched or stale AuthCode", async () => {
    const w = await world();
    expect((await handleBoxClaimKey(w.deps, keyBody({ serverDomain: "other.harry.flagship.services" }, admin))).status).toBe(403);
    expect((await handleBoxClaimKey(w.deps, keyBody({ serial: "unknown-serial-01" }, admin))).status).toBe(403);
    expect((await handleBoxClaimKey(w.deps, keyBody({ issuedAt: NOW - 3_600_000 }, admin))).status).toBe(400);
    await w.s.authCodes.markUsed(SERIAL, NOW + 500);
    expect((await handleBoxClaimKey(w.deps, keyBody({}, admin))).status).toBe(403);
  });

  it("refuses a malformed body", async () => {
    const w = await world();
    expect((await handleBoxClaimKey(w.deps, { key: { username: "harry" }, signature: "00" } as never)).status).toBe(400);
  });
});

describe("server register with a pre-registered key", () => {
  it("admits the registered key", async () => {
    const w = await world();
    await handleBoxClaimKey(w.deps, keyBody({}, admin));
    expect((await register(w, boxReal)).status).toBe(200);
    expect((await w.s.servers.get(DOMAIN))?.identityPubKeyHex).toBe(hex(boxReal.publicKey));
  });

  it("refuses a relay's real box (another key) and leaves the AuthCode usable", async () => {
    const w = await world();
    await handleBoxClaimKey(w.deps, keyBody({}, admin));
    expect(await register(w, boxRelay)).toMatchObject({ status: 403, body: { code: BOX_KEY_MISMATCH_CODE } });
    expect((await w.s.authCodes.get(SERIAL))?.status).toBe("active");
    expect((await register(w, boxReal)).status).toBe(200);
  });

  it("the AuthCode is single use: one claim yields at most one server", async () => {
    const w = await world();
    expect((await register(w, boxReal)).status).toBe(200);
    expect((await register(w, boxReal)).status).toBe(409);
    expect((await register(w, boxRelay)).status).toBe(409);
  });

  it("without a pre-registration the register path is unchanged", async () => {
    const w = await world();
    expect((await register(w, boxRelay)).status).toBe(200);
  });
});

describe("remote-claim mailbox", () => {
  const MB = "ab".repeat(32);
  const deps = (boxClaims: InMemoryBoxClaimStorage, now = NOW) => ({ boxClaims, now: () => now });

  it("passes opaque messages each way, in order, after a cursor", async () => {
    const b = new InMemoryBoxClaimStorage();
    expect(await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "aGVsbG8=" })).toMatchObject({ status: 200, body: { seq: 1 } });
    expect(await handleBoxClaimMailboxPost(deps(b), MB, "to-phone", { body: "YWNjZXB0" })).toMatchObject({ status: 200, body: { seq: 1 } });
    expect(await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "ZmluaXNo" })).toMatchObject({ status: 200, body: { seq: 2 } });
    expect((await handleBoxClaimMailboxRead(deps(b), MB, "to-box", "1")).body).toEqual({ messages: [{ seq: 2, body: "ZmluaXNo" }] });
    expect((await handleBoxClaimMailboxRead(deps(b), MB, "to-phone", null)).body).toEqual({ messages: [{ seq: 1, body: "YWNjZXB0" }] });
  });

  it("refuses bad names, directions, bodies and cursors", async () => {
    const b = new InMemoryBoxClaimStorage();
    expect((await handleBoxClaimMailboxPost(deps(b), "AB".repeat(32), "to-box", { body: "aGk=" })).status).toBe(400);
    expect((await handleBoxClaimMailboxPost(deps(b), MB, "sideways", { body: "aGk=" })).status).toBe(400);
    expect((await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "not base64!" })).status).toBe(400);
    expect((await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "A".repeat(100_000) })).status).toBe(400);
    expect((await handleBoxClaimMailboxRead(deps(b), MB, "to-box", "-1")).status).toBe(400);
  });

  it("is bounded and expires an hour after its first message", async () => {
    const b = new InMemoryBoxClaimStorage();
    for (let i = 0; i < BOX_CLAIM_MAILBOX_MAX_PER_DIR; i++) expect((await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "aGk=" })).status).toBe(200);
    expect((await handleBoxClaimMailboxPost(deps(b), MB, "to-box", { body: "aGk=" })).status).toBe(409);
    expect((await handleBoxClaimMailboxRead(deps(b, NOW + BOX_CLAIM_MAILBOX_TTL_MS), MB, "to-box", null)).body).toEqual({ messages: [] });
    expect((await handleBoxClaimMailboxPost(deps(b, NOW + BOX_CLAIM_MAILBOX_TTL_MS), MB, "to-box", { body: "aGk=" })).body).toMatchObject({ seq: 1 });
  });
});
