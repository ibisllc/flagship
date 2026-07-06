/**
 * Burner: loadBlob signature + expiry contract.
 *
 * These tests prove the Burner refuses to consume an InstallBlob whose
 * phone-signed bytes don't verify, or whose authCode has already
 * expired. They use the production `signInstallBlob` helper so the
 * canonical-bytes layout is exercised, not mocked.
 */
import { describe, it, expect } from "vitest";
import {
  signInstallBlob,
  type InstallBlob,
  type AuthCode,
} from "@flagship/protocol";
import { ed } from "@flagship/protocol";
import { BurnerLoadError, loadBlobFromString, debugSshKeyFromGrant } from "../src/loadBlob.js";

function makeKeypair(seedByte: number) {
  const sk = new Uint8Array(32).fill(seedByte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSignedRecipe(opts: {
  authExpiresAt: number;
  irkSeed?: number;
  delegateSeed?: number;
  rckSeed?: number;
  bootUnlockMode?: "auto" | "approve";
}): { json: string; userPubKey: Uint8Array } {
  const irk = makeKeypair(opts.irkSeed ?? 7);
  const delegate = makeKeypair(opts.delegateSeed ?? 8);
  const rck = makeKeypair(opts.rckSeed ?? 9);
  const authCode: AuthCode = {
    version: 1,
    serial: "01TESTABCDEF",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: opts.authExpiresAt - 60 * 60_000, // 1h before expiry
    expiresAt: opts.authExpiresAt,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode,
    authCodeUserSignature: new Uint8Array(64), // not verified by the Burner
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
    ...(opts.bootUnlockMode ? { bootUnlockMode: opts.bootUnlockMode } : {}),
  };
  const sig = signInstallBlob(blob, irk);
  const json = JSON.stringify({
    version: 2,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial: authCode.serial,
      username: authCode.username,
      serverName: authCode.serverName,
      serverDomain: authCode.serverDomain,
      delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
      userPubKey: bytesToHex(authCode.userPubKey),
      issuedAt: authCode.issuedAt,
      expiresAt: authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
    ...(opts.bootUnlockMode ? { bootUnlockMode: opts.bootUnlockMode } : {}),
    blobSignatureHex: bytesToHex(sig),
  });
  return { json, userPubKey: irk.publicKey };
}

describe("loadBlobFromString", () => {
  it("accepts a signed v2 blob whose authCode is still fresh", () => {
    const future = Date.now() + 6 * 60 * 60_000; // 6h ahead
    const { json } = buildSignedRecipe({ authExpiresAt: future });
    const loaded = loadBlobFromString(json);
    expect(loaded.blob.version).toBe(2);
    expect(loaded.blob.serverDomain).toBe("home.harry.flagship.services");
    expect(loaded.blob.authCode.expiresAt).toBe(future);
  });

  it("accepts (verifies) a blob carrying bootUnlockMode", () => {
    // The signature covers this field; parseInstallBlob MUST reconstruct it
    // or verify fails. Proves the burner round-trip is signature-safe.
    const future = Date.now() + 6 * 60 * 60_000;
    const { json } = buildSignedRecipe({
      authExpiresAt: future,
      bootUnlockMode: "approve",
    });
    const loaded = loadBlobFromString(json);
    expect(loaded.blob.bootUnlockMode).toBe("approve");
  });

  it("accepts the issued envelope { blob, blobSignature } (what .com/website hand out)", () => {
    const future = Date.now() + 6 * 60 * 60_000;
    const { json } = buildSignedRecipe({ authExpiresAt: future });
    const flat = JSON.parse(json) as Record<string, unknown>;
    const blobSignature = flat.blobSignatureHex as string;
    delete flat.blobSignatureHex;
    const envelope = JSON.stringify({ blob: flat, blobSignature });
    const loaded = loadBlobFromString(envelope);
    expect(loaded.blob.serverDomain).toBe("home.harry.flagship.services");
    expect(loaded.blobSignatureHex).toBe(blobSignature);
  });

  it("refuses a blob whose authCode is expired", () => {
    const past = Date.now() - 60 * 60_000; // 1h ago
    const { json } = buildSignedRecipe({ authExpiresAt: past });
    expect(() => loadBlobFromString(json)).toThrow(BurnerLoadError);
    try {
      loadBlobFromString(json);
    } catch (e) {
      expect((e as BurnerLoadError).code).toBe("expired");
    }
  });

  it("refuses a v1 blob (rejects with malformed/missing-field)", () => {
    const future = Date.now() + 60 * 60_000;
    const { json } = buildSignedRecipe({ authExpiresAt: future });
    const v1 = json.replace('"version":2', '"version":1');
    expect(() => loadBlobFromString(v1)).toThrow(BurnerLoadError);
  });

  it("refuses a blob whose blobSignatureHex doesn't verify", () => {
    const future = Date.now() + 60 * 60_000;
    const { json } = buildSignedRecipe({ authExpiresAt: future });
    // Flip one byte in the signature.
    const tampered = json.replace(/"blobSignatureHex":"([0-9a-f]{4})/, '"blobSignatureHex":"ffff');
    expect(() => loadBlobFromString(tampered)).toThrow(BurnerLoadError);
    try {
      loadBlobFromString(tampered);
    } catch (e) {
      expect((e as BurnerLoadError).code).toBe("bad-signature");
    }
  });

  it("refuses malformed JSON", () => {
    expect(() => loadBlobFromString("{")).toThrow(BurnerLoadError);
    expect(() => loadBlobFromString("[]")).toThrow(BurnerLoadError);
    expect(() => loadBlobFromString("null")).toThrow(BurnerLoadError);
  });

  it("refuses a blob missing blobSignatureHex", () => {
    const future = Date.now() + 60 * 60_000;
    const { json } = buildSignedRecipe({ authExpiresAt: future });
    const noSig = json.replace(/,"blobSignatureHex":"[0-9a-f]+"/, "");
    expect(() => loadBlobFromString(noSig)).toThrow(BurnerLoadError);
  });
});

describe("debugSshKeyFromGrant — bake the owner's SSH key only from a real key", () => {
  const grant = (sshAuthorizedKey: string) =>
    JSON.stringify({
      grant: { serverDomain: "home.demoalice.flagship.services", sshAuthorizedKey, issuedAt: 1_700_000_000_000 },
      signatureHex: "ab".repeat(64),
    });

  it("extracts a NON-EMPTY authorized key", () => {
    expect(debugSshKeyFromGrant(grant("ssh-ed25519 AAAAC3NzaC1 owner@laptop"))).toBe(
      "ssh-ed25519 AAAAC3NzaC1 owner@laptop",
    );
  });
  it("returns undefined for an empty key (debug-console-only grant)", () => {
    expect(debugSshKeyFromGrant(grant(""))).toBeUndefined();
    expect(debugSshKeyFromGrant(grant("   "))).toBeUndefined();
  });
  it("returns undefined for no grant (production recipe) or malformed JSON", () => {
    expect(debugSshKeyFromGrant(undefined)).toBeUndefined();
    expect(debugSshKeyFromGrant("")).toBeUndefined();
    expect(debugSshKeyFromGrant("{not json")).toBeUndefined();
    expect(debugSshKeyFromGrant(JSON.stringify({ grant: {} }))).toBeUndefined();
  });
});
