/**
 * Slice D §9.8 — transfer-a-box admin-root handoff proof.
 *
 * The GIVER's admin master root (the box's pinned anchor) signs
 * `flagship/admin-root-transfer/v1` binding (this box, this offer's nonce,
 * old giver root → new acquirer root). The box re-pins ONLY on this proof —
 * `.com` relays it but cannot forge it. These tests pin the canonical bytes,
 * round-trip sign/verify, every tamper axis, the "" (unpin) new root, and —
 * load-bearing — that the tag is DISTINCT from admin-root-rotation so a
 * transfer proof can never replay as an account rotation of the giver.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootRotation,
  signAdminRootTransfer,
  verifyAdminRootRotation,
  verifyAdminRootTransfer,
  type AdminRootRotation,
  type AdminRootTransfer,
  type Keypair,
} from "../src/index.js";

function makeKey(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const giverRoot = makeKey(0x21);
const acquirerRoot = makeKey(0x42);
const NONCE = "ab".repeat(32);

function baseTransfer(): AdminRootTransfer {
  return {
    serverDomain: "home.alice.flagship.services",
    giverUsername: "alice",
    acquirerUsername: "bob",
    oldAdminRootPubHex: hex(giverRoot.publicKey),
    newAdminRootPubHex: hex(acquirerRoot.publicKey),
    transferNonce: NONCE,
    issuedAt: 1800,
  };
}

describe("admin-root-transfer envelope (Slice D §9.8)", () => {
  it("canonical bytes match the pinned string; strings lowercased", () => {
    const t: AdminRootTransfer = {
      ...baseTransfer(),
      serverDomain: "HOME.alice.flagship.services",
      giverUsername: "ALICE",
      acquirerUsername: "BoB",
      oldAdminRootPubHex: hex(giverRoot.publicKey).toUpperCase(),
      transferNonce: NONCE.toUpperCase(),
    };
    const sig = signAdminRootTransfer(t, giverRoot);
    const expected = new TextEncoder().encode(
      `flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|${hex(giverRoot.publicKey)}|${hex(acquirerRoot.publicKey)}|${NONCE}|1800`,
    );
    expect(ed.verify(sig, expected, giverRoot.publicKey)).toBe(true);
  });

  it("sign/verify round-trips under the giver root", () => {
    const t = baseTransfer();
    const sig = signAdminRootTransfer(t, giverRoot);
    expect(verifyAdminRootTransfer(t, sig, giverRoot.publicKey)).toBe(true);
  });

  it('"" new root (unpin — acquirer has no admin root) round-trips + pins the empty field', () => {
    const t: AdminRootTransfer = { ...baseTransfer(), newAdminRootPubHex: "" };
    const sig = signAdminRootTransfer(t, giverRoot);
    expect(verifyAdminRootTransfer(t, sig, giverRoot.publicKey)).toBe(true);
    const expected = new TextEncoder().encode(
      `flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|${hex(giverRoot.publicKey)}||${NONCE}|1800`,
    );
    expect(ed.verify(sig, expected, giverRoot.publicKey)).toBe(true);
  });

  it("every tampered field fails verification", () => {
    const t = baseTransfer();
    const sig = signAdminRootTransfer(t, giverRoot);
    const tampers: Partial<AdminRootTransfer>[] = [
      { serverDomain: "blog.alice.flagship.services" }, // re-aimed at a different box
      { giverUsername: "mallory" },
      { acquirerUsername: "mallory" },
      { oldAdminRootPubHex: "3c".repeat(32) },
      { newAdminRootPubHex: "4d".repeat(32) }, // swap the target anchor
      { newAdminRootPubHex: "" }, // downgrade repin → unpin
      { transferNonce: "cd".repeat(32) }, // re-bind to a different offer
      { issuedAt: 1801 },
    ];
    for (const patch of tampers) {
      expect(verifyAdminRootTransfer({ ...t, ...patch }, sig, giverRoot.publicKey)).toBe(false);
    }
  });

  it("does not verify under a key other than the giver root", () => {
    const t = baseTransfer();
    const sig = signAdminRootTransfer(t, giverRoot);
    expect(verifyAdminRootTransfer(t, sig, acquirerRoot.publicKey)).toBe(false);
  });

  it("CROSS-TAG: a transfer proof never verifies as an account rotation (and vice versa)", () => {
    // Same key material both ways — only the tag + field layout differ. If
    // these tags were shared, a captured transfer proof could rotate the
    // giver's WHOLE account to the acquirer's root.
    const t = baseTransfer();
    const transferSig = signAdminRootTransfer(t, giverRoot);
    const rotation: AdminRootRotation = {
      username: "alice",
      oldAdminRootPub: giverRoot.publicKey,
      newAdminRootPub: acquirerRoot.publicKey,
      issuedAt: 1800,
    };
    expect(verifyAdminRootRotation(rotation, transferSig, giverRoot.publicKey)).toBe(false);
    const rotationSig = signAdminRootRotation(rotation, giverRoot);
    expect(verifyAdminRootTransfer(t, rotationSig, giverRoot.publicKey)).toBe(false);
  });

  it("rejects a '|' injection in any string field", () => {
    const t = baseTransfer();
    expect(() =>
      signAdminRootTransfer({ ...t, acquirerUsername: "bob|evil" }, giverRoot),
    ).toThrow(/separator/);
  });
});
