/**
 * Worker-side 24h cap on `authCode.expiresAt - authCode.issuedAt`.
 *
 * The phone's TTL picker tops out at 24h; the Worker enforces the same
 * ceiling unilaterally (defense in depth — an outdated phone client
 * could try to mint a multi-day auth-code; .com must refuse it
 * regardless of what the signed envelope says).
 */
import { describe, expect, it } from "vitest";
import { handleServerRegister } from "../src/serverRegister.js";
import {
  ed,
  signAuthCode,
  signServerRegister,
  type AuthCode,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import {
  InMemoryAuthCodeStorage,
  InMemoryServerStorage,
} from "@flagship/storage";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function registerWithTtl(ttlMs: number) {
  const irk = makeKey();
  const authCodes = new InMemoryAuthCodeStorage();
  const issuedAt = 1_000;
  const issued: AuthCode = {
    version: 1,
    serial: "ttlcap1234",
    username: "alice",
    serverName: "home",
    serverDomain: "home.alice.flagship.services",
    delegatedPubKey: makeKey().publicKey,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
  const acSig = signAuthCode(issued, irk);
  await authCodes.put({
    serial: issued.serial,
    username: issued.username,
    serverName: issued.serverName,
    serverDomain: issued.serverDomain,
    delegatedPubKeyHex: hex(issued.delegatedPubKey),
    userPubKeyHex: hex(issued.userPubKey),
    userSignatureHex: hex(acSig),
    issuedAt: issued.issuedAt,
    expiresAt: issued.expiresAt,
    status: "active",
    recordedAt: issued.issuedAt,
  });
  const identity = makeKey();
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  // Stamp `now` just past issue so the auth-code is still fresh.
  const now = issuedAt + 1;
  const reg: ServerRegisterRequest = {
    authCode: issued,
    authCodeUserSignature: acSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt: now,
    nonce,
  };
  const sig = signServerRegister(reg, identity);
  return handleServerRegister(
    {
      authCodes,
      servers: new InMemoryServerStorage(),
      now: () => now,
    },
    {
      request: {
        authCode: {
          ...issued,
          delegatedPubKey: hex(issued.delegatedPubKey),
          userPubKey: hex(issued.userPubKey),
        },
        authCodeUserSignature: hex(acSig),
        serverIdentityPubKey: hex(identity.publicKey),
        issuedAt: now,
        nonce: hex(nonce),
      },
      signature: hex(sig),
    },
  );
}

describe("serverRegister — 24h auth-code TTL cap", () => {
  it("accepts a 24-hour exact TTL", async () => {
    const r = await registerWithTtl(24 * 60 * 60_000);
    expect(r.status).toBe(200);
  });

  it("accepts a 1-hour TTL", async () => {
    const r = await registerWithTtl(60 * 60_000);
    expect(r.status).toBe(200);
  });

  it("rejects a 24-hour-plus-one-millisecond TTL", async () => {
    const r = await registerWithTtl(24 * 60 * 60_000 + 1);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("TTL exceeds");
  });

  it("rejects a 7-day TTL outright", async () => {
    const r = await registerWithTtl(7 * 24 * 60 * 60_000);
    expect(r.status).toBe(403);
  });
});
