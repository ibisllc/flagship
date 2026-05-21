/**
 * W11 — Worker-side streaming personalize.
 *
 * The whole-buffer `personalizeBytes` is the ground truth (used by the
 * personalize-iso CLI + the existing `personalize.test.ts` suite). Here
 * we assert that the streaming variant — which the Worker pipes into
 * R2 without ever buffering 240 MB in V8 heap — produces byte-for-byte
 * identical output for the same blob + signature.
 */

import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  ed,
  signAuthCode,
  signInstallBlob,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import {
  buildTrailer,
  parseTrailer,
  personalizeBytes,
  streamPersonalize,
} from "../src/index.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (i * 19 + 3) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function buildBlob(): InstallBlob {
  const delegated = freshKeypair().publicKey;
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFEXAMPLE0001",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegated,
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
    phoneDelegatedPubKey: delegated,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: userSig,
    issuedAt: code.issuedAt,
    expiresAt: code.expiresAt,
    installerGitRef: "main",
    rckPubKey: freshKeypair().publicKey,
  };
}

function bytesFromStream(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader();
  const chunks: Uint8Array[] = [];
  return (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value!);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  })();
}

function makeBaseStream(
  base: Uint8Array,
  chunkSize = 64 * 1024,
): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= base.length) {
        controller.close();
        return;
      }
      const end = Math.min(off + chunkSize, base.length);
      controller.enqueue(base.subarray(off, end));
      off = end;
    },
  });
}

describe("streamPersonalize (W11)", () => {
  it("output bytes equal personalizeBytes(base, buildTrailer(blob, signer).bytes)", async () => {
    const blob = buildBlob();
    const signed = buildTrailer(blob, harryIrk);
    // Pull the signature back out of the just-built trailer to feed it
    // into streamPersonalize — proves the W11 streaming path produces
    // the same bytes as the canonical whole-buffer path.
    const parsed = parseTrailer(signed.bytes);
    expect(parsed?.signatureValid).toBe(true);
    const signature = parsed!.signature;

    const fakeIso = new Uint8Array(300_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = (i * 17) & 0xff;
    const expected = personalizeBytes(fakeIso, signed.bytes);

    for (const chunkSize of [128, 4096, 64 * 1024, 250_000]) {
      const out = streamPersonalize({
        baseIsoStream: makeBaseStream(fakeIso, chunkSize),
        baseIsoSize: fakeIso.length,
        blob,
        blobSignature: signature,
      });
      const bytes = await bytesFromStream(out.stream);
      expect(out.totalBytes).toBe(fakeIso.length + signed.bytes.length);
      expect(out.trailerSize).toBe(signed.bytes.length);
      expect(bytes.length).toBe(expected.length);
      expect(bytes).toEqual(expected);
    }
  });

  it("round-trips through parseTrailer with signatureValid:true", async () => {
    const blob = buildBlob();
    const signature = signInstallBlob(blob, harryIrk);
    const fakeIso = new Uint8Array(50_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = i & 0xff;
    const out = streamPersonalize({
      baseIsoStream: makeBaseStream(fakeIso, 8192),
      baseIsoSize: fakeIso.length,
      blob,
      blobSignature: signature,
    });
    const bytes = await bytesFromStream(out.stream);
    const parsed = parseTrailer(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.username).toBe("harry");
    expect(parsed!.blob.serverName).toBe("home");
    expect(parsed!.blob.serverDomain).toBe("home.harry.flagship.services");
  });

  it("rejects a signature of the wrong length up-front", () => {
    const blob = buildBlob();
    expect(() =>
      streamPersonalize({
        baseIsoStream: makeBaseStream(new Uint8Array(8)),
        baseIsoSize: 8,
        blob,
        blobSignature: new Uint8Array(32),
      }),
    ).toThrow(/expected 64-byte signature/);
  });

  it("trailerBytes returned matches the trailer that the parser finds at the end", async () => {
    const blob = buildBlob();
    const signature = signInstallBlob(blob, harryIrk);
    const fakeIso = new Uint8Array(10_000).fill(0xaa);
    const out = streamPersonalize({
      baseIsoStream: makeBaseStream(fakeIso, 1024),
      baseIsoSize: fakeIso.length,
      blob,
      blobSignature: signature,
    });
    const bytes = await bytesFromStream(out.stream);
    const tail = bytes.subarray(fakeIso.length);
    expect(tail).toEqual(out.trailerBytes);
  });
});
