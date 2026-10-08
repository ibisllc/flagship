import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  verifyInstallBlob,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { deriveIRK } from "@flagship/protocol";
import { ed } from "@flagship/protocol";
import {
  buildTrailer,
  parseTrailer,
  installBlobToJson,
  installBlobFromJson,
  MAGIC_HEADER,
  MAGIC_FOOTER,
  FIXED_OVERHEAD,
  MAX_TRAILER_BYTES,
} from "../src/trailer.js";
import { personalizeBytes } from "../src/personalize.js";
// The Debian-path recipe serializer + parser are the reference for the JSON
// shape of every signed field; the trailer must not drift from them.
import { installBlobToJson as debianRecipeJson } from "../../flagship-builder/src/userdata.js";
import { parseInstallBlob as debianParseRecipe } from "../../flagship-builder/src/installBlobParse.js";

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
    version: 2,
    serverDomain: code.serverDomain,
    username: code.username,
    serverName: code.serverName,
    phoneDelegatedPubKey: delegated,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: userSig,
    installerGitRef: "main",
    rckPubKey: freshKeypair().publicKey,
    ...overrides,
  };
}

describe("installBlobToJson/FromJson preserves signed optional fields", () => {
  it("round-trips bootUnlockMode so the signature still verifies", () => {
    const blob = buildBlob({ bootUnlockMode: "approve" });
    const sig = signInstallBlob(blob, harryIrk);
    // The phone-signed blob → recipe JSON → back to a blob (what the box does).
    const restored = installBlobFromJson(installBlobToJson(blob));
    expect(restored.bootUnlockMode).toBe("approve");
    // The restored blob's canonical bytes MUST match — verify must still pass.
    expect(verifyInstallBlob(restored, sig, harryIrk.publicKey)).toBe(true);
  });

  it("a blob with no optional fields round-trips unchanged", () => {
    const blob = buildBlob();
    const restored = installBlobFromJson(installBlobToJson(blob));
    expect(restored.bootUnlockMode).toBeUndefined();
    expect(verifyInstallBlob(restored, signInstallBlob(blob, harryIrk), harryIrk.publicKey)).toBe(true);
  });
});

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

/** A blob carrying every optional signed field a current recipe can carry. */
function fullyPopulatedBlob(): InstallBlob {
  const base = buildBlob();
  const authCode: AuthCode = { ...base.authCode, adminRootPubKey: freshKeypair().publicKey.map((x) => x ^ 0x5a) };
  return {
    ...base,
    authCode,
    authCodeUserSignature: signAuthCode(authCode, harryIrk),
    bootUnlockMode: "approve",
    diskEncryption: "none",
  };
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function tamperJson(image: Uint8Array, edit: (j: Record<string, any>) => void): Uint8Array {
  const parsed = parseTrailer(image)!;
  const json = installBlobToJson(parsed.blob) as unknown as Record<string, any>;
  edit(json);
  const body = new TextEncoder().encode(JSON.stringify(json));
  const total = FIXED_OVERHEAD + body.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  out.set(MAGIC_HEADER, off); off += MAGIC_HEADER.length;
  out[off++] = 0x01;
  dv.setUint32(off, body.length, true); off += 4;
  out.set(body, off); off += body.length;
  out.set(parsed.signature, off); off += 64;
  out.set(MAGIC_FOOTER, off); off += MAGIC_FOOTER.length;
  dv.setUint32(off, total, true);
  return out;
}

describe("trailer carries every signed recipe field (2026-10-08 Alpine gap)", () => {
  it("a fully-populated blob survives build → parse with both signatures intact", () => {
    const blob = fullyPopulatedBlob();
    const parsed = parseTrailer(buildTrailer(blob, harryIrk).bytes)!;
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.blob.diskEncryption).toBe("none");
    expect(parsed.blob.bootUnlockMode).toBe("approve");
    expect(parsed.blob.authCode.adminRootPubKey).toEqual(blob.authCode.adminRootPubKey);
    // `.com` registration verifies the authCode on its own; the admin root is
    // covered only there, so it must survive the trailer too.
    expect(
      verifyAuthCode(parsed.blob.authCode, parsed.blob.authCodeUserSignature, harryIrk.publicKey),
    ).toBe(true);
  });

  it("stripping diskEncryption from the trailer JSON fails the blob signature", () => {
    const image = tamperJson(buildTrailer(fullyPopulatedBlob(), harryIrk).bytes, (j) => {
      delete j.diskEncryption;
    });
    expect(parseTrailer(image)!.signatureValid).toBe(false);
  });

  it("stripping adminRootPubKey leaves an authCode .com would reject", () => {
    const image = tamperJson(buildTrailer(fullyPopulatedBlob(), harryIrk).bytes, (j) => {
      delete j.authCode.adminRootPubKey;
    });
    const parsed = parseTrailer(image)!;
    expect(
      verifyAuthCode(parsed.blob.authCode, parsed.blob.authCodeUserSignature, harryIrk.publicKey),
    ).toBe(false);
  });

  it("rejects a malformed adminRootPubKey or diskEncryption instead of zero-filling it", () => {
    const good = buildTrailer(fullyPopulatedBlob(), harryIrk).bytes;
    expect(parseTrailer(tamperJson(good, (j) => { j.authCode.adminRootPubKey = "zz".repeat(32); }))).toBeNull();
    expect(parseTrailer(tamperJson(good, (j) => { j.authCode.adminRootPubKey = "ab".repeat(31); }))).toBeNull();
    expect(parseTrailer(tamperJson(good, (j) => { j.diskEncryption = "plaintext"; }))).toBeNull();
  });

  it("trailers without the new fields are byte-identical to before", () => {
    // Pinned from the pre-change serializer; a trailer that never carried the
    // fields must not change a single byte.
    const minimal = buildTrailer(buildBlob(), harryIrk);
    expect(minimal.size).toBe(973);
    expect(sha256Hex(minimal.bytes)).toBe("30966be6a85535fa8a382d111bf5a66e3eaff2c0a4942f98a817c7d6bd78d88c");
    const withMode = buildTrailer(buildBlob({ bootUnlockMode: "approve" }), harryIrk);
    expect(sha256Hex(withMode.bytes)).toBe("62fbfc28c76130a4374a41fb8b71475b9597bafe93fb786f7e5147686477e2cb");
  });

  it("matches the Debian-path recipe JSON field-for-field", () => {
    const blob = fullyPopulatedBlob();
    const sig = signInstallBlob(blob, harryIrk);
    const trailer = installBlobToJson(blob) as unknown as Record<string, unknown>;
    const debian = debianRecipeJson(blob, "00".repeat(64));
    expect(trailer.authCode).toEqual(debian.authCode);
    for (const k of Object.keys(trailer)) {
      if (k in debian) expect(trailer[k], k).toEqual(debian[k]);
    }
    // The reference parser reads the trailer's JSON into the same signed blob.
    const viaReference = debianParseRecipe(trailer)!;
    expect(viaReference.diskEncryption).toBe("none");
    expect(viaReference.bootUnlockMode).toBe("approve");
    expect(verifyInstallBlob(viaReference, sig, harryIrk.publicKey)).toBe(true);
    expect(
      verifyAuthCode(viaReference.authCode, viaReference.authCodeUserSignature, harryIrk.publicKey),
    ).toBe(true);
  });
});
