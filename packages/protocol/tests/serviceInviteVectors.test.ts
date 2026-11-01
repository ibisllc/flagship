import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  createServiceInviteCanonicalBytes,
  revokeServiceInviteCanonicalBytes,
  serviceInviteSecretHash,
  signAcceptServiceInvite,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  verifyAcceptServiceInvite,
  verifyCreateServiceInvite,
  verifyRedeemServiceInvite,
  verifyRevokeServiceInvite,
  type CreateServiceInvite,
} from "../src/serviceInvite.js";

// packages/protocol/test-vectors/service-invite: the bytes every port (Rust, webapp, iOS, Android) must give.
const V = JSON.parse(readFileSync(new URL("../test-vectors/service-invite/vectors.json", import.meta.url), "utf8"));
const b = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (x: Uint8Array): string => Buffer.from(x).toString("hex");
const text = (x: Uint8Array): string => Buffer.from(x).toString("utf8");
const pair = (byte: number) => {
  const privateKey = new Uint8Array(32).fill(byte);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const irk = pair(V.keys.irk.seedByte);
const friend = pair(V.keys.friend.seedByte);
const contact = pair(V.keys.contact.seedByte);

const create = (c: any): CreateServiceInvite => ({
  inviteId: c.inviteId,
  authorAID: b(c.authorAID),
  serviceRef: c.serviceRef,
  secretHash: c.secretHash,
  encryptedBundle: c.encryptedBundle,
  issuedAt: c.issuedAt,
  ...(c.maxRedemptions !== undefined ? { maxRedemptions: c.maxRedemptions } : {}),
  ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
});

describe("service-invite vectors (TypeScript)", () => {
  it("the keys are the seeds the file names", () => {
    expect(hex(irk.publicKey)).toBe(V.keys.irk.pub);
    expect(hex(friend.publicKey)).toBe(V.keys.friend.pub);
    expect(hex(contact.publicKey)).toBe(V.keys.contact.pub);
  });

  it("create: canonical bytes, the IRK's signature, and a verify that fails for another key", () => {
    for (const c of V.create) {
      const m = create(c);
      expect(text(createServiceInviteCanonicalBytes(m)), c.name).toBe(c.canonical);
      expect(hex(signCreateServiceInvite(m, irk)), c.name).toBe(c.signature);
      expect(verifyCreateServiceInvite(m, b(c.signature), irk.publicKey)).toBe(true);
      expect(verifyCreateServiceInvite(m, b(c.signature), friend.publicKey)).toBe(false);
    }
  });

  it("redeem, accept and revoke sign the stated bytes", () => {
    for (const r of V.redeem) {
      const m = { secretHash: r.secretHash, visitorAID: b(r.visitorAID), redeemedAt: r.redeemedAt };
      expect(hex(signRedeemServiceInvite(m, friend))).toBe(r.signature);
      expect(ed.verify(b(r.signature), new TextEncoder().encode(r.canonical), friend.publicKey)).toBe(true);
      expect(verifyRedeemServiceInvite(m, b(r.signature), friend.publicKey)).toBe(true);
    }
    for (const a of V.accept) {
      const m = { inviteId: a.inviteId, serviceRef: a.serviceRef, contactAID: b(a.contactAID), acceptedAt: a.acceptedAt };
      expect(hex(signAcceptServiceInvite(m, contact))).toBe(a.signature);
      expect(ed.verify(b(a.signature), new TextEncoder().encode(a.canonical), contact.publicKey)).toBe(true);
      expect(verifyAcceptServiceInvite(m, b(a.signature), contact.publicKey)).toBe(true);
    }
    for (const r of V.revoke) {
      const m = { inviteId: r.inviteId, issuedAt: r.issuedAt };
      expect(text(revokeServiceInviteCanonicalBytes(m))).toBe(r.canonical);
      expect(hex(signRevokeServiceInvite(m, irk))).toBe(r.signature);
      expect(verifyRevokeServiceInvite(m, b(r.signature), irk.publicKey)).toBe(true);
    }
  });

  it("the secret hash", () => {
    for (const s of V.secretHash) expect(serviceInviteSecretHash(b(s.secretHex))).toBe(s.expect);
  });

  it("refuses every invalid message", () => {
    for (const c of V.invalid) {
      if (c.op === "create") expect(() => createServiceInviteCanonicalBytes(create(c)), c.name).toThrow();
      else expect(() => signRedeemServiceInvite({ secretHash: c.secretHash, visitorAID: b(c.visitorAID), redeemedAt: c.redeemedAt }, friend), c.name).toThrow();
    }
  });
});
