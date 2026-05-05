import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { buildTrailer, parseTrailer } from "../src/trailer.js";
import {
  personalizeBytes,
  personalizeStream,
  trailerStream,
} from "../src/personalize.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (i * 13 + 7) & 0xff;
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

function makeBaseStream(base: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
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

describe("personalizeBytes / personalizeStream", () => {
  it("personalizeBytes preserves the base bytes verbatim and the parser can find the trailer", () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(8192);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = (i * 31) & 0xff;
    const out = personalizeBytes(fakeIso, trailer.bytes);
    expect(out.subarray(0, fakeIso.length)).toEqual(fakeIso);
    expect(parseTrailer(out)?.signatureValid).toBe(true);
  });

  it("personalizeStream produces the same bytes as personalizeBytes for any chunking", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(500_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = (i * 7) & 0xff;
    const expected = personalizeBytes(fakeIso, trailer.bytes);

    for (const chunkSize of [128, 4096, 32 * 1024, 64 * 1024, 250_000]) {
      const out = await bytesFromStream(
        personalizeStream(makeBaseStream(fakeIso, chunkSize), trailer.bytes),
      );
      expect(out.length).toBe(expected.length);
      expect(out).toEqual(expected);
    }
  });

  it("personalizeStream output round-trips through the parser", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(200_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = i & 0xff;
    const out = await bytesFromStream(
      personalizeStream(makeBaseStream(fakeIso, 8192), trailer.bytes),
    );
    const parsed = parseTrailer(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.serverDomain).toBe("home.harry.flagship.services");
  });

  it("trailerStream reports cumulative bytes via onProgress including the trailer", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(100_000);
    let lastReport = 0;
    const progress: number[] = [];
    const stream = trailerStream(makeBaseStream(fakeIso, 16_384), trailer.bytes, (n) => {
      expect(n).toBeGreaterThanOrEqual(lastReport);
      lastReport = n;
      progress.push(n);
    });
    const out = await bytesFromStream(stream);
    expect(out.length).toBe(fakeIso.length + trailer.size);
    expect(progress[progress.length - 1]).toBe(out.length);
  });

  it("cancelling the personalized stream cancels the upstream", async () => {
    const blob = buildBlob();
    const trailer = buildTrailer(blob, harryIrk);
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = personalizeStream(upstream, trailer.bytes);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(new Error("user clicked stop"));
    expect(cancelled).toBe(true);
  });
});
