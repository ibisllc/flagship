import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  signInstallBlob,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { buildTrailer } from "@flagship/iso-personalizer";
import { bytesHandle, parseTrailerFromHandle } from "../src/parseTrailerOnDisk.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

function freshKeypair() {
  const sk = new Uint8Array(32).fill(7);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function buildBlob(): InstallBlob {
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFINSTSIM001",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: freshKeypair().publicKey,
    userPubKey: harryIrk.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
  };
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
  };
}

describe("parseTrailerFromHandle", () => {
  it("locates and verifies a trailer at the end of a multi-MB image", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(2_000_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = i & 0xff;
    const personalized = new Uint8Array(fakeIso.length + trailer.bytes.length);
    personalized.set(fakeIso, 0);
    personalized.set(trailer.bytes, fakeIso.length);

    const parsed = await parseTrailerFromHandle(bytesHandle(personalized));
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.serverDomain).toBe("home.harry.flagship.services");
  });

  it("returns null on an unpersonalized image (no magic at the end)", async () => {
    const fakeIso = new Uint8Array(1_000_000);
    const parsed = await parseTrailerFromHandle(bytesHandle(fakeIso));
    expect(parsed).toBeNull();
  });

  it("never reads more than the trailer size cap (works on a giant simulated device)", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    let bytesRead = 0;
    const handle = {
      size: () => 1_000_000_000,
      read: (offset: number, length: number) => {
        bytesRead += length;
        const out = new Uint8Array(length);
        if (offset + length === 1_000_000_000) {
          out.set(trailer.bytes, length - trailer.bytes.length);
        }
        return out;
      },
    };
    const parsed = await parseTrailerFromHandle(handle);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
  });
});
