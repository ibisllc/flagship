// Cross-platform recovery-escrow KAT (Issue 1 + Issue 2).
//
// This is the ANTI-DRIFT guard that would have caught the pre-reconciliation
// webapp divergence (raw prf key + `umk||adminRoot` concat) at CI time. It pins
// a fixed (prfSecret, seeds, nonce) → a byte-exact ciphertext for each escrow
// blob, produced by the SHIPPED webapp wrap module
// (apps/web/public/recovery/recoveryWrap.js). The SAME `wrappedB64` blobs are
// decrypted verbatim by:
//   - iOS   apps/mobile/ios/Tests/FlagshipMobileTests/AdminRootTests.swift
//   - Android apps/mobile/android/.../keystore/RecoveryWrapTest.kt
// so a green run here + green mobile suites proves web-enrolled recovery records
// are mobile-unwrappable (and vice-versa).
//
// On the OLD webapp code (raw `prfBytes.slice(0,32)` key, no HKDF) these
// assertions fail: the derived key differs from HKDF(prf, salt), so the pinned
// ciphertext never matches.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const golden = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "recoveryWrapGolden.json"), "utf8"),
);

function loadWrap() {
  const path = resolve(__dirname, "..", "public", "recovery", "recoveryWrap.js");
  return import(pathToFileURL(path).href);
}

const fromHex = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

const prf = fromHex(golden.inputs.prfSecretHex);
const nonce = fromHex(golden.inputs.nonceHex);

describe("recovery-escrow wrap — cross-platform golden KAT", () => {
  it("HKDF salt constants match the mobile domain-separation tags", async () => {
    const wrap = await loadWrap();
    const dec = new TextDecoder();
    expect(dec.decode(wrap.HKDF_UMK_SALT)).toBe(golden.salts.umk);
    expect(dec.decode(wrap.HKDF_ACME_SALT)).toBe(golden.salts.acme);
    expect(dec.decode(wrap.HKDF_ADMIN_ROOT_SALT)).toBe(golden.salts.adminRoot);
  });

  it("UMK blob is byte-identical to the pinned golden ciphertext", async () => {
    const wrap = await loadWrap();
    const seed = fromHex(golden.inputs.umkSeedHex);
    const blob = await wrap.wrapWithPrfNonce(seed, prf, wrap.HKDF_UMK_SALT, nonce);
    expect(blob).toBe(golden.wrappedB64.umk);
    // …and the shipped unwrap round-trips it back to the seed.
    expect(toHex(await wrap.unwrapWithPrf(blob, prf, wrap.HKDF_UMK_SALT)))
      .toBe(golden.inputs.umkSeedHex);
  });

  it("ACME account-key blob is byte-identical to the pinned golden ciphertext", async () => {
    const wrap = await loadWrap();
    const scalar = fromHex(golden.inputs.acmeScalarHex);
    const blob = await wrap.wrapWithPrfNonce(scalar, prf, wrap.HKDF_ACME_SALT, nonce);
    expect(blob).toBe(golden.wrappedB64.acme);
    expect(toHex(await wrap.unwrapWithPrf(blob, prf, wrap.HKDF_ACME_SALT)))
      .toBe(golden.inputs.acmeScalarHex);
  });

  it("admin-root blob is byte-identical to the pinned golden ciphertext", async () => {
    const wrap = await loadWrap();
    const seed = fromHex(golden.inputs.adminRootSeedHex);
    const blob = await wrap.wrapWithPrfNonce(seed, prf, wrap.HKDF_ADMIN_ROOT_SALT, nonce);
    expect(blob).toBe(golden.wrappedB64.adminRoot);
    expect(toHex(await wrap.unwrapWithPrf(blob, prf, wrap.HKDF_ADMIN_ROOT_SALT)))
      .toBe(golden.inputs.adminRootSeedHex);
  });

  it("distinct salts derive INDEPENDENT wrap keys (a UMK blob can't unwrap under the admin salt)", async () => {
    const wrap = await loadWrap();
    await expect(
      wrap.unwrapWithPrf(golden.wrappedB64.umk, prf, wrap.HKDF_ADMIN_ROOT_SALT),
    ).rejects.toThrow();
  });

  it("production wrapWithPrf (random nonce) round-trips and never reuses a nonce", async () => {
    const wrap = await loadWrap();
    const seed = fromHex(golden.inputs.umkSeedHex);
    const a = await wrap.wrapWithPrf(seed, prf, wrap.HKDF_UMK_SALT);
    const b = await wrap.wrapWithPrf(seed, prf, wrap.HKDF_UMK_SALT);
    expect(a).not.toBe(b); // fresh nonce ⇒ distinct blobs for the same input
    expect(toHex(await wrap.unwrapWithPrf(a, prf, wrap.HKDF_UMK_SALT)))
      .toBe(golden.inputs.umkSeedHex);
  });

  it("a web-enrolled UMK blob decrypts under the mobile HKDF+AES-GCM path (parity proof)", async () => {
    // Mobile decrypt, re-implemented from primitives (RFC 5869 HKDF-SHA256 +
    // AES-256-GCM, nonce‖ct‖tag) exactly as Recovery.swift / Recovery.kt do —
    // NOT calling the webapp module — so this asserts genuine cross-impl parity,
    // not module self-consistency.
    const { createHmac, createDecipheriv } = await import("node:crypto");
    const hkdf = (ikm: Buffer, salt: Buffer, len: number) => {
      const prk = createHmac("sha256", salt).update(ikm).digest();
      let t = Buffer.alloc(0);
      let out = Buffer.alloc(0);
      let c = 1;
      while (out.length < len) {
        t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from([c])])).digest();
        out = Buffer.concat([out, t]);
        c++;
      }
      return out.subarray(0, len);
    };
    const blob = Buffer.from(golden.wrappedB64.umk, "base64");
    const iv = blob.subarray(0, 12);
    const ct = blob.subarray(12, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const key = hkdf(Buffer.from(prf), Buffer.from(golden.salts.umk), 32);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    expect(pt.toString("hex")).toBe(golden.inputs.umkSeedHex);
  });
});
