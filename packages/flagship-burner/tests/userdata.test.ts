/**
 * Burner: cloud-init user-data embeds a COMPLETE auth-code.
 *
 * The bootstrap baked into the ISO reads the embedded install-blob back
 * and hands it to `install-helper sign-server-register`, which
 * reconstructs `canonicalAuthCode` to forward the phone's signature to
 * .com. canonicalAuthCode covers version/serverName/serverDomain/
 * delegatedPubKey — so if the serializer drops any of those, .com
 * rejects the registration. These tests pin the full round-trip:
 * embed -> base64-decode -> verifyAuthCode, which is exactly the
 * .com-side check.
 */
import { describe, it, expect } from "vitest";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildAutoinstallUserData } from "../src/userdata.js";

function makeKeypair(seedByte: number) {
  const sk = new Uint8Array(32).fill(seedByte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function hx(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function unhex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function signedBlob(): { blob: InstallBlob; blobSignatureHex: string; userPub: Uint8Array } {
  const irk = makeKeypair(7);
  const delegate = makeKeypair(8);
  const rck = makeKeypair(9);
  const authCode: AuthCode = {
    version: 1,
    serial: "01TESTABCDEF",
    username: "demo-alice",
    serverName: "home",
    serverDomain: "home.demo-alice.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 6 * 60 * 60_000,
  };
  const authCodeUserSignature = signAuthCode(authCode, irk);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)), userPub: irk.publicKey };
}

/** Pull the install-blob.json base64 out of the late-command line. */
function extractEmbeddedBlob(yaml: string): Record<string, any> {
  const m = yaml.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/var\/flagship\/install-blob\.json/);
  if (!m) throw new Error("install-blob late-command not found in user-data");
  return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
}

describe("buildAutoinstallUserData", () => {
  it("embeds an auth-code with every field canonicalAuthCode needs", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const embedded = extractEmbeddedBlob(yaml);
    for (const f of [
      "version",
      "serial",
      "username",
      "serverName",
      "serverDomain",
      "delegatedPubKey",
      "userPubKey",
      "issuedAt",
      "expiresAt",
    ]) {
      expect(embedded.authCode[f], `authCode.${f} must be embedded`).toBeDefined();
    }
  });

  it("embedded auth-code signature verifies — exactly the .com register check", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const e = extractEmbeddedBlob(yaml);
    const reconstructed: AuthCode = {
      version: e.authCode.version,
      serial: e.authCode.serial,
      username: e.authCode.username,
      serverName: e.authCode.serverName,
      serverDomain: e.authCode.serverDomain,
      delegatedPubKey: unhex(e.authCode.delegatedPubKey),
      userPubKey: unhex(e.authCode.userPubKey),
      issuedAt: e.authCode.issuedAt,
      expiresAt: e.authCode.expiresAt,
    };
    const ok = verifyAuthCode(
      reconstructed,
      unhex(e.authCodeUserSignature),
      unhex(e.authCode.userPubKey),
    );
    expect(ok).toBe(true);
  });

  it("embeds blobSignatureHex so the daemon can forward the blob signature", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    expect(extractEmbeddedBlob(yaml).blobSignatureHex).toBe(blobSignatureHex);
  });
});
