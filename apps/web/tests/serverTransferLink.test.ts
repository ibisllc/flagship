import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
// The browser-shipping module — importing the SAME file we serve to clients
// guards the exact bytes the webapp produces/parses.
import {
  buildTransferLink,
  buildTransferDeepLink,
  encodeTransferOffer,
  utf8ToBase64Url,
  base64UrlToUtf8,
  parseTransferLink,
  transferLinkFromLocation,
  verifyTransferOffer,
  canonicalOfferBytes,
} from "../public/webapp/lib/serverTransfer.js";

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A noble-backed verifier matching the (pub, sig, bytes) signature
// verifyTransferOffer expects.
async function nobleVerify(pub: Uint8Array, sig: Uint8Array, bytes: Uint8Array) {
  try {
    return ed25519.verify(sig, bytes, pub);
  } catch {
    return false;
  }
}

const DOMAIN = "kitchen.alice.flagship.services";
const NONCE = "a".repeat(64);
const ISSUED = 1_800_000_000_000;
const EXPIRES = ISSUED + 15 * 60_000;

function makeSignedOffer(overrides: Record<string, unknown> = {}) {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const offer = {
    serverDomain: DOMAIN,
    transferNonce: NONCE,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
  };
  const sig = ed25519.sign(canonicalOfferBytes(offer), priv);
  const qr = {
    v: 1,
    kind: "flagship-transfer-offer",
    serverDomain: DOMAIN,
    transferNonce: NONCE,
    giverIrkPub: toHex(pub),
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    offerSignature: toHex(sig),
    ...overrides,
  };
  return { qr, priv, pub };
}

describe("serverTransfer — universal-link encode/decode", () => {
  it("base64url round-trips UTF-8 with NO padding + -_ alphabet", () => {
    const s = JSON.stringify({ a: 1, b: "ünïcodé/+=" });
    const enc = utf8ToBase64Url(s);
    expect(enc).not.toMatch(/[+/=]/); // url-safe, unpadded
    expect(base64UrlToUtf8(enc)).toBe(s);
  });

  it("builds the https universal link with the offer in the o= QUERY (not a #fragment)", () => {
    const { qr } = makeSignedOffer();
    const link = buildTransferLink(qr);
    expect(link).toMatch(/^https:\/\/flagshipserver\.com\/transfer\?o=/);
    expect(link).not.toContain("#");
    const u = new URL(link);
    expect(u.pathname).toBe("/transfer");
    expect(u.searchParams.get("o")).toBe(encodeTransferOffer(qr));
  });

  it("builds the flagship:// custom-scheme twin", () => {
    const { qr } = makeSignedOffer();
    expect(buildTransferDeepLink(qr)).toBe(`flagship://transfer?o=${encodeTransferOffer(qr)}`);
  });

  it("parses the https link, the flagship:// twin, and a bare o= query back to the offer", () => {
    const { qr } = makeSignedOffer();
    const https = buildTransferLink(qr);
    const scheme = buildTransferDeepLink(qr);
    for (const raw of [https, scheme, `o=${encodeTransferOffer(qr)}`]) {
      const parsed = parseTransferLink(raw);
      expect(parsed).toBeTruthy();
      expect(parsed!.serverDomain).toBe(DOMAIN);
      expect(parsed!.giverIrkPub).toBe(qr.giverIrkPub);
      expect(parsed!.offerSignature).toBe(qr.offerSignature);
    }
  });

  it("returns null for a non-/transfer path or a malformed payload (falls through)", () => {
    const { qr } = makeSignedOffer();
    expect(parseTransferLink(`https://flagshipserver.com/join?o=${encodeTransferOffer(qr)}`)).toBeNull();
    expect(parseTransferLink("flagship://join?o=abc")).toBeNull();
    expect(parseTransferLink("https://flagshipserver.com/transfer?o=%%%notb64%%%")).toBeNull();
    expect(parseTransferLink("")).toBeNull();
  });

  it("transferLinkFromLocation reads a /transfer?o= window.location shape", () => {
    const { qr } = makeSignedOffer();
    const o = encodeTransferOffer(qr);
    expect(transferLinkFromLocation({ pathname: "/transfer", search: `?o=${o}` })).toBeTruthy();
    expect(transferLinkFromLocation({ pathname: "/home", search: `?o=${o}` })).toBeNull();
    expect(transferLinkFromLocation({ pathname: "/transfer", search: "" })).toBeNull();
  });
});

describe("serverTransfer — verifyTransferOffer (Slice C security gate)", () => {
  it("accepts a well-signed, unexpired offer", async () => {
    const { qr } = makeSignedOffer();
    const parsed = parseTransferLink(buildTransferLink(qr))!;
    const verdict = await verifyTransferOffer(parsed, { verify: nobleVerify, now: () => ISSUED + 1 });
    expect(verdict.ok).toBe(true);
  });

  it("verifies with the browser default (WebCrypto) verifier too", async () => {
    const { qr } = makeSignedOffer();
    const parsed = parseTransferLink(buildTransferLink(qr))!;
    const verdict = await verifyTransferOffer(parsed, { now: () => ISSUED + 1 });
    expect(verdict.ok).toBe(true);
  });

  it("REJECTS an expired offer without checking the signature", async () => {
    const { qr } = makeSignedOffer();
    const parsed = parseTransferLink(buildTransferLink(qr))!;
    const verdict = await verifyTransferOffer(parsed, { verify: nobleVerify, now: () => EXPIRES + 1 });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/expired/i);
  });

  it("REJECTS a tampered signature", async () => {
    const { qr } = makeSignedOffer();
    const parsed = parseTransferLink(buildTransferLink(qr))!;
    // Flip a byte in the signature hex.
    parsed.offerSignature = parsed.offerSignature.replace(/^../, "00");
    const verdict = await verifyTransferOffer(parsed, { verify: nobleVerify, now: () => ISSUED + 1 });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/signature/i);
  });

  it("REJECTS an offer whose giverIrkPub didn't sign it", async () => {
    const { qr } = makeSignedOffer();
    const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    const parsed = parseTransferLink(buildTransferLink({ ...qr, giverIrkPub: toHex(other) }))!;
    const verdict = await verifyTransferOffer(parsed, { verify: nobleVerify, now: () => ISSUED + 1 });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS a malformed offer (missing fields / bad key)", async () => {
    const bad = await verifyTransferOffer({ serverDomain: DOMAIN } as never, { verify: nobleVerify });
    expect(bad.ok).toBe(false);
  });
});
