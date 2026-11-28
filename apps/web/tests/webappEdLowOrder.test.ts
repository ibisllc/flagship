// Low-order and non-canonical Ed25519 keys (test-vectors/ed25519-low-order) are refused by every webapp verify
// path before the signature is checked: the one helper (public/webapp/lib/edKey.js) and the call sites built on it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAcceptableEd25519PublicKey, verifyEd25519, verifyEd25519Sync } from "../public/webapp/lib/edKey.js";
import { verifyWithEd25519Pub } from "../public/webapp/keystore.js";
import { ed25519VerifyHex } from "../public/webapp/lib/voiciCore.js";
import { edVerify } from "../public/webapp/lib/maintainerTrust.js";
import { verifyRescueSignature } from "../public/webapp/lib/rescue.js";
import { isAcceptableEd25519Key } from "../public/webapp/lib/accountKeyRotation.js";
import { isAcceptableEd25519PublicKey as extensionAccepts, verifyDaemonStatus } from "../../browser-extension-firefox/src/lib/daemonStatus.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/ed25519-low-order/vectors.json"), "utf8")) as {
  forgedSignatureHex: string;
  messagesHex: string[];
  rejectPublicKeysHex: string[];
  honest: { publicKeyHex: string; signatures: { messageHex: string; signatureHex: string }[] };
};
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("web ed25519-low-order", () => {
  it("refuses every vector key and accepts the honest one", () => {
    for (const k of v.rejectPublicKeysHex) {
      expect(isAcceptableEd25519PublicKey(k), k).toBe(false);
      expect(isAcceptableEd25519PublicKey(b(k)), k).toBe(false);
      expect(isAcceptableEd25519Key(k), k).toBe(false);
      expect(extensionAccepts(k), k).toBe(false);
    }
    expect(isAcceptableEd25519PublicKey(v.honest.publicKeyHex)).toBe(true);
    expect(isAcceptableEd25519Key(v.honest.publicKeyHex)).toBe(true);
    expect(extensionAccepts(v.honest.publicKeyHex)).toBe(true);
  });

  it("no verify path accepts the forged signature under any vector key", async () => {
    const sig = v.forgedSignatureHex;
    for (const k of v.rejectPublicKeysHex) {
      for (const m of v.messagesHex) {
        const msg = b(m);
        expect(await verifyEd25519(b(k), b(sig), msg), k).toBe(false);
        expect(verifyEd25519Sync(b(k), b(sig), msg), k).toBe(false);
        expect(verifyEd25519Sync(k, sig, msg, { zip215: false }), k).toBe(false);
        expect(await verifyWithEd25519Pub(b(k), b(sig), msg), k).toBe(false);
        expect(ed25519VerifyHex(sig, msg, k), k).toBe(false);
        expect(await edVerify(sig, msg, k), k).toBe(false);
        expect(verifyRescueSignature(msg, b(sig), b(k)), k).toBe(false);
      }
    }
  });

  it("the honest key still verifies its signatures on every path", async () => {
    const k = v.honest.publicKeyHex;
    for (const s of v.honest.signatures) {
      const msg = b(s.messageHex);
      expect(await verifyEd25519(b(k), b(s.signatureHex), msg)).toBe(true);
      expect(verifyEd25519Sync(k, s.signatureHex, msg)).toBe(true);
      expect(verifyEd25519Sync(k, s.signatureHex, msg, { zip215: false })).toBe(true);
      expect(await verifyWithEd25519Pub(b(k), b(s.signatureHex), msg)).toBe(true);
      expect(ed25519VerifyHex(s.signatureHex, msg, k)).toBe(true);
      expect(await edVerify(s.signatureHex, msg, k)).toBe(true);
      expect(verifyRescueSignature(msg, b(s.signatureHex), b(k))).toBe(true);
    }
  });

  it("the Firefox extension refuses a daemon-status report under a vector key", async () => {
    const report = { serverDomain: "home.alice.flagship.services", certSha256: null, certValidUntil: null, certIssuer: null, appsServed: [], nonce: "n", issuedAt: 1 };
    for (const k of v.rejectPublicKeysHex) expect(await verifyDaemonStatus(report, v.forgedSignatureHex, k), k).toBe(false);
  });
});
