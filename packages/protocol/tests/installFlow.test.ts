import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  signAuthCodeRevocation,
  signInstallBlob,
  signServerRegister,
  verifyAuthCode,
  verifyAuthCodeRevocation,
  verifyInstallBlob,
  verifyServerRegister,
  type AuthCode,
  type AuthCodeRevocation,
  type InstallBlob,
  type ServerRegisterRequest,
} from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";
import { ed } from "../src/edSync.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = Math.floor(Math.random() * 256);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

const baseAuthCode = (): AuthCode => ({
  version: 1,
  serial: "01HXAFEXAMPLE0001",
  username: "harry",
  serverName: "home",
  serverDomain: "home.harry.flagship.services",
  delegatedPubKey: freshKeypair().publicKey,
  userPubKey: harryIrk.publicKey,
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + 3_600_000,
});

describe("AuthCode signing", () => {
  it("user-signed code verifies under the user's IRK", () => {
    const code = baseAuthCode();
    const sig = signAuthCode(code, harryIrk);
    expect(verifyAuthCode(code, sig, code.userPubKey)).toBe(true);
  });

  it("rejects a signature from a different user", () => {
    const code = baseAuthCode();
    const sig = signAuthCode(code, malloryIrk);
    expect(verifyAuthCode(code, sig, code.userPubKey)).toBe(false);
  });

  it("rejects a tampered serverDomain (auth-code-for-A re-aimed at B)", () => {
    const code = baseAuthCode();
    const sig = signAuthCode(code, harryIrk);
    const tampered: AuthCode = {
      ...code,
      serverDomain: "evil.harry.flagship.services",
    };
    expect(verifyAuthCode(tampered, sig, code.userPubKey)).toBe(false);
  });

  it("rejects a tampered delegatedPubKey (auth-code re-aimed at attacker's key)", () => {
    const code = baseAuthCode();
    const sig = signAuthCode(code, harryIrk);
    const attackerKey = freshKeypair().publicKey;
    const tampered: AuthCode = { ...code, delegatedPubKey: attackerKey };
    expect(verifyAuthCode(tampered, sig, code.userPubKey)).toBe(false);
  });

  it("rejects a tampered serial — .com cannot rebrand a serial without invalidating the signature", () => {
    const code = baseAuthCode();
    const sig = signAuthCode(code, harryIrk);
    const tampered: AuthCode = { ...code, serial: "01OTHER" };
    expect(verifyAuthCode(tampered, sig, code.userPubKey)).toBe(false);
  });
});

describe("AuthCode revocation", () => {
  it("user-signed revocation verifies", () => {
    const r: AuthCodeRevocation = {
      serial: "01HXAFEXAMPLE0001",
      username: "harry",
      issuedAt: 1_700_000_010_000,
    };
    const sig = signAuthCodeRevocation(r, harryIrk);
    expect(verifyAuthCodeRevocation(r, sig, harryIrk.publicKey)).toBe(true);
  });

  it("rejects a revocation signed by someone other than the username's owner", () => {
    const r: AuthCodeRevocation = {
      serial: "01HXAFEXAMPLE0001",
      username: "harry",
      issuedAt: 1_700_000_010_000,
    };
    const sig = signAuthCodeRevocation(r, malloryIrk);
    expect(verifyAuthCodeRevocation(r, sig, harryIrk.publicKey)).toBe(false);
  });
});

describe("InstallBlob signing", () => {
  function blob(): InstallBlob {
    const code = baseAuthCode();
    const userSig = signAuthCode(code, harryIrk);
    return {
      version: 1,
      serverDomain: code.serverDomain,
      username: code.username,
      serverName: code.serverName,
      phoneDelegatedPubKey: code.delegatedPubKey,
      registrationUrl: "https://flagship.services/api/server/register",
      authCode: code,
      authCodeUserSignature: userSig,
      issuedAt: code.issuedAt,
      expiresAt: code.expiresAt,
      installerGitRef: "main",
      rckPubKey: freshKeypair().publicKey,
    };
  }

  it("signs and verifies a complete install blob under the user's IRK", () => {
    const b = blob();
    const sig = signInstallBlob(b, harryIrk);
    expect(verifyInstallBlob(b, sig, harryIrk.publicKey)).toBe(true);
  });

  it("rejects a swapped registrationUrl (downgrade attack)", () => {
    const b = blob();
    const sig = signInstallBlob(b, harryIrk);
    const tampered = { ...b, registrationUrl: "http://attacker.invalid/register" };
    expect(verifyInstallBlob(tampered, sig, harryIrk.publicKey)).toBe(false);
  });

  it("rejects a swapped phoneDelegatedPubKey (key substitution)", () => {
    const b = blob();
    const sig = signInstallBlob(b, harryIrk);
    const attackerKey = freshKeypair().publicKey;
    const tampered = { ...b, phoneDelegatedPubKey: attackerKey };
    expect(verifyInstallBlob(tampered, sig, harryIrk.publicKey)).toBe(false);
  });
});

describe("ServerRegisterRequest signing", () => {
  it("signs and verifies under the server's identity key", () => {
    const code = baseAuthCode();
    const userSig = signAuthCode(code, harryIrk);
    const serverIdentity = freshKeypair();
    const req: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: userSig,
      serverIdentityPubKey: serverIdentity.publicKey,
      issuedAt: 1_700_000_100_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signServerRegister(req, serverIdentity);
    expect(verifyServerRegister(req, sig, serverIdentity.publicKey)).toBe(true);
  });

  it("rejects a request signed by a different identity than the one being registered", () => {
    const code = baseAuthCode();
    const userSig = signAuthCode(code, harryIrk);
    const serverIdentity = freshKeypair();
    const otherIdentity = freshKeypair();
    const req: ServerRegisterRequest = {
      authCode: code,
      authCodeUserSignature: userSig,
      serverIdentityPubKey: serverIdentity.publicKey,
      issuedAt: 1_700_000_100_000,
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signServerRegister(req, otherIdentity);
    expect(verifyServerRegister(req, sig, serverIdentity.publicKey)).toBe(false);
  });
});
