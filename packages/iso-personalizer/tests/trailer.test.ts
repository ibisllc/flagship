import { describe, expect, it } from "vitest";
import {
  signAuthCode,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { deriveIRK } from "@flagship/protocol";
import { ed } from "@flagship/protocol";
import {
  buildTrailer,
  parseTrailer,
  MAGIC_HEADER,
  MAGIC_FOOTER,
  FIXED_OVERHEAD,
  MAX_TRAILER_BYTES,
} from "../src/trailer.js";
import { personalizeBytes } from "../src/personalize.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);

const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function freshKeypair() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function buildBlob(overrides: Partial<InstallBlob> = {}): InstallBlob {
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
    ...overrides,
  };
}

describe("trailer build/parse round-trip", () => {
  it("appends header, JSON, signature, footer, and total-size in the documented layout", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    expect(t.bytes.length).toBe(t.size);
    expect(t.bytes.subarray(0, MAGIC_HEADER.length)).toEqual(MAGIC_HEADER);
    const footerStart = t.size - 4 - MAGIC_FOOTER.length;
    expect(t.bytes.subarray(footerStart, footerStart + MAGIC_FOOTER.length)).toEqual(MAGIC_FOOTER);
  });

  it("parses a freshly-built trailer back to an equivalent blob with a valid signature", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const parsed = parseTrailer(t.bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.serverDomain).toBe(blob.serverDomain);
    expect(parsed!.blob.username).toBe(blob.username);
    expect(parsed!.blob.authCode.serial).toBe(blob.authCode.serial);
    expect(parsed!.blob.phoneDelegatedPubKey).toEqual(blob.phoneDelegatedPubKey);
  });

  it("locates the trailer at the END of an arbitrarily-large fake ISO (the personalize case)", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const fakeIso = new Uint8Array(1_000_000);
    for (let i = 0; i < fakeIso.length; i++) fakeIso[i] = i & 0xff;
    const personalized = personalizeBytes(fakeIso, t.bytes);
    const parsed = parseTrailer(personalized);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(true);
    expect(parsed!.blob.serverDomain).toBe("home.harry.flagship.services");
  });
});

describe("trailer rejection cases (security boundaries)", () => {
  it("returns null when the magic header is missing (un-personalized image)", () => {
    const fakeIso = new Uint8Array(2048);
    expect(parseTrailer(fakeIso)).toBeNull();
  });

  it("returns null when the trailer was truncated", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const truncated = t.bytes.subarray(0, t.bytes.length - 100);
    expect(parseTrailer(truncated)).toBeNull();
  });

  it("returns null when total-size points past the image (corrupted footer)", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const corrupted = new Uint8Array(t.bytes);
    new DataView(corrupted.buffer).setUint32(corrupted.length - 4, 0xffff_ffff, true);
    expect(parseTrailer(corrupted)).toBeNull();
  });

  it("returns null when total-size is implausibly small", () => {
    const corrupted = new Uint8Array(32);
    new DataView(corrupted.buffer).setUint32(corrupted.length - 4, 8, true);
    expect(parseTrailer(corrupted)).toBeNull();
  });

  it("flags signatureValid=false when the signature was tampered with", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const tampered = new Uint8Array(t.bytes);
    const sigEnd = t.bytes.length - 4 - MAGIC_FOOTER.length;
    tampered[sigEnd - 1] ^= 0x01;
    const parsed = parseTrailer(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(false);
  });

  it("flags signatureValid=false when the JSON was tampered with after signing", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    const decoded = new TextDecoder().decode(t.bytes);
    const start = decoded.indexOf("home.harry.flagship.services");
    expect(start).toBeGreaterThan(0);
    const tampered = new Uint8Array(t.bytes);
    tampered[start] = 0x65;
    const parsed = parseTrailer(tampered);
    if (parsed) {
      expect(parsed.signatureValid).toBe(false);
    }
  });

  it("rejects a blob signed by a different IRK than the embedded userPubKey", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, malloryIrk);
    const parsed = parseTrailer(t.bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.signatureValid).toBe(false);
  });
});

describe("trailer size budget", () => {
  it("produces a trailer well under 4 KiB for a realistic blob", () => {
    const blob = buildBlob();
    const t = buildTrailer(blob, harryIrk);
    expect(t.size).toBeLessThan(4096);
    expect(t.size).toBeGreaterThan(FIXED_OVERHEAD);
  });

  it("refuses to build trailers larger than MAX_TRAILER_BYTES", () => {
    const blob = buildBlob({ serverName: "x".repeat(MAX_TRAILER_BYTES) });
    expect(() => buildTrailer(blob, harryIrk)).toThrow(/trailer too large/);
  });
});
