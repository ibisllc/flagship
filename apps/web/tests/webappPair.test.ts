import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveIRK,
  signRebuildRequest,
  verifyRebuildRequest,
  type ImageRebuildRequest,
} from "@flagship/protocol";

async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href);
}

async function loadQrScanner() {
  const path = resolve(__dirname, "..", "public", "webapp", "qrScanner.js");
  return import(pathToFileURL(path).href);
}

describe("webapp QR scanner — payload parsing", () => {
  it("parses the canonical flagship://desktop/<sid>/<pubkey> form", async () => {
    const q = await loadQrScanner();
    const out = q.parseQrPayload("flagship://desktop/abcdef0123456789/" + "ab".repeat(32));
    expect(out.sessionId).toBe("abcdef0123456789");
    expect(out.desktopPubKeyHex).toBe("ab".repeat(32));
  });

  it("normalizes case and strips surrounding whitespace", async () => {
    const q = await loadQrScanner();
    const out = q.parseQrPayload("  FLAGSHIP://DESKTOP/AABBCCDD11223344/" + "CD".repeat(32) + " ");
    expect(out.sessionId).toBe("aabbccdd11223344");
    expect(out.desktopPubKeyHex).toBe("cd".repeat(32));
  });

  it("rejects malformed payloads", async () => {
    const q = await loadQrScanner();
    expect(() => q.parseQrPayload("https://elsewhere/")).toThrow();
    expect(() => q.parseQrPayload("flagship://desktop/short/abc")).toThrow();
    expect(() => q.parseQrPayload("flagship://other/aaaa1111aaaa1111/" + "00".repeat(32))).toThrow();
  });
});

describe("webapp pair flow — canonical-bytes interop with the server", () => {
  it("the webapp's canonicalPairingClaim produces a signature the server's verifyRebuildRequest accepts", async () => {
    // Reproduce the exact canonical-bytes shape the webapp uses (mirrors the
    // helper inside app.js — it's not exported, so we re-derive here).
    const seed = new Uint8Array(32).fill(0x42);
    const k = await loadKeystore();
    const sessionId = "0123456789abcdef";
    const desktopPubKeyHex = "ab".repeat(32);
    const phonePub = new Uint8Array(32).fill(0x77);
    const issuedAt = 1735689600000;
    const username = "harry";

    const canonical = new TextEncoder().encode(
      [
        "flagship/rebuild/v1",
        username,
        `desktop-pair:${sessionId}`,
        desktopPubKeyHex,
        k.bytesToHex(phonePub),
        0,
        issuedAt,
      ].join("|"),
    );

    const sig = await k.signWithIrk(seed, canonical);
    expect(sig.length).toBe(64);

    // The server-side verifier reads the matching ImageRebuildRequest type.
    const claim: ImageRebuildRequest = {
      userId: username,
      newServerId: `desktop-pair:${sessionId}`,
      wifiSsid: desktopPubKeyHex,
      wifiPskHash: phonePub,
      shareRatio: 0,
      issuedAt,
    };
    const expectedIrkPub = deriveIRK({ seed }).publicKey;
    expect(verifyRebuildRequest(claim, sig, expectedIrkPub)).toBe(true);

    // And the @noble-signed sig also verifies (cross-validation).
    const nobleSig = signRebuildRequest(claim, deriveIRK({ seed }));
    expect(verifyRebuildRequest(claim, nobleSig, expectedIrkPub)).toBe(true);
  });
});
