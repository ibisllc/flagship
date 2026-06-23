import { describe, it, expect } from "vitest";
import {
  signAuthCode,
  signInstallBlob,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { installBlobToJson } from "../src/userdata.js";
import { loadBlobFromString } from "../src/loadBlob.js";

// SWK provisioning: the phone embeds `swkHex` (= deriveSWK(umk, serverId)) as an
// UNSIGNED top-level recipe sibling, exactly like `pairingOrder`. The burner
// threads it into the on-disk install-blob.json. It must NEVER enter the signed
// InstallBlob's canonical bytes — a recipe with vs. without it signs identically.

function makeKeypair(seedByte: number) {
  const sk = new Uint8Array(32).fill(seedByte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function hx(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const SWK = "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377";

function signedBlob(): { blob: InstallBlob; blobSignatureHex: string } {
  const irk = makeKeypair(7);
  const delegate = makeKeypair(8);
  const rck = makeKeypair(9);
  const authCode: AuthCode = {
    version: 1,
    serial: "01TESTABCDEF",
    username: "demoalice",
    serverName: "home",
    serverDomain: "home.demoalice.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 6 * 60 * 60_000,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)) };
}

describe("installBlobToJson — swkHex sibling", () => {
  it("appends swkHex when provided", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const json = installBlobToJson(blob, blobSignatureHex, undefined, SWK);
    expect(json.swkHex).toBe(SWK);
  });

  it("omits swkHex when not provided", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const json = installBlobToJson(blob, blobSignatureHex);
    expect("swkHex" in json).toBe(false);
  });

  it("coexists with pairingOrder (both unsigned siblings)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const pairingOrder = JSON.stringify({ request: { type: "add-paired-session" }, signature: "ab" });
    const json = installBlobToJson(blob, blobSignatureHex, pairingOrder, SWK);
    expect(json.pairingOrder).toBe(pairingOrder);
    expect(json.swkHex).toBe(SWK);
  });

  it("does NOT change blobSignatureHex or the InstallBlob canonical bytes", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const without = installBlobToJson(blob, blobSignatureHex);
    const withSwk = installBlobToJson(blob, blobSignatureHex, undefined, SWK);

    // The signature is identical with and without the sibling.
    expect(withSwk.blobSignatureHex).toBe(without.blobSignatureHex);
    expect(withSwk.blobSignatureHex).toBe(blobSignatureHex);

    // Stripping the sibling reproduces the no-swk serialization byte-for-byte.
    const { swkHex: _omit, ...rest } = withSwk as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(without));
  });
});

describe("loadBlobFromString — swkHex passthrough", () => {
  it("reads a valid top-level swkHex sibling (lowercased) off the recipe", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const recipe = JSON.stringify(
      installBlobToJson(blob, blobSignatureHex, undefined, SWK.toUpperCase()),
    );
    const loaded = loadBlobFromString(recipe);
    expect(loaded.swkHex).toBe(SWK);
  });

  it("is undefined when the recipe carries no swkHex", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const recipe = JSON.stringify(installBlobToJson(blob, blobSignatureHex));
    expect(loadBlobFromString(recipe).swkHex).toBeUndefined();
  });

  it("ignores a malformed swkHex sibling", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const obj = installBlobToJson(blob, blobSignatureHex) as Record<string, unknown>;
    obj.swkHex = "deadbeef"; // wrong length
    expect(loadBlobFromString(JSON.stringify(obj)).swkHex).toBeUndefined();
  });
});
