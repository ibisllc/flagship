import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  signClaimUsername,
  signServerRegister,
  type AuthCode,
  type ClaimUsername,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { buildServer } from "../src/server.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function freshKeypair(seed = 0) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

async function setUpClaimedHarry() {
  const app = buildServer({ surface: "both" });
  const claim: ClaimUsername = {
    username: "harry",
    irkPub: harryIrk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claim, harryIrk);
  const r = await app.inject({
    method: "POST",
    url: "/api/username/claim",
    payload: {
      request: {
        username: "harry",
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  });
  if (r.statusCode !== 200) throw new Error(`claim failed: ${r.body}`);
  return app;
}

function buildAuthCode(serial: string): { code: AuthCode; signature: Uint8Array } {
  const delegated = freshKeypair(1).publicKey;
  const issuedAt = Date.now();
  const code: AuthCode = {
    version: 1,
    serial,
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegated,
    userPubKey: harryIrk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
  };
  return { code, signature: signAuthCode(code, harryIrk) };
}

async function issueAuthCode(
  app: ReturnType<typeof buildServer>,
  code: AuthCode,
  signature: Uint8Array,
) {
  return app.inject({
    method: "POST",
    url: "/api/auth-code/issue",
    payload: {
      code: {
        version: code.version,
        serial: code.serial,
        username: code.username,
        serverName: code.serverName,
        serverDomain: code.serverDomain,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
        issuedAt: code.issuedAt,
        expiresAt: code.expiresAt,
      },
      signature: bytesToHex(signature),
    },
  });
}

function registerPayload(
  code: AuthCode,
  userSig: Uint8Array,
  serverIdentity: ReturnType<typeof freshKeypair>,
  nonceSeed = 1,
) {
  const issuedAt = Date.now();
  const nonce = new Uint8Array(16);
  for (let i = 0; i < nonce.length; i++) nonce[i] = (i + nonceSeed) & 0xff;
  const reqObj: ServerRegisterRequest = {
    authCode: code,
    authCodeUserSignature: userSig,
    serverIdentityPubKey: serverIdentity.publicKey,
    issuedAt,
    nonce,
  };
  const sig = signServerRegister(reqObj, serverIdentity);
  return {
    request: {
      authCode: {
        version: code.version,
        serial: code.serial,
        username: code.username,
        serverName: code.serverName,
        serverDomain: code.serverDomain,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
        issuedAt: code.issuedAt,
        expiresAt: code.expiresAt,
      },
      authCodeUserSignature: bytesToHex(userSig),
      serverIdentityPubKey: bytesToHex(serverIdentity.publicKey),
      issuedAt,
      nonce: bytesToHex(nonce),
    },
    signature: bytesToHex(sig),
  };
}

describe("POST /api/server/register", () => {
  it("happy path: claim → issue → register → server is queryable + auth-code is used", async () => {
    const app = await setUpClaimedHarry();
    const { code, signature } = buildAuthCode("01HXAFREGISTER01");
    const issued = await issueAuthCode(app, code, signature);
    expect(issued.statusCode).toBe(200);

    const serverIdentity = freshKeypair(42);
    const r = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, signature, serverIdentity),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      ok: true,
      serverDomain: "home.harry.flagship.services",
    });

    const lookup = await app.inject({
      method: "GET",
      url: "/api/server/by-domain/home.harry.flagship.services",
    });
    expect(lookup.statusCode).toBe(200);
    const body = JSON.parse(lookup.body);
    expect(body.username).toBe("harry");
    expect(body.identityPubKey).toBe(bytesToHex(serverIdentity.publicKey));

    const used = await app.inject({
      method: "POST",
      url: `/api/auth-code/${code.serial}/use`,
    });
    expect(used.statusCode).toBe(409);
  });

  it("409 on second register with the same serial (single-use)", async () => {
    const app = await setUpClaimedHarry();
    const { code, signature } = buildAuthCode("01HXAFREGISTER02");
    await issueAuthCode(app, code, signature);
    const serverIdentity = freshKeypair(7);
    const a = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, signature, serverIdentity, 1),
    });
    expect(a.statusCode).toBe(200);
    const b = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, signature, serverIdentity, 2),
    });
    expect(b.statusCode).toBe(409);
  });

  it("403 when the auth-code user signature is from a different IRK", async () => {
    const app = await setUpClaimedHarry();
    const { code } = buildAuthCode("01HXAFREGISTER03");
    const wrongSig = signAuthCode(code, malloryIrk);
    const serverIdentity = freshKeypair(11);
    const r = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, wrongSig, serverIdentity),
    });
    expect(r.statusCode).toBe(403);
  });

  it("403 when the registration is signed by a different identity than declared", async () => {
    const app = await setUpClaimedHarry();
    const { code, signature } = buildAuthCode("01HXAFREGISTER04");
    await issueAuthCode(app, code, signature);

    const declared = freshKeypair(1).publicKey;
    const actualSigner = freshKeypair(2);
    const issuedAt = Date.now();
    const nonce = new Uint8Array(16).fill(7);
    const reqObj: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: signature,
      serverIdentityPubKey: declared,
      issuedAt,
      nonce,
    };
    const sig = signServerRegister(reqObj, actualSigner);
    const r = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: {
        request: {
          authCode: {
            version: code.version,
            serial: code.serial,
            username: code.username,
            serverName: code.serverName,
            serverDomain: code.serverDomain,
            delegatedPubKey: bytesToHex(code.delegatedPubKey),
            userPubKey: bytesToHex(code.userPubKey),
            issuedAt: code.issuedAt,
            expiresAt: code.expiresAt,
          },
          authCodeUserSignature: bytesToHex(signature),
          serverIdentityPubKey: bytesToHex(declared),
          issuedAt,
          nonce: bytesToHex(nonce),
        },
        signature: bytesToHex(sig),
      },
    });
    expect(r.statusCode).toBe(403);
  });

  it("404 when the auth-code serial was never issued", async () => {
    const app = await setUpClaimedHarry();
    const { code, signature } = buildAuthCode("01HXAFNEVERISSUED");
    const serverIdentity = freshKeypair(8);
    const r = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, signature, serverIdentity),
    });
    expect(r.statusCode).toBe(404);
  });

  it("409 when the auth-code was revoked before registration", async () => {
    const app = await setUpClaimedHarry();
    const { code, signature } = buildAuthCode("01HXAFREVOKED01");
    await issueAuthCode(app, code, signature);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/auth-code/${code.serial}/revoke`,
      payload: {
        request: { serial: code.serial, username: "harry", issuedAt: Date.now() },
        signature: bytesToHex(
          (await import("@flagship/protocol")).signAuthCodeRevocation(
            { serial: code.serial, username: "harry", issuedAt: Date.now() },
            harryIrk,
          ),
        ),
      },
    });
    expect(revoke.statusCode).toBe(200);

    const serverIdentity = freshKeypair(9);
    const r = await app.inject({
      method: "POST",
      url: "/api/server/register",
      payload: registerPayload(code, signature, serverIdentity),
    });
    expect(r.statusCode).toBe(409);
  });
});
