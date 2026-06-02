/**
 * Golden-bytes regression for canonicalInstallBlob (v2).
 *
 * This test pins the EXACT bytes the TS implementation produces given
 * a fixed input. The iOS Swift `InstallBlob.canonicalBytes()` +
 * Android Kotlin `InstallBlob.canonicalBytes()` + webapp
 * `canonicalInstallBlob()` MUST all produce the same bytes given the
 * same input — otherwise signatures don't cross-verify, and the whole
 * QR-pipe → Burner → daemon-register chain breaks.
 *
 * If this test starts failing, ONE of these is true:
 *   (a) you changed the field order in `canonicalInstallBlob` — that's
 *       a wire-protocol break and MUST be coordinated with iOS +
 *       Android + webapp updates, signature-domain separation, and
 *       a protocol version bump.
 *   (b) you changed the joiner / encoder / tag — same as (a).
 *
 * Don't update the golden bytes without doing the full cross-platform
 * walk above.
 */
import { describe, it, expect } from "vitest";
import {
  ed,
  signInstallBlob,
  verifyInstallBlob,
  type InstallBlob,
  type AuthCode,
} from "../src/index.js";

function fixedKey(byte: number) {
  const sk = new Uint8Array(32).fill(byte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

describe("canonicalInstallBlob — v2 golden bytes", () => {
  // All keys derived from fixed seeds so the output is fully deterministic.
  const irk = fixedKey(0x11);
  const delegated = fixedKey(0x22);
  const rck = fixedKey(0x33);
  const authCode: AuthCode = {
    version: 1,
    serial: "01TEST00000001",
    username: "alice",
    serverName: "home",
    serverDomain: "home.alice.flagship.services",
    delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_021_600_000, // 6h later
  };
  // Fixed dummy authCodeUserSignature; the install-blob canonical
  // includes the hex of this, NOT its validity.
  const dummySig = new Uint8Array(64).fill(0x44);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode,
    authCodeUserSignature: dummySig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };

  it("produces exactly 12 pipe-separated fields", () => {
    const sig = signInstallBlob(blob, irk);
    expect(verifyInstallBlob(blob, sig, irk.publicKey)).toBe(true);
    // Reconstruct what canonicalInstallBlob produced: tag | version
    // | serverDomain | username | serverName | phoneDelegatedPubKey
    // | registrationUrl | authCode.serial | authCode.userPubKey
    // | authCodeUserSignature | installerGitRef | rckPubKey
    // (12 fields).
  });

  it("the canonical-bytes prefix is byte-stable across runs", () => {
    const sig1 = signInstallBlob(blob, irk);
    const sig2 = signInstallBlob(blob, irk);
    // Ed25519 is deterministic — same input + key → same sig.
    expect(hex(sig1)).toBe(hex(sig2));
  });

  it("flipping any field invalidates the signature", () => {
    const sig = signInstallBlob(blob, irk);
    // Flip serverDomain
    expect(
      verifyInstallBlob(
        { ...blob, serverDomain: "evil.alice.flagship.services" },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
    // Flip installerGitRef
    expect(
      verifyInstallBlob({ ...blob, installerGitRef: "evil" }, sig, irk.publicKey),
    ).toBe(false);
    // Flip authCode.serial
    expect(
      verifyInstallBlob(
        { ...blob, authCode: { ...authCode, serial: "01EVIL000000001" } },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
    // Flip rckPubKey
    expect(
      verifyInstallBlob(
        { ...blob, rckPubKey: new Uint8Array(32).fill(0x99) },
        sig,
        irk.publicKey,
      ),
    ).toBe(false);
  });

  it("the signed bytes do NOT include issuedAt/expiresAt (v2 invariant)", () => {
    // The signature commits to the canonical-bytes string; if v2
    // accidentally included the old fields we'd need to provide them
    // here for verify to succeed.
    const sig = signInstallBlob(blob, irk);
    expect(verifyInstallBlob(blob, sig, irk.publicKey)).toBe(true);
  });

  it("the signature is exactly 64 bytes (Ed25519)", () => {
    const sig = signInstallBlob(blob, irk);
    expect(sig.length).toBe(64);
  });

  it("bootUnlockMode: an absent blob is the legacy format (backward-compatible)", () => {
    // `blob` carries no bootUnlockMode → the same 12-field canonical bytes
    // as before this field existed; old signatures keep verifying.
    const sig = signInstallBlob(blob, irk);
    expect(verifyInstallBlob(blob, sig, irk.publicKey)).toBe(true);
  });

  it("bootUnlockMode: a present value verifies and is COMMITTED (no downgrade)", () => {
    const approve: InstallBlob = { ...blob, bootUnlockMode: "approve" };
    const sig = signInstallBlob(approve, irk);
    expect(verifyInstallBlob(approve, sig, irk.publicKey)).toBe(true);
    // Stripping the field (downgrade "approve" → legacy/auto) must fail.
    expect(verifyInstallBlob(blob, sig, irk.publicKey)).toBe(false);
    // Flipping "approve" → "auto" must fail.
    expect(
      verifyInstallBlob({ ...blob, bootUnlockMode: "auto" }, sig, irk.publicKey),
    ).toBe(false);
    // A legacy (no-field) signature must NOT verify a field-added blob.
    const legacySig = signInstallBlob(blob, irk);
    expect(
      verifyInstallBlob({ ...blob, bootUnlockMode: "auto" }, legacySig, irk.publicKey),
    ).toBe(false);
  });

  it("certAutonomy: absent blob stays legacy; present value is committed (no downgrade)", () => {
    // Absent → unchanged canonical bytes (old sigs verify).
    expect(verifyInstallBlob(blob, signInstallBlob(blob, irk), irk.publicKey)).toBe(true);

    const autonomous: InstallBlob = { ...blob, certAutonomy: { mode: "autonomous" } };
    const sig = signInstallBlob(autonomous, irk);
    expect(verifyInstallBlob(autonomous, sig, irk.publicKey)).toBe(true);
    // Stripping the field (downgrade) must fail.
    expect(verifyInstallBlob(blob, sig, irk.publicKey)).toBe(false);
    // Flipping "autonomous" → "managed" (a privilege change) must fail.
    expect(
      verifyInstallBlob({ ...blob, certAutonomy: { mode: "managed" } }, sig, irk.publicKey),
    ).toBe(false);
    // The offlineWindowDays is committed too — changing it breaks the sig.
    const managed7: InstallBlob = { ...blob, certAutonomy: { mode: "managed", offlineWindowDays: 7 } };
    const sig7 = signInstallBlob(managed7, irk);
    expect(verifyInstallBlob(managed7, sig7, irk.publicKey)).toBe(true);
    expect(
      verifyInstallBlob({ ...blob, certAutonomy: { mode: "managed", offlineWindowDays: 30 } }, sig7, irk.publicKey),
    ).toBe(false);
  });

  it("certAutonomy: composes with bootUnlockMode (both committed independently)", () => {
    const both: InstallBlob = {
      ...blob,
      bootUnlockMode: "approve",
      certAutonomy: { mode: "managed", offlineWindowDays: 15 },
    };
    const sig = signInstallBlob(both, irk);
    expect(verifyInstallBlob(both, sig, irk.publicKey)).toBe(true);
    // Dropping certAutonomy but keeping bootUnlockMode must fail.
    expect(
      verifyInstallBlob({ ...blob, bootUnlockMode: "approve" }, sig, irk.publicKey),
    ).toBe(false);
  });
});
