import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootRotation,
  verifyAdminRootRotation,
  type AdminRootRotation,
  type Keypair,
} from "../src/index.js";

function seedKeypair(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

const oldRoot = seedKeypair(0x11);
const newRoot = seedKeypair(0x22);
const attacker = seedKeypair(0x33);

function rotation(overrides: Partial<AdminRootRotation> = {}): AdminRootRotation {
  return {
    username: "harry",
    oldAdminRootPub: oldRoot.publicKey,
    newAdminRootPub: newRoot.publicKey,
    issuedAt: 1_735_689_600_000,
    ...overrides,
  };
}

describe("AdminRootRotation (Slice D §5)", () => {
  it("verifies a proof signed by the OLD admin master root", () => {
    const r = rotation();
    const sig = signAdminRootRotation(r, oldRoot);
    expect(verifyAdminRootRotation(r, sig, oldRoot.publicKey)).toBe(true);
  });

  it("rejects a proof verified against the NEW root (must be the pinned old root)", () => {
    const r = rotation();
    const sig = signAdminRootRotation(r, oldRoot);
    expect(verifyAdminRootRotation(r, sig, newRoot.publicKey)).toBe(false);
  });

  it("rejects a proof signed by an unrelated key (a rogue `.com` cannot forge)", () => {
    const r = rotation();
    const sig = signAdminRootRotation(r, attacker);
    expect(verifyAdminRootRotation(r, sig, oldRoot.publicKey)).toBe(false);
  });

  it("rejects a tampered newAdminRootPub (the field is signature-covered)", () => {
    const r = rotation();
    const sig = signAdminRootRotation(r, oldRoot);
    const tampered = rotation({ newAdminRootPub: attacker.publicKey });
    expect(verifyAdminRootRotation(tampered, sig, oldRoot.publicKey)).toBe(false);
  });

  it("rejects a tampered username", () => {
    const r = rotation();
    const sig = signAdminRootRotation(r, oldRoot);
    expect(
      verifyAdminRootRotation(rotation({ username: "mallory" }), sig, oldRoot.publicKey),
    ).toBe(false);
  });

  it("throws on a '|' in the username at sign time (field-guarded canonical bytes)", () => {
    expect(() => signAdminRootRotation(rotation({ username: "a|b" }), oldRoot)).toThrow();
  });
});
