/**
 * Slice D — Phase 1: the AuthCode `adminRootPubKey` persistence + re-verification
 * fix (spine deviation #5, docs/device-admin-tier-spec.md §D-1). The admin master
 * root rides inside the SIGNED AuthCode; `.com` must (a) persist it on the
 * auth-code record + (b) reconstruct it at `/api/server/register` so a
 * client-signed AuthCode carrying it re-verifies.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signAuthCode,
  signClaimUsername,
  signServerRegister,
  type AuthCode,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import { InMemoryStorage, InMemoryAuthCodeStorage } from "@flagship/storage";
import { handleAuthCodeIssue, validateAndUseAuthCode } from "../src/authCode.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import { handleServerRegister } from "../src/serverRegister.js";

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

const USER = "alice";
const SERVER = "home";
const DOMAIN = "home.alice.flagship.services";

describe("Slice D — AuthCode adminRootPubKey is persisted at issue", () => {
  it("issue records admin_root_pub_key_hex; validateAndUse threads it back", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    const now = 1_000_000;

    // Register the account (issue verifies userPubKey == registered IRK).
    const claim = { username: USER, irkPub: irk.publicKey, issuedAt: now };
    await handleUsernameClaim(
      { storage: s.usernames, bypassOfferGate: true, now: () => now },
      {
        request: { username: USER, irkPub: hex(irk.publicKey), issuedAt: now },
        signature: hex(signClaimUsername(claim, irk)),
        adminRootPub: hex(adminRoot.publicKey),
      },
    );

    const issuedAt = now;
    const code: AuthCode = {
      version: 1,
      serial: "adminroot01",
      username: USER,
      serverName: SERVER,
      serverDomain: DOMAIN,
      delegatedPubKey: makeKey().publicKey,
      userPubKey: irk.publicKey,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      adminRootPubKey: adminRoot.publicKey,
    };
    const sig = signAuthCode(code, irk);

    const res = await handleAuthCodeIssue(
      { storage: s.authCodes, usernames: s.usernames, now: () => now },
      {
        code: {
          version: 1,
          serial: code.serial,
          username: USER,
          serverName: SERVER,
          serverDomain: DOMAIN,
          delegatedPubKey: hex(code.delegatedPubKey),
          userPubKey: hex(irk.publicKey),
          issuedAt,
          expiresAt: code.expiresAt,
          adminRootPubKey: hex(adminRoot.publicKey),
        },
        signature: hex(sig),
      },
    );
    expect(res.status).toBe(200);

    // Persisted on the record …
    const row = await s.authCodes.get(code.serial);
    expect(row?.adminRootPubKeyHex).toBe(hex(adminRoot.publicKey));

    // … and threaded back onto the reconstructed AuthCode.
    const used = await validateAndUseAuthCode(s.authCodes, code.serial, now + 1);
    expect(used.ok).toBe(true);
    if (used.ok) {
      expect(used.code.adminRootPubKey && hex(used.code.adminRootPubKey)).toBe(
        hex(adminRoot.publicKey),
      );
    }
  });

  it("a bad AuthCode signature is still rejected when adminRootPubKey is present", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    const now = 1_000_000;
    const claim = { username: USER, irkPub: irk.publicKey, issuedAt: now };
    await handleUsernameClaim(
      { storage: s.usernames, bypassOfferGate: true, now: () => now },
      {
        request: { username: USER, irkPub: hex(irk.publicKey), issuedAt: now },
        signature: hex(signClaimUsername(claim, irk)),
      },
    );
    // Sign WITHOUT the admin root, but submit WITH it → canonical bytes differ →
    // the signature must fail.
    const codeNoAdmin: AuthCode = {
      version: 1,
      serial: "adminroot02",
      username: USER,
      serverName: SERVER,
      serverDomain: DOMAIN,
      delegatedPubKey: makeKey().publicKey,
      userPubKey: irk.publicKey,
      issuedAt: now,
      expiresAt: now + 60_000,
    };
    const sig = signAuthCode(codeNoAdmin, irk);
    const res = await handleAuthCodeIssue(
      { storage: s.authCodes, usernames: s.usernames, now: () => now },
      {
        code: {
          version: 1,
          serial: codeNoAdmin.serial,
          username: USER,
          serverName: SERVER,
          serverDomain: DOMAIN,
          delegatedPubKey: hex(codeNoAdmin.delegatedPubKey),
          userPubKey: hex(irk.publicKey),
          issuedAt: now,
          expiresAt: codeNoAdmin.expiresAt,
          adminRootPubKey: hex(adminRoot.publicKey),
        },
        signature: hex(sig),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("Slice D — a client-signed AuthCode WITH adminRootPubKey re-verifies at register", () => {
  async function seedIssuedAuthCode(adminRoot: Keypair | undefined) {
    const authCodes = new InMemoryAuthCodeStorage();
    const irk = makeKey();
    const issuedAt = 1_000;
    const code: AuthCode = {
      version: 1,
      serial: "regadmin01",
      username: USER,
      serverName: SERVER,
      serverDomain: DOMAIN,
      delegatedPubKey: makeKey().publicKey,
      userPubKey: irk.publicKey,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      ...(adminRoot ? { adminRootPubKey: adminRoot.publicKey } : {}),
    };
    const acSig = signAuthCode(code, irk); // signature covers adminRootPubKey when present
    await authCodes.put({
      serial: code.serial,
      username: USER,
      serverName: SERVER,
      serverDomain: DOMAIN,
      delegatedPubKeyHex: hex(code.delegatedPubKey),
      userPubKeyHex: hex(irk.publicKey),
      userSignatureHex: hex(acSig),
      issuedAt,
      expiresAt: code.expiresAt,
      status: "active",
      recordedAt: issuedAt,
      ...(adminRoot ? { adminRootPubKeyHex: hex(adminRoot.publicKey) } : {}),
    });
    return { authCodes, code, acSig, issuedAt };
  }

  it("register RECONSTRUCTS the admin root ⇒ signature verifies ⇒ 200", async () => {
    const adminRoot = makeKey();
    const { authCodes, code, acSig, issuedAt } = await seedIssuedAuthCode(adminRoot);
    const identity = makeKey();
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const now = issuedAt + 1;
    const reg: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: acSig,
      serverIdentityPubKey: identity.publicKey,
      issuedAt: now,
      nonce,
    };
    const sig = signServerRegister(reg, identity);
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryStorage().servers, now: () => now },
      {
        request: {
          authCode: {
            version: 1,
            serial: code.serial,
            username: USER,
            serverName: SERVER,
            serverDomain: DOMAIN,
            delegatedPubKey: hex(code.delegatedPubKey),
            userPubKey: hex(code.userPubKey),
            issuedAt: code.issuedAt,
            expiresAt: code.expiresAt,
            adminRootPubKey: hex(adminRoot.publicKey),
          },
          authCodeUserSignature: hex(acSig),
          serverIdentityPubKey: hex(identity.publicKey),
          issuedAt: now,
          nonce: hex(nonce),
        },
        signature: hex(sig),
      },
    );
    expect(r.status).toBe(200);
  });

  it("register OMITTING the signed admin root ⇒ reconstruction differs ⇒ 403", async () => {
    const adminRoot = makeKey();
    const { authCodes, code, acSig, issuedAt } = await seedIssuedAuthCode(adminRoot);
    const identity = makeKey();
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const now = issuedAt + 1;
    const reg: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: acSig,
      serverIdentityPubKey: identity.publicKey,
      issuedAt: now,
      nonce,
    };
    const sig = signServerRegister(reg, identity);
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryStorage().servers, now: () => now },
      {
        request: {
          authCode: {
            version: 1,
            serial: code.serial,
            username: USER,
            serverName: SERVER,
            serverDomain: DOMAIN,
            delegatedPubKey: hex(code.delegatedPubKey),
            userPubKey: hex(code.userPubKey),
            issuedAt: code.issuedAt,
            expiresAt: code.expiresAt,
            // adminRootPubKey intentionally omitted — the reconstructed bytes no
            // longer match what the phone signed.
          },
          authCodeUserSignature: hex(acSig),
          serverIdentityPubKey: hex(identity.publicKey),
          issuedAt: now,
          nonce: hex(nonce),
        },
        signature: hex(sig),
      },
    );
    expect(r.status).toBe(403);
  });

  it("a legacy AuthCode (no admin root) still registers ⇒ 200 (backward-compatible)", async () => {
    const { authCodes, code, acSig, issuedAt } = await seedIssuedAuthCode(undefined);
    const identity = makeKey();
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const now = issuedAt + 1;
    const reg: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: acSig,
      serverIdentityPubKey: identity.publicKey,
      issuedAt: now,
      nonce,
    };
    const sig = signServerRegister(reg, identity);
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryStorage().servers, now: () => now },
      {
        request: {
          authCode: {
            version: 1,
            serial: code.serial,
            username: USER,
            serverName: SERVER,
            serverDomain: DOMAIN,
            delegatedPubKey: hex(code.delegatedPubKey),
            userPubKey: hex(code.userPubKey),
            issuedAt: code.issuedAt,
            expiresAt: code.expiresAt,
          },
          authCodeUserSignature: hex(acSig),
          serverIdentityPubKey: hex(identity.publicKey),
          issuedAt: now,
          nonce: hex(nonce),
        },
        signature: hex(sig),
      },
    );
    expect(r.status).toBe(200);
  });
});
