import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  signAuthCodeRevocation,
  signClaimUsername,
  type AuthCode,
  type AuthCodeRevocation,
  type ClaimUsername,
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

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = Math.floor(Math.random() * 256);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

async function claimHarry(app: ReturnType<typeof buildServer>): Promise<void> {
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
}

function buildSignedCode(): { code: AuthCode; signature: Uint8Array } {
  const delegated = freshKeypair().publicKey;
  const issuedAt = Date.now();
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFEXAMPLE0001",
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

function asJson(c: AuthCode): {
  code: object;
  signature?: string;
} {
  return {
    code: {
      version: c.version,
      serial: c.serial,
      username: c.username,
      serverName: c.serverName,
      serverDomain: c.serverDomain,
      delegatedPubKey: bytesToHex(c.delegatedPubKey),
      userPubKey: bytesToHex(c.userPubKey),
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    },
  };
}

describe("POST /api/auth-code/issue", () => {
  it("happy path: claims username, signs code, posts, looks up", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, serial: code.serial });

    const get = await app.inject({ method: "GET", url: `/api/auth-code/${code.serial}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.status).toBe("active");
    expect(body.serverDomain).toBe("home.harry.flagship.services");
  });

  it("400 on a server name that doesn't match the serverDomain string", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    const tampered = { ...code, serverDomain: "fake.harry.flagship.services" };
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(tampered), signature: bytesToHex(signature) },
    });
    expect(r.statusCode).toBe(400);
  });

  it("404 when the username has not been claimed", async () => {
    const app = buildServer({ surface: "com" });
    const { code, signature } = buildSignedCode();
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });
    expect(r.statusCode).toBe(404);
  });

  it("403 when the userPubKey does not match the registered IRK", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code } = buildSignedCode();
    const tampered: AuthCode = { ...code, userPubKey: malloryIrk.publicKey };
    const sig = signAuthCode(tampered, malloryIrk);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(tampered), signature: bytesToHex(sig) },
    });
    expect(r.statusCode).toBe(403);
  });

  it("403 when the signature is invalid", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code } = buildSignedCode();
    const wrongSig = signAuthCode(code, malloryIrk);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(wrongSig) },
    });
    expect(r.statusCode).toBe(403);
  });

  it("409 when the same serial is reposted", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    const r1 = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });
    expect(r2.statusCode).toBe(409);
  });

  it("400 on reserved username", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    const tampered = { ...code, username: "admin", serverDomain: "home.admin.flagship.services" };
    const r = await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(tampered), signature: bytesToHex(signature) },
    });
    expect(r.statusCode).toBe(400);
  });
});

// POST /api/auth-code/:serial/use was removed (Thread G G2): the
// register-time atomic consumption is the only legitimate consumer.
// Single-use semantics are covered by the server-register tests.

describe("POST /api/auth-code/:serial/revoke", () => {
  it("user can revoke; subsequent /use rejects", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });

    const revocation: AuthCodeRevocation = {
      serial: code.serial,
      username: "harry",
      issuedAt: Date.now(),
    };
    const sig = signAuthCodeRevocation(revocation, harryIrk);
    const r = await app.inject({
      method: "POST",
      url: `/api/auth-code/${code.serial}/revoke`,
      payload: {
        request: { serial: revocation.serial, username: revocation.username, issuedAt: revocation.issuedAt },
        signature: bytesToHex(sig),
      },
    });
    expect(r.statusCode).toBe(200);

    // Confirm revocation took effect: lookup returns status "revoked".
    const lookup = await app.inject({
      method: "GET",
      url: `/api/auth-code/${code.serial}`,
    });
    expect(lookup.statusCode).toBe(200);
    expect(JSON.parse(lookup.body).status).toBe("revoked");
  });

  it("returns 403 for unknown serial (no 404 — closes existence oracle)", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const revocation: AuthCodeRevocation = {
      serial: "01NEVERISSUED0001",
      username: "harry",
      issuedAt: Date.now(),
    };
    const sig = signAuthCodeRevocation(revocation, harryIrk);
    const r = await app.inject({
      method: "POST",
      url: `/api/auth-code/${revocation.serial}/revoke`,
      payload: {
        request: revocation,
        signature: bytesToHex(sig),
      },
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toBe("authentication failed");
  });

  it("returns 403 for unknown username (uniform body — closes enumeration oracle)", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });
    const revocation: AuthCodeRevocation = {
      serial: code.serial,
      username: "no-such-user",
      issuedAt: Date.now(),
    };
    const sig = signAuthCodeRevocation(revocation, harryIrk);
    const r = await app.inject({
      method: "POST",
      url: `/api/auth-code/${code.serial}/revoke`,
      payload: {
        request: revocation,
        signature: bytesToHex(sig),
      },
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toBe("authentication failed");
  });

  it("rejects revocation from a different user's IRK", async () => {
    const app = buildServer({ surface: "com" });
    await claimHarry(app);
    const { code, signature } = buildSignedCode();
    await app.inject({
      method: "POST",
      url: "/api/auth-code/issue",
      payload: { ...asJson(code), signature: bytesToHex(signature) },
    });

    const revocation: AuthCodeRevocation = {
      serial: code.serial,
      username: "harry",
      issuedAt: Date.now(),
    };
    const wrongSig = signAuthCodeRevocation(revocation, malloryIrk);
    const r = await app.inject({
      method: "POST",
      url: `/api/auth-code/${code.serial}/revoke`,
      payload: {
        request: { serial: revocation.serial, username: revocation.username, issuedAt: revocation.issuedAt },
        signature: bytesToHex(wrongSig),
      },
    });
    expect(r.statusCode).toBe(403);
  });
});
